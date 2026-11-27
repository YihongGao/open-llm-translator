import Anthropic from "@anthropic-ai/sdk";
import { t } from "../../shared/i18n";
import { SegmentLineParser, buildSystemPrompt, buildUserMessage } from "../protocol";
import type { ErrorInfo, ProviderEvent, ProviderRequest, TranslationProvider } from "./types";

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
      if (event.type === "message_start") req.onResponseStart?.();
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        for (const seg of parser.push(event.delta.text)) yield { kind: "segment", ...seg };
      }
    }
    const final = await stream.finalMessage();
    // After a refusal or max_tokens the last line may stop mid-sentence; it
    // must not be shown or cached as a translation (see SegmentLineParser.end).
    const truncated = final.stop_reason !== "end_turn" && final.stop_reason !== "stop_sequence";
    for (const seg of parser.end({ truncated })) yield { kind: "segment", ...seg };
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

/**
 * Exact token count of the cached prefix (system prompt) per target language,
 * via the free count_tokens endpoint. The count includes a one-word user
 * message, so it overstates the prefix by a few tokens.
 */
export async function countSystemPromptTokens(
  apiKey: string,
  model: string,
  targetLangs: readonly string[],
): Promise<Array<{ targetLang: string; tokens: number }>> {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  return Promise.all(
    targetLangs.map(async (targetLang) => {
      const res = await client.messages.countTokens({
        model,
        system: [{ type: "text", text: buildSystemPrompt(targetLang) }],
        messages: [{ role: "user", content: "x" }],
      });
      return { targetLang, tokens: res.input_tokens };
    }),
  );
}

/** Maps SDK errors to a short user-facing message. */
export function describeAnthropicError(err: unknown): ErrorInfo {
  if (err instanceof Anthropic.AuthenticationError)
    return { message: t("errKeyInvalid", "Anthropic"), settings: true };
  if (err instanceof Anthropic.PermissionDeniedError)
    return { message: t("errAnthropicForbidden"), settings: true };
  if (err instanceof Anthropic.NotFoundError)
    return { message: t("errAnthropicModelNotFound"), settings: true };
  if (err instanceof Anthropic.RateLimitError) return { message: t("errAnthropicRateLimit"), settings: false };
  if (err instanceof Anthropic.BadRequestError) return { message: t("errAnthropicBadRequest", err.message), settings: false };
  if (err instanceof Anthropic.APIError && err.status !== undefined)
    return { message: t("errAnthropicApi", String(err.status), err.message), settings: false };
  if (err instanceof Anthropic.APIConnectionError) return { message: t("errConnect", "Anthropic"), settings: false };
  return { message: err instanceof Error ? err.message : String(err), settings: false };
}

export function isAbort(err: unknown): boolean {
  return err instanceof Anthropic.APIUserAbortError || (err instanceof DOMException && err.name === "AbortError");
}
