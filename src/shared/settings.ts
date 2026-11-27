// User settings persisted in chrome.storage.local (never .sync: the API key
// must not leave this machine via Chrome Sync).

import { browserLanguage, parseUiLanguage, t, type MessageKey, type UiLanguageSetting } from "./i18n";

export interface Settings {
  anthropicApiKey: string;
  openaiApiKey: string;
  geminiApiKey: string;
  model: string;
  /** BCP-47 tag, see TARGET_LANGUAGES. */
  targetLang: string;
  /** Language of the extension's own UI; "auto" follows the browser. */
  uiLanguage: UiLanguageSetting;
}

/**
 * Target language a fresh install starts with: the browser's UI language
 * mapped onto TARGET_LANGUAGES. Chinese splits by script and region
 * (Traditional for TW/HK/MO, Simplified otherwise); anything unsupported is English.
 */
export function targetLangFor(uiLang: string): string {
  const [lang = "", ...rest] = uiLang.toLowerCase().split(/[-_]/);
  if (lang === "zh") {
    // A script subtag decides before the region: zh-Hans-HK is Simplified.
    if (rest.includes("hans")) return "zh-CN";
    if (rest.includes("hant")) return "zh-TW";
    return rest.some((p) => ["tw", "hk", "mo"].includes(p)) ? "zh-TW" : "zh-CN";
  }
  return TARGET_LANGUAGES.find((l) => l.tag === lang)?.tag ?? "en";
}

/** Defaults for every setting the user has not stored. Computed, because the language default depends on the browser. */
export function defaultSettings(): Settings {
  return {
    anthropicApiKey: "",
    openaiApiKey: "",
    geminiApiKey: "",
    // Haiku: ~20x cheaper than Sonnet with comparable quality on docs pages
    // (kube-scheduler A/B, 2026-11-26); Sonnet stays one click away.
    model: "claude-haiku-5-5",
    targetLang: targetLangFor(browserLanguage()),
    uiLanguage: "auto",
  };
}

export type ProviderId = "anthropic" | "openai" | "gemini";

export type KeySetting = "anthropicApiKey" | "openaiApiKey" | "geminiApiKey";

interface Provider {
  id: ProviderId;
  /** Company name; the same in every UI language. */
  name: string;
  /** Model family, e.g. "Claude". */
  product: string;
  keySetting: KeySetting;
}

export const PROVIDERS: ReadonlyArray<Provider> = [
  { id: "anthropic", name: "Anthropic", product: "Claude", keySetting: "anthropicApiKey" },
  { id: "openai", name: "OpenAI", product: "GPT", keySetting: "openaiApiKey" },
  { id: "gemini", name: "Google", product: "Gemini", keySetting: "geminiApiKey" },
];

/** "Anthropic (Claude)", in the UI language's punctuation. */
export function providerLabel(p: Provider): string {
  return t("providerLabel", p.name, p.product);
}

/**
 * Three tiers per provider, matched by price and positioning (2026-11):
 * fast/cheap ≈ Haiku, balanced ≈ Sonnet, flagship ≈ Opus.
 */
export const MODELS: ReadonlyArray<{ id: string; name: string; note: MessageKey; provider: ProviderId }> = [
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", note: "modelNoteDefaultFast", provider: "anthropic" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", note: "modelNoteSmoother", provider: "anthropic" },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", note: "modelNoteBestPriciest", provider: "anthropic" },
  { id: "gpt-6-luna", name: "GPT-6 Luna", note: "modelNoteCheapFast", provider: "openai" },
  { id: "gpt-6.2-sol", name: "GPT-6.2 Sol", note: "modelNoteBalanced", provider: "openai" },
  { id: "gpt-6.2-astra", name: "GPT-6.2 Astra", note: "modelNoteFlagshipPriciest", provider: "openai" },
  { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash-Lite", note: "modelNoteCheapFast", provider: "gemini" },
  { id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen", note: "modelNoteBalanced", provider: "gemini" },
  { id: "gemini-4-carbon", name: "Gemini 4 Carbon", note: "modelNoteFlagship", provider: "gemini" },
];

/** Provider serving `model`; unknown ids (e.g. a removed model still in storage) fall back to Anthropic. */
export function providerOf(model: string): Provider {
  const id = MODELS.find((m) => m.id === model)?.provider ?? "anthropic";
  return PROVIDERS.find((p) => p.id === id)!;
}

export function apiKeyFor(settings: Settings, model = settings.model): string {
  return settings[providerOf(model).keySetting];
}

/** Fills a <select> with MODELS grouped by provider. Replaces its options, so call it again to relabel (and restore the value). */
export function fillModelSelect(select: HTMLSelectElement): void {
  select.replaceChildren();
  for (const p of PROVIDERS) {
    const group = document.createElement("optgroup");
    group.label = providerLabel(p);
    for (const m of MODELS.filter((x) => x.provider === p.id))
      group.append(new Option(t("modelOption", m.name, t(m.note)), m.id));
    select.append(group);
  }
}

/**
 * Prompt-facing names; the model sees `name`. `label` is the language's own
 * name (endonym), so a picker shows every language the way its speakers write
 * it, whatever the UI language is.
 */
export const TARGET_LANGUAGES: ReadonlyArray<{ tag: string; name: string; label: string }> = [
  { tag: "zh-TW", name: "Traditional Chinese as used in Taiwan (繁體中文，台灣用語)", label: "繁體中文（台灣）" },
  { tag: "zh-CN", name: "Simplified Chinese (简体中文)", label: "简体中文" },
  { tag: "en", name: "English", label: "English" },
  { tag: "ja", name: "Japanese (日本語)", label: "日本語" },
  { tag: "ko", name: "Korean (한국어)", label: "한국어" },
];

export function languageName(tag: string): string {
  return TARGET_LANGUAGES.find((l) => l.tag === tag)?.name ?? tag;
}

export async function loadSettings(): Promise<Settings> {
  const defaults = defaultSettings();
  const stored = await chrome.storage.local.get(Object.keys(defaults));
  const merged = { ...defaults, ...(stored as Partial<Settings>) };
  return { ...merged, uiLanguage: parseUiLanguage(merged.uiLanguage) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  await chrome.storage.local.set(patch);
}

/**
 * The options page never shows a saved key again, so an empty field means
 * "keep what is stored": only keys the user typed are written.
 */
export function typedKeyPatch(typed: Record<KeySetting, string>): Partial<Settings> {
  const patch: Partial<Settings> = {};
  for (const [setting, value] of Object.entries(typed) as [KeySetting, string][]) {
    if (value.trim()) patch[setting] = value.trim();
  }
  return patch;
}

/** Placeholder for a key field: the last four characters of a stored key, or the example format. */
export function keyFieldHint(stored: string, example: string): string {
  if (!stored) return example;
  return stored.length >= 16 ? t("keyHintSavedTail", `…${stored.slice(-4)}`) : t("keyHintSaved");
}

/** Deletes one stored API key (removed, not blanked) and leaves every other setting alone. */
export async function clearApiKey(provider: (typeof PROVIDERS)[number]): Promise<void> {
  await chrome.storage.local.remove(provider.keySetting);
}
