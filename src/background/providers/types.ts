import type { PageContext } from "../../shared/messages";

export interface ProviderRequest {
  /** Source texts; results refer to them by 0-based index. */
  texts: readonly string[];
  targetLang: string;
  page: PageContext;
}

export type ProviderEvent =
  | { kind: "segment"; index: number; text: string }
  /** Always the last event. `reason` explains why some segments may be missing. */
  | { kind: "end"; reason: "complete" | "max_tokens" | "refusal" };

/**
 * One implementation per backend (Anthropic API now; Gemini API / local CLI
 * bridge later). Implementations throw on transport/API errors; partial
 * results already yielded stay valid.
 */
export interface TranslationProvider {
  translate(req: ProviderRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent>;
}
