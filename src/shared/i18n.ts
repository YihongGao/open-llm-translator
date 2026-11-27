// UI strings. The catalog is public/_locales/{en,ja,zh_TW}/messages.json and
// Chrome picks the locale from the browser UI language (fallback: en, the
// manifest's default_locale). This is the only module that touches chrome.i18n.

import type en from "../../public/_locales/en/messages.json";

export type MessageKey = keyof typeof en;

/**
 * Localized message. Substitutions fill the message's placeholders in the
 * order they first appear in the English text.
 */
export function t(key: MessageKey, ...subs: string[]): string {
  return chrome.i18n.getMessage(key, subs);
}

/**
 * Fills an extension page from its markup: `data-i18n` sets textContent,
 * `data-i18n-aria-label` and `data-i18n-title` set those attributes. The
 * HTML keeps the English text as a fallback. Also sets <html lang> to the language of the catalog in use.
 */
export function localizePage(root: ParentNode = document): void {
  document.documentElement.lang = t("pageLang");
  for (const el of root.querySelectorAll<HTMLElement>("[data-i18n]")) el.textContent = t(el.dataset.i18n as MessageKey);
  for (const el of root.querySelectorAll<HTMLElement>("[data-i18n-aria-label]"))
    el.setAttribute("aria-label", t(el.dataset.i18nAriaLabel as MessageKey));
  for (const el of root.querySelectorAll<HTMLElement>("[data-i18n-title]"))
    el.setAttribute("title", t(el.dataset.i18nTitle as MessageKey));
}
