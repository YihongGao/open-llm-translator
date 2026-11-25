// User settings persisted in chrome.storage.local (never .sync: the API key
// must not leave this machine via Chrome Sync).

export interface Settings {
  anthropicApiKey: string;
  model: string;
  /** BCP-47 tag, see TARGET_LANGUAGES. */
  targetLang: string;
}

export const DEFAULT_SETTINGS: Settings = {
  anthropicApiKey: "",
  model: "claude-sonnet-5-5",
  targetLang: "zh-TW",
};

export const MODELS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5（預設）" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5（便宜、快）" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5（品質最高、最貴）" },
];

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
