// UI strings. The catalog is public/_locales/{en,ja,zh_CN,zh_TW}/messages.json
// (the manifest reads it too). chrome.i18n.getMessage can only use the browser's
// UI language, so t() resolves messages itself from the bundled catalogs. That
// lets the user pick a language on the options page; "auto" follows the browser.
// The only chrome.i18n call left is getUILanguage(), to resolve "auto".

import en from "../../public/_locales/en/messages.json";
import ja from "../../public/_locales/ja/messages.json";
import zh_CN from "../../public/_locales/zh_CN/messages.json";
import zh_TW from "../../public/_locales/zh_TW/messages.json";

export type MessageKey = keyof typeof en;

interface Entry {
  message: string;
  placeholders?: Record<string, { content: string }>;
}
type Catalog = Record<string, Entry>;

export const CATALOGS = { en, ja, zh_CN, zh_TW } as const satisfies Record<string, Catalog>;
export const UI_LOCALES = ["en", "ja", "zh_CN", "zh_TW"] as const;
export type UiLocale = (typeof UI_LOCALES)[number];
/** The stored choice: a locale, or "auto" to follow the browser. */
export type UiLanguageSetting = UiLocale | "auto";

/** Each locale's own name, shown the same way in every UI language. */
export const UI_LOCALE_LABELS: Record<UiLocale, string> = {
  en: "English",
  ja: "日本語",
  zh_CN: "简体中文",
  zh_TW: "繁體中文",
};

/** Stored values are untrusted (old versions, hand edits, messages): anything unknown means "auto". */
export function parseUiLanguage(value: unknown): UiLanguageSetting {
  return (UI_LOCALES as readonly unknown[]).includes(value) ? (value as UiLocale) : "auto";
}

/**
 * The catalog Chrome uses for a UI language tag (zh-TW and zh_TW alike): the exact locale, then its
 * language (en-US -> en). As observed in Chromium, zh-HK and zh-MO map to zh_TW and every other
 * Chinese tag (zh, zh-SG, ...) to zh_CN. Anything else falls back to en, the manifest's default_locale.
 */
export function localeFor(browserTag: string): UiLocale {
  const [lang = ""] = browserTag.split(/[-_]/);
  const exact = browserTag.replace("-", "_");
  const zh = exact === "zh_HK" || exact === "zh_MO" ? "zh_TW" : "zh_CN";
  const found = UI_LOCALES.find((l) => l === exact) ?? UI_LOCALES.find((l) => l === (lang === "zh" ? zh : lang));
  return found ?? "en";
}

/** `$name$` placeholders (case-insensitive) become their `content` (`$1`..`$9` take the substitutions); `$$` is a literal `$`. */
export function expand(entry: Entry, subs: string[]): string {
  const placeholders = Object.fromEntries(Object.entries(entry.placeholders ?? {}).map(([k, v]) => [k.toLowerCase(), v.content]));
  const fill = (s: string) => s.replace(/\$(\d)/g, (_, n: string) => subs[Number(n) - 1] ?? "");
  return entry.message.replace(/\$\$|\$([A-Za-z0-9_@]+)\$|\$(\d)/g, (m, name?: string, n?: string) => {
    if (m === "$$") return "$";
    if (n) return subs[Number(n) - 1] ?? "";
    const content = placeholders[name!.toLowerCase()];
    return content === undefined ? m : fill(content);
  });
}

/** The browser's UI language as a BCP-47 tag, e.g. "zh-TW". Input for the default target language and for "auto". */
export function browserLanguage(): string {
  return chrome.i18n.getUILanguage();
}

/** The user's choice, or undefined for "auto" (resolved on use, so it follows the browser). */
let override: UiLocale | undefined;

export function setUiLanguage(setting: UiLanguageSetting): void {
  override = setting === "auto" ? undefined : setting;
}

/** The locale t() renders in right now. */
export function currentLocale(): UiLocale {
  return override ?? localeFor(browserLanguage());
}

/**
 * Localized message: the current locale's, else English, else "". Substitutions fill the
 * message's placeholders in the order they first appear in the English text.
 */
export function t(key: MessageKey, ...subs: string[]): string {
  const entry = (CATALOGS[currentLocale()] as Catalog)[key] ?? (en as Catalog)[key];
  return entry ? expand(entry, subs) : "";
}

/**
 * Fills an extension page from its markup: `data-i18n` sets textContent,
 * `data-i18n-aria-label` and `data-i18n-title` set those attributes. The
 * HTML keeps the English text as a fallback. Also sets <html lang> to the language of the catalog in use.
 */
export function localizePage(): void {
  document.documentElement.lang = t("pageLang");
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n]")) el.textContent = t(el.dataset.i18n as MessageKey);
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n-aria-label]"))
    el.setAttribute("aria-label", t(el.dataset.i18nAriaLabel as MessageKey));
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n-title]"))
    el.setAttribute("title", t(el.dataset.i18nTitle as MessageKey));
}
