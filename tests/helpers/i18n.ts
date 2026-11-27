// A chrome.i18n stand-in that resolves messages the way Chrome does, from the
// real catalogs in public/_locales. Tests run under zh_TW unless they say
// otherwise, so assertions written against the Chinese UI keep their meaning.

import en from "../../public/_locales/en/messages.json";
import ja from "../../public/_locales/ja/messages.json";
import zh_CN from "../../public/_locales/zh_CN/messages.json";
import zh_TW from "../../public/_locales/zh_TW/messages.json";

interface Entry {
  message: string;
  placeholders?: Record<string, { content: string }>;
}
type Catalog = Record<string, Entry>;

export const CATALOGS = { en, ja, zh_CN, zh_TW } as const satisfies Record<string, Catalog>;
export type Locale = keyof typeof CATALOGS;

/**
 * The catalog Chrome uses for a UI language tag (zh-TW and zh_TW alike): the exact locale, then its
 * parent or language (en-US -> en). As observed in Chromium, zh-HK and zh-MO map to zh_TW and every
 * other Chinese tag (zh, zh-SG, ...) to zh_CN. undefined when there is none, so the default locale applies.
 */
function catalogFor(tag: string): Catalog | undefined {
  const [lang = ""] = tag.split(/[-_]/);
  const all = CATALOGS as Record<string, Catalog>;
  const exact = tag.replace("-", "_");
  const zh = { zh_HK: "zh_TW", zh_MO: "zh_TW" }[exact] ?? "zh_CN";
  return all[exact] ?? all[lang === "zh" ? zh : lang];
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

/** What chrome.i18n does: the UI locale's message, else default_locale's (en), else "". */
export function i18nStub(locale: string = "zh_TW") {
  return {
    getMessage(key: string, subs?: string | string[]): string {
      const list = subs === undefined ? [] : Array.isArray(subs) ? subs : [subs];
      const entry = catalogFor(locale)?.[key] ?? (en as Catalog)[key];
      return entry ? expand(entry, list) : "";
    },
    getUILanguage: () => locale.replace("_", "-"),
  };
}

/** Installs the stub as globalThis.chrome.i18n, keeping the rest of any existing chrome stub. */
export function useLocale(locale: string): void {
  const g = globalThis as unknown as { chrome?: Record<string, unknown> };
  g.chrome = { ...g.chrome, i18n: i18nStub(locale) };
}
