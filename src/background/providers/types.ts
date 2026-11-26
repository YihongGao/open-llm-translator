import type { PageContext } from "../../shared/messages";

export interface ProviderRequest {
  /** Source texts; results refer to them by 0-based index. */
  texts: readonly string[];
  targetLang: string;
  page: PageContext;
  /** Called once when the API response starts streaming. */
  onResponseStart?: () => void;
}

export type ProviderEvent =
  | { kind: "segment"; index: number; text: string }
  /** Always the last event. `reason` explains why some segments may be missing. */
  | {
      kind: "end";
      reason: "complete" | "max_tokens" | "refusal";
      usage?: TokenUsage;
      /** Model that actually produced the output, as reported by the API. */
      servedModel?: string;
      /** A fallback model took over after the requested one declined. */
      fallback?: boolean;
    };

export interface TokenUsage {
  /** Uncached input (after the last cache breakpoint). */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * One implementation per backend (Anthropic, OpenAI, Gemini). Implementations
 * throw on transport/API errors; partial results already yielded stay valid.
 */
export interface TranslationProvider {
  translate(req: ProviderRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent>;
}

export interface ErrorInfo {
  message: string;
  /** Fixable in the options page (key or model). */
  settings: boolean;
}
