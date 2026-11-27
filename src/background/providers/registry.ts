// Picks the provider implementation for the configured model.

import { t } from "../../shared/i18n";
import { apiKeyFor, providerLabel, providerOf, type Settings } from "../../shared/settings";
import { AnthropicProvider, describeAnthropicError, isAbort as isAnthropicAbort } from "./anthropic";
import { GeminiProvider } from "./gemini";
import { describeHttpError } from "./http";
import { OpenAIProvider } from "./openai";
import type { ErrorInfo, TranslationProvider } from "./types";

export interface ProviderSetup {
  provider: TranslationProvider;
  /** Only Anthropic needs an explicit cache breakpoint warmed before fan-out. */
  explicitPromptCache: boolean;
  describeError(err: unknown): ErrorInfo;
}

/** Undefined when the model's provider has no API key configured. */
export function createProvider(settings: Settings): ProviderSetup | undefined {
  const key = apiKeyFor(settings);
  if (!key) return undefined;
  const { id } = providerOf(settings.model);
  switch (id) {
    case "anthropic":
      return {
        provider: new AnthropicProvider(key, settings.model),
        explicitPromptCache: true,
        describeError: describeAnthropicError,
      };
    case "openai":
      return {
        provider: new OpenAIProvider(key, settings.model),
        explicitPromptCache: false,
        describeError: (err) => describeHttpError("OpenAI", err),
      };
    case "gemini":
      return {
        provider: new GeminiProvider(key, settings.model),
        explicitPromptCache: false,
        describeError: (err) => describeHttpError("Gemini", err),
      };
  }
}

export function isAbort(err: unknown): boolean {
  return isAnthropicAbort(err) || (err instanceof DOMException && err.name === "AbortError");
}

/** e.g. "No API key set for OpenAI (GPT)". */
export function missingKeyMessage(settings: Settings): string {
  return t("errMissingKey", providerLabel(providerOf(settings.model)));
}
