// OpenAI Responses API over fetch + SSE.
// https://developers.openai.com/api/reference/resources/responses/methods/create

import { SegmentLineParser, buildSystemPrompt, buildUserMessage } from "../protocol";
import { ProviderHttpError, ensureOk, readSse } from "./http";
import type { ProviderEvent, ProviderRequest, TranslationProvider } from "./types";

export const OPENAI_BASE_URL = "https://api.openai.com/v1";

/**
 * Lowest reasoning effort each model accepts: translation needs next to no
 * reasoning, and reasoning tokens are billed as output. gpt-6.2-sol/astra
 * reject "none" (per their model pages, 2026-11).
 */
export const REASONING_EFFORT: Record<string, string> = {
  "gpt-6-luna": "none",
  "gpt-6.2-sol": "low",
  "gpt-6.2-astra": "low",
};

interface ResponseObject {
  status?: string;
  model?: string;
  incomplete_details?: { reason?: string } | null;
  error?: { message?: string } | null;
  usage?: {
    input_tokens?: number;
    /** cache_write_tokens: observed in live responses (2026-11), billed at 1.25x input. */
    input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
    output_tokens?: number;
  };
}

interface StreamEvent {
  type?: string;
  delta?: string;
  message?: string;
  response?: ResponseObject;
}

export class OpenAIProvider implements TranslationProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl = OPENAI_BASE_URL,
  ) {}

  async *translate(req: ProviderRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    const res = await fetch(`${this.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        instructions: buildSystemPrompt(req.targetLang),
        input: buildUserMessage(req.texts, req.page),
        reasoning: { effort: REASONING_EFFORT[this.model] ?? "low" },
        max_output_tokens: 16000,
        stream: true,
        // Page text should not be retained server-side for later retrieval.
        store: false,
      }),
      signal,
    });
    await ensureOk("OpenAI", res);
    if (!res.body) throw new ProviderHttpError("OpenAI", 0, "回應沒有內容");

    const parser = new SegmentLineParser(req.texts.length);
    let final: ResponseObject | undefined;
    let refused = false;
    let started = false;

    for await (const { data } of readSse(res.body)) {
      if (data === "[DONE]") break;
      const ev = JSON.parse(data) as StreamEvent;
      if (!started) {
        started = true;
        req.onResponseStart?.();
      }
      switch (ev.type) {
        case "response.output_text.delta":
          for (const seg of parser.push(ev.delta ?? "")) yield { kind: "segment", ...seg };
          break;
        case "response.refusal.delta":
          refused = true;
          break;
        case "response.completed":
        case "response.incomplete":
          final = ev.response;
          break;
        case "response.failed":
          throw new ProviderHttpError("OpenAI", 0, ev.response?.error?.message ?? "response failed");
        case "error":
          throw new ProviderHttpError("OpenAI", 0, ev.message ?? "stream error");
      }
    }
    if (!final) throw new ProviderHttpError("OpenAI", 0, "串流在完成前結束");

    const incompleteReason = final.status === "incomplete" ? final.incomplete_details?.reason : undefined;
    const reason = refused || incompleteReason === "content_filter" ? "refusal" : incompleteReason ? "max_tokens" : "complete";
    for (const seg of parser.end({ truncated: reason !== "complete" })) yield { kind: "segment", ...seg };

    const u = final.usage ?? {};
    const cached = u.input_tokens_details?.cached_tokens ?? 0;
    const written = u.input_tokens_details?.cache_write_tokens ?? 0;
    yield {
      kind: "end",
      reason,
      usage: {
        // input_tokens counts the whole prompt, cache reads and writes included.
        inputTokens: Math.max(0, (u.input_tokens ?? 0) - cached - written),
        // Includes reasoning tokens, which are billed as output.
        outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: cached,
        cacheWriteTokens: written,
      },
      servedModel: final.model,
    };
  }
}
