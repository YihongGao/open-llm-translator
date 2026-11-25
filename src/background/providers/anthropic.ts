import Anthropic from "@anthropic-ai/sdk";
import { SegmentLineParser, buildSystemPrompt, buildUserMessage } from "../protocol";
import type { ProviderEvent, ProviderRequest, TranslationProvider } from "./types";

// Server-side refusal fallback: on a safety decline the API re-runs the request
// on a fallback model within the same call. Claude Haiku 5.5 has no server-side
// fallback, so the parameter is only sent for the models below.
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const MODELS_WITH_FALLBACK = new Set(["claude-sonnet-5-5", "claude-opus-5-5"]);

export class AnthropicProvider implements TranslationProvider {
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    // The key is the user's own and lives only in this extension's storage,
    // so direct browser access is the intended setup here.
    this.client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
  }

  async *translate(req: ProviderRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    const parser = new SegmentLineParser(req.texts.length);
    const withFallback = MODELS_WITH_FALLBACK.has(this.model);

    const stream = this.client.beta.messages.stream(
      {
        model: this.model,
        max_tokens: 16000,
        // Translation needs little reasoning; low effort keeps latency down.
        output_config: { effort: "low" },
        // Explicit breakpoint on the static prefix: every batch of every page
        // shares it, so after the first request it is read at the cache rate.
        system: [{ type: "text", text: buildSystemPrompt(req.targetLang), cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: buildUserMessage(req.texts, req.page) }],
        ...(withFallback ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
      },
      { signal },
    );

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        for (const seg of parser.push(event.delta.text)) yield { kind: "segment", ...seg };
      }
    }
    for (const seg of parser.end()) yield { kind: "segment", ...seg };

    const final = await stream.finalMessage();
    const reason =
      final.stop_reason === "refusal" ? "refusal" : final.stop_reason === "max_tokens" ? "max_tokens" : "complete";
    yield {
      kind: "end",
      reason,
      usage: {
        inputTokens: final.usage.input_tokens,
        outputTokens: final.usage.output_tokens,
        cacheReadTokens: final.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: final.usage.cache_creation_input_tokens ?? 0,
      },
      servedModel: final.model,
      // The documented served-by signal: a fallback_message entry in usage.iterations.
      fallback: (final.usage.iterations ?? []).some((it) => it.type === "fallback_message"),
    };
  }
}

export interface ErrorInfo {
  message: string;
  /** Fixable in the options page (key or model). */
  settings: boolean;
}

/** Maps SDK errors to a short user-facing message. */
export function describeAnthropicError(err: unknown): ErrorInfo {
  if (err instanceof Anthropic.AuthenticationError)
    return { message: "Anthropic API key 無效（401），請到設定頁確認", settings: true };
  if (err instanceof Anthropic.PermissionDeniedError)
    return { message: "API key 沒有此 model 的權限（403）", settings: true };
  if (err instanceof Anthropic.NotFoundError)
    return { message: "找不到 model（404），請到設定頁確認 model", settings: true };
  if (err instanceof Anthropic.RateLimitError) return { message: "超過速率限制（429），稍後再試", settings: false };
  if (err instanceof Anthropic.BadRequestError) return { message: `請求被拒（400）：${err.message}`, settings: false };
  if (err instanceof Anthropic.APIError && err.status !== undefined)
    return { message: `API 錯誤 ${err.status}：${err.message}`, settings: false };
  if (err instanceof Anthropic.APIConnectionError) return { message: "無法連線到 Anthropic API", settings: false };
  return { message: err instanceof Error ? err.message : String(err), settings: false };
}

export function isAbort(err: unknown): boolean {
  return err instanceof Anthropic.APIUserAbortError || (err instanceof DOMException && err.name === "AbortError");
}
