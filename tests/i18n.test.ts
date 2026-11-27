// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { describeHttpError } from "../src/background/providers/http";
import { missingKeyMessage } from "../src/background/providers/registry";
import { localizePage, t } from "../src/shared/i18n";
import { DEFAULT_SETTINGS, MODELS, PROVIDERS, fillModelSelect, keyFieldHint, providerLabel } from "../src/shared/settings";
import { CATALOGS, expand, i18nStub, useLocale, type Locale } from "./helpers/i18n";

const locales = Object.keys(CATALOGS) as Locale[];
const keys = Object.keys(CATALOGS.en);
const placeholderNames = (e: { message: string }) => [...e.message.matchAll(/\$([A-Za-z0-9_@]+)\$/g)].map((m) => m[1]!.toLowerCase());

// happy-dom has no Option constructor.
(globalThis as { Option?: unknown }).Option = function (text: string, value: string) {
  const o = document.createElement("option");
  o.textContent = text;
  o.value = value;
  return o;
};

afterEach(() => useLocale("zh_TW"));

describe("catalogs", () => {
  it.each(locales)("%s has exactly the English keys", (locale) => {
    expect(Object.keys(CATALOGS[locale]).sort()).toEqual([...keys].sort());
  });

  it.each(locales)("%s has no empty message", (locale) => {
    for (const [key, entry] of Object.entries(CATALOGS[locale])) expect(entry.message.trim(), key).not.toBe("");
  });

  it.each(locales)("%s uses the same placeholders as English, each declared", (locale) => {
    for (const key of keys) {
      const en = (CATALOGS.en as Record<string, { message: string; placeholders?: object }>)[key]!;
      const entry = (CATALOGS[locale] as Record<string, { message: string; placeholders?: object }>)[key]!;
      const declared = Object.keys(entry.placeholders ?? {}).map((n) => n.toLowerCase());
      expect([...new Set(placeholderNames(entry))].sort(), `${locale}.${key} used`).toEqual([...new Set(placeholderNames(en))].sort());
      expect(declared.sort(), `${locale}.${key} declared`).toEqual([...new Set(placeholderNames(en))].sort());
      expect(JSON.stringify(entry.placeholders), `${locale}.${key} contents`).toBe(JSON.stringify(en.placeholders));
    }
  });

  it("has no \\uXXXX-escaped text on disk (check-dist rejects it)", () => {
    for (const locale of locales) {
      const raw = readFileSync(`public/_locales/${locale}/messages.json`, "utf8");
      expect(raw).not.toMatch(/\\u[0-9a-fA-F]{4}/);
    }
  });

  it("uses full-width punctuation only in ja and zh_TW", () => {
    for (const [key, entry] of Object.entries(CATALOGS.en)) expect(entry.message, key).not.toMatch(/[，。：；（）？！、]/);
  });
});

describe("getMessage stub", () => {
  it("follows Chrome: named placeholders, $$, missing key", () => {
    expect(expand({ message: "a $X$ b $$ c", placeholders: { x: { content: "$1" } } }, ["1"])).toBe("a 1 b $ c");
    expect(i18nStub("en").getMessage("doesNotExist")).toBe("");
  });
});

describe("t", () => {
  it("renders the UI language", () => {
    useLocale("en");
    expect(t("popupTranslatePage")).toBe("Translate this page");
    useLocale("ja");
    expect(t("popupTranslatePage")).toBe("このページを翻訳");
    useLocale("zh_TW");
    expect(t("popupTranslatePage")).toBe("翻譯此頁");
  });

  it("fills placeholders in the order they appear in English", () => {
    useLocale("en");
    expect(t("providerLabel", "Anthropic", "Claude")).toBe("Anthropic (Claude)");
    useLocale("ja");
    expect(t("providerLabel", "Anthropic", "Claude")).toBe("Anthropic（Claude）");
    expect(t("optionsTestFail", "x")).toBe("失敗：x");
  });
});

describe("localized strings reach the UI", () => {
  it("model options and provider groups follow the language", () => {
    useLocale("en");
    const select = document.createElement("select");
    fillModelSelect(select);
    expect(select.querySelector("optgroup")!.label).toBe("Anthropic (Claude)");
    expect(select.querySelector("option")!.textContent).toBe("Claude Haiku 5.5 (default, cheap and fast)");
    expect(select.options).toHaveLength(MODELS.length);
    useLocale("zh_TW");
    const zh = document.createElement("select");
    fillModelSelect(zh);
    expect(zh.querySelector("option")!.textContent).toBe("Claude Haiku 5.5（預設，便宜、快）");
  });

  it("provider errors and the missing-key message follow the language", () => {
    useLocale("en");
    expect(describeHttpError("OpenAI", new TypeError("x"))).toEqual({ message: "Can't connect to the OpenAI API", settings: false });
    expect(missingKeyMessage({ ...DEFAULT_SETTINGS, model: "gemini-4-carbon" })).toBe("No API key set for Google (Gemini)");
    useLocale("ja");
    expect(missingKeyMessage({ ...DEFAULT_SETTINGS, model: "gemini-4-carbon" })).toBe("Google（Gemini）の API キーが未設定です");
  });

  it("the saved-key placeholder follows the language", () => {
    useLocale("en");
    expect(keyFieldHint("sk-ant-api03-secret-WXYZ", "sk-ant-...")).toBe("Saved (…WXYZ). Paste a new key to replace it.");
    expect(keyFieldHint("short", "sk-ant-...")).toBe("Saved. Paste a new key to replace it.");
  });

  it("provider labels use the catalog", () => {
    useLocale("ja");
    expect(PROVIDERS.map(providerLabel)).toEqual(["Anthropic（Claude）", "OpenAI（GPT）", "Google（Gemini）"]);
  });
});

describe("localizePage", () => {
  const page = `<p id="a" data-i18n="popupTranslatePage">x</p>
    <button id="b" data-i18n-aria-label="toastClose" data-i18n-title="popupShortcuts">y</button>`;

  it("fills data-i18n nodes, aria-label and title, and sets <html lang>", () => {
    document.body.innerHTML = page;
    useLocale("ja");
    localizePage();
    expect(document.getElementById("a")!.textContent).toBe("このページを翻訳");
    expect(document.getElementById("b")!.getAttribute("aria-label")).toBe("閉じる");
    expect(document.getElementById("b")!.getAttribute("title")).toBe("ショートカット");
    expect(document.documentElement.lang).toBe("ja");
    useLocale("zh_TW");
    localizePage();
    expect(document.documentElement.lang).toBe("zh-TW");
  });

  it("an unsupported UI language falls back to English, <html lang> included", () => {
    document.body.innerHTML = page;
    useLocale("fr");
    localizePage();
    expect(document.getElementById("a")!.textContent).toBe("Translate this page");
    expect(document.documentElement.lang).toBe("en");
  });

  it("writes text, never markup", () => {
    document.body.innerHTML = `<p id="a" data-i18n="optionsTestOk"></p>`;
    localizePage();
    expect(document.getElementById("a")!.children).toHaveLength(0);
  });
});

describe("extension pages", () => {
  for (const file of ["popup.html", "options.html"]) {
    const html = readFileSync(`public/${file}`, "utf8");

    it(`${file}: every data-i18n key exists and its English fallback text matches the catalog`, () => {
      document.documentElement.innerHTML = html;
      const squash = (s: string) => s.replace(/\s+/g, " ").trim();
      const nodes = document.querySelectorAll<HTMLElement>("[data-i18n]");
      expect(nodes.length).toBeGreaterThan(0);
      for (const el of nodes) {
        const key = el.dataset.i18n!;
        const entry = (CATALOGS.en as Record<string, { message: string }>)[key];
        expect(entry, `${file}: unknown key ${key}`).toBeDefined();
        expect(squash(el.textContent ?? ""), `${file}: ${key}`).toBe(squash(entry!.message));
      }
      for (const attr of ["data-i18n-aria-label", "data-i18n-title"])
        for (const el of document.querySelectorAll<HTMLElement>(`[${attr}]`))
          expect(Object.keys(CATALOGS.en), `${file}: ${attr}`).toContain(el.getAttribute(attr));
    });

    it(`${file}: no Chinese text left in the markup`, () => {
      expect(html).not.toMatch(/[　-鿿＀-￯]/);
    });
  }

  it("manifest strings resolve through the catalog", () => {
    const manifest = JSON.parse(readFileSync("public/manifest.json", "utf8")) as {
      default_locale: string;
      description: string;
      commands: Record<string, { description: string }>;
    };
    expect(manifest.default_locale).toBe("en");
    const refs = [manifest.description, ...Object.values(manifest.commands).map((c) => c.description)];
    for (const ref of refs) {
      const key = /^__MSG_(\w+)__$/.exec(ref)?.[1];
      expect(key, ref).toBeDefined();
      expect(keys).toContain(key);
    }
    expect(CATALOGS.en.extDescription.message.length).toBeLessThanOrEqual(132);
  });
});
