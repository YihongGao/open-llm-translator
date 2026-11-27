// A chrome.i18n stand-in for the browser UI language. src/shared/i18n.ts resolves
// messages itself and asks chrome.i18n only for getUILanguage(), so that is all
// this provides. Tests run under zh_TW unless they say otherwise, so assertions
// written against the Chinese UI keep their meaning.

export function i18nStub(locale: string = "zh_TW") {
  return { getUILanguage: () => locale.replace("_", "-") };
}

/** Installs the stub as globalThis.chrome.i18n, keeping the rest of any existing chrome stub. */
export function useLocale(locale: string): void {
  const g = globalThis as unknown as { chrome?: Record<string, unknown> };
  g.chrome = { ...g.chrome, i18n: i18nStub(locale) };
}
