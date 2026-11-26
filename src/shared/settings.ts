// User settings persisted in chrome.storage.local (never .sync: the API key
// must not leave this machine via Chrome Sync).

export interface Settings {
  anthropicApiKey: string;
  openaiApiKey: string;
  geminiApiKey: string;
  model: string;
  /** BCP-47 tag, see TARGET_LANGUAGES. */
  targetLang: string;
}

export const DEFAULT_SETTINGS: Settings = {
  anthropicApiKey: "",
  openaiApiKey: "",
  geminiApiKey: "",
  // Haiku: ~20x cheaper than Sonnet with comparable quality on docs pages
  // (kube-scheduler A/B, 2026-11-26); Sonnet stays one click away.
  model: "claude-haiku-5-5",
  targetLang: "zh-TW",
};

export type ProviderId = "anthropic" | "openai" | "gemini";

export const PROVIDERS: ReadonlyArray<{ id: ProviderId; label: string; keySetting: keyof Settings }> = [
  { id: "anthropic", label: "Anthropic（Claude）", keySetting: "anthropicApiKey" },
  { id: "openai", label: "OpenAI（GPT）", keySetting: "openaiApiKey" },
  { id: "gemini", label: "Google（Gemini）", keySetting: "geminiApiKey" },
];

/**
 * Three tiers per provider, matched by price and positioning (2026-11):
 * fast/cheap ≈ Haiku, balanced ≈ Sonnet, flagship ≈ Opus.
 */
export const MODELS: ReadonlyArray<{ id: string; label: string; provider: ProviderId }> = [
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5（預設，便宜、快）", provider: "anthropic" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5（較通順）", provider: "anthropic" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5（品質最高、最貴）", provider: "anthropic" },
  { id: "gpt-6-luna", label: "GPT-6 Luna（便宜、快）", provider: "openai" },
  { id: "gpt-6.2-sol", label: "GPT-6.2 Sol（平衡）", provider: "openai" },
  { id: "gpt-6.2-astra", label: "GPT-6.2 Astra（旗艦、最貴）", provider: "openai" },
  { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite（便宜、快）", provider: "gemini" },
  { id: "gemini-4-hydrogen", label: "Gemini 4 Hydrogen（平衡）", provider: "gemini" },
  { id: "gemini-4-carbon", label: "Gemini 4 Carbon（旗艦）", provider: "gemini" },
];

/** Provider serving `model`; unknown ids (e.g. a removed model still in storage) fall back to Anthropic. */
export function providerOf(model: string): (typeof PROVIDERS)[number] {
  const id = MODELS.find((m) => m.id === model)?.provider ?? "anthropic";
  return PROVIDERS.find((p) => p.id === id)!;
}

export function apiKeyFor(settings: Settings, model = settings.model): string {
  return settings[providerOf(model).keySetting];
}

/** Fills a <select> with MODELS grouped by provider. */
export function fillModelSelect(select: HTMLSelectElement): void {
  for (const p of PROVIDERS) {
    const group = document.createElement("optgroup");
    group.label = p.label;
    for (const m of MODELS.filter((x) => x.provider === p.id)) group.append(new Option(m.label, m.id));
    select.append(group);
  }
}

/** Prompt-facing names; the model sees `name`, the UI shows `label`. */
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
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  return { ...DEFAULT_SETTINGS, ...(stored as Partial<Settings>) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  await chrome.storage.local.set(patch);
}

/** Deletes one stored API key (removed, not blanked) and leaves every other setting alone. */
export async function clearApiKey(provider: (typeof PROVIDERS)[number]): Promise<void> {
  await chrome.storage.local.remove(provider.keySetting);
}
