// Journey: the UI language setting on the options page. Under a zh-TW browser, choosing 日本語
// turns the options page Japanese at once (typed key and unsaved model pick survive), and the
// popup, the in-page toast (content script) and the error text produced by the service worker
// (mock 401) follow. Back to "Follow browser" everything is Traditional Chinese again.
// Usage: node .claude/skills/verify/scripts/journey-ui-language-setting.mjs   (after npm run build:e2e)
// Exit 0 = every check passed. The mock API answers 401; no real API is called.
import { launch, waitForPage } from "./harness.mjs";

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `: ${JSON.stringify(detail)}`}`);
};
const eq = (name, actual, expected) => check(name, actual === expected, { actual, expected });

const JA = {
  h1: "Open LLM Translator の設定",
  htmlLang: "ja",
  toggle: "このページを翻訳",
  autoOption: "ブラウザの言語に合わせる（繁體中文）",
  modelOption: "GPT-6 Luna（低価格で高速）",
  toastPrefix: "翻訳に失敗しました：",
  toastKeyInvalid: "API キーが無効です（401）",
};
const ZH = {
  h1: "Open LLM Translator 設定",
  htmlLang: "zh-TW",
  toggle: "翻譯此頁",
  autoOption: "跟隨瀏覽器（繁體中文）",
  toastPrefix: "翻譯失敗：",
  toastKeyInvalid: "API key 無效（401）",
};

const run = await launch({ name: "ui-language-setting", locale: "zh-TW", mock: "401" });
try {
  eq("browser UI language", await run.sw.evaluate(() => chrome.i18n.getUILanguage()), "zh-TW");

  // --- options page: pick 日本語 ------------------------------------------------------
  const opt = await run.newPage(`chrome-extension://${run.extId}/options.html`);
  await opt.waitForFunction((t) => document.querySelector("h1").textContent === t, ZH.h1);
  eq("[zh-TW] the select starts on Follow browser", await opt.locator("#uiLanguage").inputValue(), "auto");
  eq("[zh-TW] first option says what Follow browser means", await opt.locator("#uiLanguage option").first().textContent(), ZH.autoOption);
  eq("[zh-TW] the other options are endonyms", (await opt.locator("#uiLanguage option").allTextContents()).slice(1).join(","), "English,日本語,简体中文,繁體中文");

  // Typed-but-unsaved edits must survive the language change.
  await opt.locator("#openaiApiKey").fill("sk-typed-not-saved");
  await opt.locator("#model").selectOption("gpt-6-luna");
  await opt.locator("#uiLanguage").selectOption("ja");
  await opt.waitForFunction((t) => document.querySelector("h1").textContent === t, JA.h1);
  await run.screenshot(opt, "options-ja-under-zh-TW.png", { fullPage: true });
  eq("[ja] options <html lang>", await opt.evaluate(() => document.documentElement.lang), JA.htmlLang);
  eq("[ja] options <title>", await opt.title(), JA.h1);
  eq("[ja] the select shows 日本語", await opt.locator("#uiLanguage").inputValue(), "ja");
  eq("[ja] Follow browser option is relabelled", await opt.locator("#uiLanguage option").first().textContent(), JA.autoOption);
  eq("[ja] typed API key survived", await opt.locator("#openaiApiKey").inputValue(), "sk-typed-not-saved");
  eq("[ja] unsaved model pick survived", await opt.locator("#model").inputValue(), "gpt-6-luna");
  check("[ja] model labels were regenerated in Japanese", (await opt.locator("#model option").allTextContents()).includes(JA.modelOption));
  eq("[ja] model options were replaced, not appended", await opt.locator("#model option").count(), 9);
  check("[ja] the active-key marker follows the language", (await opt.evaluate(() => JSON.parse(getComputedStyle(document.querySelector("label.active"), "::after").content))) === "（使用中）");
  const saved = await run.storage();
  eq("[ja] uiLanguage saved at once", saved.uiLanguage, "ja");
  check("[ja] the typed key was not saved by the language change", !saved.openaiApiKey, saved);
  eq("[ja] model not saved by the language change", saved.model, "claude-haiku-5-5");
  await opt.locator("#model").selectOption("claude-haiku-5-5");
  await opt.locator("#openaiApiKey").fill("");

  // --- popup and page toast in Japanese ----------------------------------------------
  const page = await run.newPage(run.fixture("article.html"));
  const popup = await run.openPopup();
  // Read the popup before opening another tab: focusing a new tab closes the popup on Linux.
  const ps = await popup.state();
  check("[ja] popup toggle", ps.toggle.startsWith(JA.toggle), ps.toggle);
  eq("[ja] popup <html lang>", await popup.eval((w, doc) => doc.documentElement.lang), JA.htmlLang);
  check("[ja] popup model options are Japanese", (await popup.eval((w, doc) => [...doc.querySelectorAll("#model option")].map((o) => o.textContent))).includes(JA.modelOption));
  await run.writeJson("popup-ja.json", ps);
  await popup.click("#toggle");
  const s = await waitForPage(page, (st) => st.toast?.message, { label: "401 toast (ja)" });
  check("[ja] page toast (content script) is Japanese", s.toast.message.startsWith(JA.toastPrefix), s.toast);
  // That text came from the service worker's t(), which applied the setting for this request.
  check("[ja] the service worker's error text is Japanese", s.toast.message.includes(JA.toastKeyInvalid), s.toast);
  await run.screenshot(page, "toast-ja.png");

  // --- back to Follow browser ---------------------------------------------------------
  await opt.bringToFront();
  await opt.locator("#uiLanguage").selectOption("auto");
  await opt.waitForFunction((t) => document.querySelector("h1").textContent === t, ZH.h1);
  eq("[auto] options <html lang>", await opt.evaluate(() => document.documentElement.lang), ZH.htmlLang);
  eq("[auto] uiLanguage saved", (await run.storage()).uiLanguage, "auto");
  await run.screenshot(opt, "options-auto-under-zh-TW.png", { fullPage: true });

  const page2 = await run.newPage(run.fixture("article.html"));
  const popup2 = await run.openPopup();
  const ps2 = await popup2.state();
  check("[auto] popup toggle is Traditional Chinese", ps2.toggle.startsWith(ZH.toggle), ps2.toggle);
  await popup2.click("#toggle");
  const s2 = await waitForPage(page2, (st) => st.toast?.message, { label: "401 toast (zh-TW)" });
  check("[auto] page toast is Traditional Chinese", s2.toast.message.startsWith(ZH.toastPrefix) && s2.toast.message.includes(ZH.toastKeyInvalid), s2.toast);
  await run.screenshot(page2, "toast-auto.png");
} catch (err) {
  check("journey ran to completion", false, String(err?.stack ?? err));
} finally {
  await run.writeJson("result.json", results);
  await run.close();
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `${failed.length} check(s) failed` : "all checks passed");
process.exit(failed.length ? 1 : 0);
