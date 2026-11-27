// Gemini Interactions API over fetch + SSE (Google's recommended API for new
// projects; generateContent is now labelled legacy).
// https://ai.google.dev/api/interactions-api/create-interaction

import { t } from "../../shared/i18n";
import { SegmentLineParser, buildSystemPrompt, buildUserMessage } from "../protocol";
import { ProviderHttpError, ensureOk, readSse } from "./http";
import type { ProviderEvent, ProviderRequest, TranslationProvider } from "./types";

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
/** Request schema revision the code was written against. */
const API_REVISION = "2026-05-20";

/**
 * Lowest thinking level each model accepts (thinking tokens are billed as
 * output). Gemini 4 models do not support "minimal" (docs/thinking, 2026-11).
 */
export const THINKING_LEVEL: Record<string, string> = {
  "gemini-3.5-flash-lite": "minimal",
  "gemini-4-hydrogen": "low",
  "gemini-4-carbon": "low",
};

interface Interaction {
  status?: string;
  model?: string;
  usage?: {
    total_input_tokens?: number;
    total_cached_tokens?: number;
    total_output_tokens?: number;
    total_thought_tokens?: number;
  };
}

interface StreamEvent {
  event_type?: string;
  interaction?: Interaction;
  delta?: { type?: string; text?: string };
  error?: { message?: string; code?: string };
}

export class GeminiProvider implements TranslationProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl = GEMINI_BASE_URL,
  ) {}

  async *translate(req: ProviderRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    const res = await fetch(`${this.baseUrl}/interactions?alt=sse`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": this.apiKey,
        "api-revision": API_REVISION,
      },
      body: JSON.stringify({
        model: this.model,
        system_instruction: buildSystemPrompt(req.targetLang),
        input: buildUserMessage(req.texts, req.page, req.targetLang),
        generation_config: { thinking_level: THINKING_LEVEL[this.model] ?? "low", max_output_tokens: 16000 },
        stream: true,
        // Page text should not be retained server-side for later retrieval.
        store: false,
      }),
      signal,
    });
    await ensureOk("Gemini", res);
    if (!res.body) throw new ProviderHttpError("Gemini", 0, t("errEmptyResponse"));

    const parser = new SegmentLineParser(req.texts.length);
    let final: Interaction | undefined;
    let servedModel: string | undefined;
    let started = false;

    for await (const { data } of readSse(res.body)) {
      // The stream ends with a non-JSON sentinel (observed 2026-11, not in the docs).
      if (data === "[DONE]") break;
      const ev = JSON.parse(data) as StreamEvent;
      if (!started) {
        started = true;
        req.onResponseStart?.();
      }
      switch (ev.event_type) {
        case "interaction.created":
          servedModel = ev.interaction?.model;
          break;
        case "step.delta":
          // Thought steps stream signatures/summaries, never type "text".
          if (ev.delta?.type === "text")
            for (const seg of parser.push(ev.delta.text ?? "")) yield { kind: "segment", ...seg };
          break;
        case "interaction.completed":
          final = ev.interaction;
          break;
        case "error":
          throw new ProviderHttpError("Gemini", 0, ev.error?.message ?? ev.error?.code ?? "stream error");
      }
    }
    if (!final) throw new ProviderHttpError("Gemini", 0, t("errStreamEndedEarly"));
    if (final.status === "failed" || final.status === "cancelled")
      throw new ProviderHttpError("Gemini", 0, `interaction ${final.status}`);

    const reason = final.status === "incomplete" ? "max_tokens" : "complete";
    for (const seg of parser.end({ truncated: reason !== "complete" })) yield { kind: "segment", ...seg };

    const u = final.usage ?? {};
    const cached = u.total_cached_tokens ?? 0;
    yield {
      kind: "end",
      reason,
      usage: {
        inputTokens: (u.total_input_tokens ?? 0) - cached,
        // Thinking tokens are billed at the output rate.
        outputTokens: (u.total_output_tokens ?? 0) + (u.total_thought_tokens ?? 0),
        cacheReadTokens: cached,
        cacheWriteTokens: 0,
      },
      servedModel: final.model ?? servedModel,
    };
  }
}
