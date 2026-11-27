// @vitest-environment happy-dom
// The UI language setting: Follow browser ("auto") or a fixed catalog, resolved by our own t().
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UI_LOCALES, currentLocale, expand, localeFor, parseUiLanguage, setUiLanguage, t } from "../src/shared/i18n";
import { defaultSettings, loadSettings } from "../src/shared/settings";
import { setTabLanguage, toggleTab } from "../src/shared/tab-control";
import { h, loadContent, scrollAllIntoView, tell } from "./helpers/content-harness";
import { i18nStub, useLocale } from "./helpers/i18n";

afterEach(() => {
  vi.unstubAllGlobals();
  useLocale("zh_TW");
});

describe("localeFor: the catalog Chrome picks for a browser language", () => {
  it.each([
    ["en", "en"], ["en-US", "en"], ["en_GB", "en"], ["ja", "ja"], ["ja-JP", "ja"],
    ["zh-TW", "zh_TW"], ["zh_TW", "zh_TW"], ["zh-HK", "zh_TW"], ["zh-MO", "zh_TW"],
    ["zh-CN", "zh_CN"], ["zh_CN", "zh_CN"], ["zh", "zh_CN"], ["zh-SG", "zh_CN"],
    ["fr", "en"], ["ko", "en"], ["", "en"],
  ])("%s -> %s", (tag, locale) => {
    expect(localeFor(tag)).toBe(locale);
  });
});

describe("setUiLanguage", () => {
  it("auto follows the browser, even when the browser language changes later", () => {
    useLocale("ja");
    expect(t("popupTranslatePage")).toBe("このページを翻訳");
    useLocale("en");
    expect(t("popupTranslatePage")).toBe("Translate this page");
  });

  it("an explicit locale wins over the browser language, and auto restores it", () => {
    useLocale("zh_TW");
    for (const [locale, text] of [
      ["en", "Translate this page"],
      ["ja", "このページを翻訳"],
      ["zh_CN", "翻译此页"],
      ["zh_TW", "翻譯此頁"],
    ] as const) {
      setUiLanguage(locale);
      expect(t("popupTranslatePage")).toBe(text);
      expect(currentLocale()).toBe(locale);
    }
    setUiLanguage("en");
    setUiLanguage("auto");
    expect(t("popupTranslatePage")).toBe("翻譯此頁");
  });

  it("covers every locale", () => {
    for (const locale of UI_LOCALES) {
      setUiLanguage(locale);
      expect(t("pageLang")).toBe(locale.replace("_", "-"));
    }
  });
});

describe("t placeholder rules (Chrome's)", () => {
  it("named placeholders, $N, $$ and a missing key", () => {
    expect(expand({ message: "a $X$ b $$ c $2", placeholders: { x: { content: "$1" } } }, ["1", "2"])).toBe("a 1 b $ c 2");
    expect(t("noSuchKey" as never)).toBe("");
  });

  it("keeps a dollar sign in a substitution literally", () => {
    setUiLanguage("en");
    expect(t("providerLabel", "A$&B", "$1 $$")).toBe("A$&B ($1 $$)");
  });
});

describe("parseUiLanguage and the stored setting", () => {
  it.each([["ja", "ja"], ["zh_TW", "zh_TW"], ["auto", "auto"], ["zh-TW", "auto"], ["fr", "auto"], ["", "auto"], [undefined, "auto"], [3, "auto"], [null, "auto"]])(
    "%j -> %s",
    (value, expected) => expect(parseUiLanguage(value)).toBe(expected),
  );

  it("defaults to auto, keeps a valid stored choice and turns junk into auto", async () => {
    expect(defaultSettings().uiLanguage).toBe("auto");
    let stored: Record<string, unknown> = {};
    vi.stubGlobal("chrome", { i18n: i18nStub(), storage: { local: { get: async () => ({ ...stored }) } } });
    expect((await loadSettings()).uiLanguage).toBe("auto");
    stored = { uiLanguage: "ja" };
    expect((await loadSettings()).uiLanguage).toBe("ja");
    stored = { uiLanguage: "klingon" };
    expect((await loadSettings()).uiLanguage).toBe("auto");
  });

  it("does not change the default target language, which keeps following the browser", async () => {
    vi.stubGlobal("chrome", { i18n: i18nStub("ja"), storage: { local: { get: async () => ({ uiLanguage: "zh_TW" }) } } });
    expect((await loadSettings()).targetLang).toBe("ja");
  });
});

describe("the content script gets the UI language in its messages (it cannot read storage)", () => {
  let sent: unknown[];
  beforeEach(() => {
    sent = [];
    vi.stubGlobal("chrome", {
      i18n: i18nStub(),
      storage: { local: { get: async () => ({ uiLanguage: "ja", targetLang: "ko" }), setAccessLevel: async () => {} } },
      tabs: { sendMessage: async (_id: number, msg: unknown) => (sent.push(msg), { active: true, subtitles: null }) },
    });
  });

  it("llmt-toggle carries uiLanguage", async () => {
    await toggleTab(1);
    expect(sent).toEqual([{ type: "llmt-toggle", targetLang: "ko", uiLanguage: "ja", feature: "page" }]);
  });

  it("llmt-set-lang carries uiLanguage", async () => {
    await setTabLanguage(1, "en");
    expect(sent).toEqual([{ type: "llmt-set-lang", targetLang: "en", uiLanguage: "ja" }]);
  });
});

describe("content script strings", () => {
  const pageError = (message: string) => {
    const batch = h.posted[0]!;
    h.toPage({ type: "segment-error", batchId: batch.batchId, ids: batch.segments.map((s) => s.id), message, scope: "page", settings: false });
    return [...document.querySelectorAll("llmt-toast")].at(-1)!.shadowRoot!.querySelector(".msg")!.textContent;
  };

  it("render in the language the toggle message names, not the browser's", async () => {
    await loadContent("<p>Hello world, this is a paragraph.</p>");
    expect(tell({ type: "llmt-set-lang", targetLang: "zh-TW", uiLanguage: "ja" })).toMatchObject({ active: true });
    await scrollAllIntoView();
    expect(pageError("x")).toBe("翻訳に失敗しました：x");
  });

  it("follow the browser when the message says auto (or omits it)", async () => {
    await loadContent("<p>Hello world, this is a paragraph.</p>");
    tell({ type: "llmt-set-lang", targetLang: "zh-TW", uiLanguage: "auto" });
    await scrollAllIntoView();
    expect(pageError("x")).toBe("翻譯失敗：x");
  });
});
