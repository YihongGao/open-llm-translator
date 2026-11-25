import Anthropic from "@anthropic-ai/sdk";
import { languageName } from "../../shared/settings";
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
        system: buildSystemPrompt(languageName(req.targetLang)),
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
    yield { kind: "end", reason };
  }
}

/** Maps SDK errors to a short message shown next to the failed segment. */
export function describeAnthropicError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "Anthropic API key 無效（401），請到設定頁確認";
  if (err instanceof Anthropic.PermissionDeniedError) return "API key 沒有此 model 的權限（403）";
  if (err instanceof Anthropic.NotFoundError) return "找不到 model（404），請到設定頁確認 model";
  if (err instanceof Anthropic.RateLimitError) return "超過速率限制（429），稍後再試";
  if (err instanceof Anthropic.BadRequestError) return `請求被拒（400）：${err.message}`;
  if (err instanceof Anthropic.APIError && err.status !== undefined) return `API 錯誤 ${err.status}：${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return "無法連線到 Anthropic API";
  return err instanceof Error ? err.message : String(err);
}

export function isAbort(err: unknown): boolean {
  return err instanceof Anthropic.APIUserAbortError || (err instanceof DOMException && err.name === "AbortError");
}
