// Journey: the whole UI follows the browser UI language. English and Japanese
// render in popup, options page, page toast and keyboard-command descriptions;
// an unsupported language (fr) falls back to English.
// Usage: node .claude/skills/verify/scripts/journey-ui-locale.mjs
// Exit 0 = every check passed. Evidence in the printed artifacts dirs (one per language).
//
// No API key is stored, so the popup warning and the in-page missing-key toast
// both show. The mock API is never reached.
import { launch, waitForPage } from "./harness.mjs";

const EN = {
  ui: "en",
  htmlLang: "en",
  title: "Open LLM Translator Settings",
  toggle: "Translate this page",
  warn: "No API key set for Anthropic (Claude).",
  settings: "⚙ Settings",
  shortcuts: "Shortcuts",
  save: "Save",
  test: "Test connection",
  clear: "Clear",
  clearAria: "Clear Anthropic API key",
  activeLabel: " (in use)",
  modelOption: "Claude Haiku 5.5 (default, cheap and fast)",
  toast: "Translation failed: No API key set for Anthropic (Claude)",
  toastAction: "Open settings",
  cmdPage: "Toggle translation on this page",
  cmdSubs: "Toggle YouTube bilingual subtitles",
  description: "Shows LLM translations below the original text (bilingual view)",
  statusSaved: "Saved. Pages that are already open need translation toggled off and on again to use the new language.",
};
const JA = {
  ui: "ja",
  htmlLang: "ja",
  title: "Open LLM Translator の設定",
  toggle: "このページを翻訳",
  warn: "Anthropic（Claude）の API キーが未設定です。",
  settings: "⚙ 設定",
  shortcuts: "ショートカット",
  save: "保存",
  test: "接続をテスト",
  clear: "削除",
  clearAria: "Anthropic API key を削除",
  activeLabel: "（使用中）",
  modelOption: "Claude Haiku 5.5（デフォルト・低価格で高速）",
  toast: "翻訳に失敗しました：Anthropic（Claude）の API キーが未設定です",
  toastAction: "設定を開く",
  cmdPage: "このページの翻訳を切り替え",
  cmdSubs: "YouTube の対訳字幕を切り替え",
  description: "原文の下に LLM 翻訳を表示します（対訳表示）",
  statusSaved: "保存しました（すでに開いているページでは、翻訳をいったんオフにしてからオンにすると新しい言語が反映されます）",
};
const CASES = [
  { locale: "en", expect: EN },
  { locale: "ja", expect: JA },
  { locale: "fr", expect: { ...EN, ui: "fr" } }, // no French catalog: falls back to en
];

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `: ${JSON.stringify(detail)}`}`);
};
const eq = (name, actual, expected) => check(name, actual === expected, { actual, expected });

async function drive({ locale, expect: x }) {
  const run = await launch({ name: `ui-locale-${locale}`, locale, settings: { anthropicApiKey: "" } });
  const tag = (s) => `[${locale}] ${s}`;
  try {
    // Chromium really runs in this UI language (not just Playwright's navigator.language).
    eq(tag("browser UI language"), await run.sw.evaluate(() => chrome.i18n.getUILanguage()), x.ui);
    eq(tag("manifest description"), await run.sw.evaluate(() => chrome.runtime.getManifest().description), x.description);

    // Keyboard-command descriptions (what chrome://extensions/shortcuts lists).
    const cmds = await run.sw.evaluate(async () => Object.fromEntries((await chrome.commands.getAll()).map((c) => [c.name, c.description])));
    eq(tag("command toggle-translation"), cmds["toggle-translation"], x.cmdPage);
    eq(tag("command toggle-subtitles"), cmds["toggle-subtitles"], x.cmdSubs);

    // Popup, attached to a real tab.
    const page = await run.newPage(run.fixture("article.html"));
    const popup = await run.openPopup();
    const ps = await popup.state();
    check(tag("popup toggle label"), ps.toggle.startsWith(x.toggle), ps.toggle);
    eq(tag("popup key warning"), ps.warn, x.warn);
    eq(tag("popup settings link"), await popup.text("#settings"), x.settings);
    eq(tag("popup shortcuts link"), await popup.text("#shortcuts"), x.shortcuts);
    eq(tag("popup <html lang>"), await popup.eval((w, doc) => doc.documentElement.lang), x.htmlLang);
    check(tag("popup model option"), (await popup.eval((w, doc) => [...doc.querySelectorAll("#model option")].map((o) => o.textContent))).includes(x.modelOption));
    await run.writeJson(`popup-${locale}.json`, ps);

    // Missing-key toast in the page, produced by the content script + service worker.
    await popup.click("#toggle");
    const s = await waitForPage(page, (st) => st.toast?.message, { label: "missing-key toast" });
    eq(tag("page toast message"), s.toast.message, x.toast);
    eq(tag("page toast action"), s.toast.action, x.toastAction);
    await run.screenshot(page, `toast-${locale}.png`);

    // Options page.
    const opt = await run.newPage(`chrome-extension://${run.extId}/options.html`);
    await opt.waitForFunction((t) => document.querySelector("h1").textContent === t, x.title);
    await run.screenshot(opt, `options-${locale}.png`, { fullPage: true });
    eq(tag("options <html lang>"), await opt.evaluate(() => document.documentElement.lang), x.htmlLang);
    eq(tag("options <title>"), await opt.title(), x.title);
    eq(tag("options save button"), await opt.locator('button[type="submit"]').textContent(), x.save);
    eq(tag("options test button"), await opt.locator("#test").textContent(), x.test);
    eq(tag("options clear button"), await opt.locator(".clear-key").first().textContent(), x.clear);
    eq(tag("options clear aria-label"), await opt.locator(".clear-key").first().getAttribute("aria-label"), x.clearAria);
    // The CSS pseudo-content "(in use)" comes from the catalog, not the stylesheet.
    eq(
      tag("options active-key marker"),
      await opt.evaluate(() => JSON.parse(getComputedStyle(document.querySelector("label.active"), "::after").content)),
      x.activeLabel,
    );
    check(tag("options model option"), (await opt.locator("#model option").allTextContents()).includes(x.modelOption));
    // Save shows the localized status, in the page's own language.
    await opt.locator('button[type="submit"]').click();
    await opt.waitForFunction(() => document.querySelector("#status").textContent !== "");
    eq(tag("options saved status"), await opt.locator("#status").textContent(), x.statusSaved);
    // Language-neutral guard: the Chinese UI must not leak into en/ja/fr.
    const leaked = await opt.evaluate(() =>
      [...document.querySelectorAll("h1, label, button, p")].map((e) => e.textContent).filter((t) => /儲存|目標語言|測試連線|清除/.test(t)),
    );
    check(tag("no Traditional Chinese UI text on the options page"), leaked.length === 0, leaked);
  } catch (err) {
    check(tag("journey ran to completion"), false, String(err?.stack ?? err));
  } finally {
    await run.writeJson("result.json", results.filter((r) => r.name.startsWith(`[${locale}]`)));
    await run.close();
  }
}

for (const c of CASES) await drive(c);

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `${failed.length} check(s) failed` : "all checks passed");
process.exit(failed.length ? 1 : 0);
