import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "../src/background/providers/anthropic";
import { GeminiProvider } from "../src/background/providers/gemini";
import { OpenAIProvider } from "../src/background/providers/openai";
import { createProvider, isAbort, missingKeyMessage } from "../src/background/providers/registry";
import { DEFAULT_SETTINGS, apiKeyFor, providerOf, type Settings } from "../src/shared/settings";

const keys: Settings = { ...DEFAULT_SETTINGS, anthropicApiKey: "a", openaiApiKey: "o", geminiApiKey: "g" };

describe("provider selection", () => {
  it.each([
    ["claude-haiku-5-5", AnthropicProvider, true, "a"],
    ["gpt-6.2-sol", OpenAIProvider, false, "o"],
    ["gemini-4-carbon", GeminiProvider, false, "g"],
  ])("%s uses its provider's key and class", (model, cls, explicitCache, key) => {
    const s = { ...keys, model };
    expect(apiKeyFor(s)).toBe(key);
    const setup = createProvider(s)!;
    expect(setup.provider).toBeInstanceOf(cls);
    expect(setup.explicitPromptCache).toBe(explicitCache);
  });

  it("asks for the selected provider's key even when another provider has one", () => {
    const s = { ...DEFAULT_SETTINGS, anthropicApiKey: "a", model: "gemini-3.5-flash-lite" };
    expect(createProvider(s)).toBeUndefined();
    expect(missingKeyMessage(s)).toBe("尚未設定 Google（Gemini） 的 API key");
  });

  it("treats an unknown stored model as Anthropic", () => {
    expect(providerOf("claude-retired-1").id).toBe("anthropic");
  });

  it("recognises a fetch abort", () => {
    expect(isAbort(new DOMException("aborted", "AbortError"))).toBe(true);
    expect(isAbort(new Error("x"))).toBe(false);
  });
});
