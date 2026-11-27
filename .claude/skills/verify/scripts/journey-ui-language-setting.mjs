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

// Fonts Chromium actually drew the element's glyphs with (CDP), not the CSS it was asked for:
// system-ui swallows CJK text in the browser locale's font, so a correct-looking stack can still
// draw Japanese with Traditional Chinese glyphs. Font names are checked on Windows only, where the
// stock fonts are known; elsewhere they are logged.
async function renderedFonts(page, expression) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const { result } = await cdp.send("Runtime.evaluate", { expression });
    const { nodeId } = await cdp.send("DOM.requestNode", { objectId: result.objectId });
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    return fonts.map((f) => f.familyName);
  } finally {
    await cdp.detach();
  }
}
const JA_FONT = /^(Yu Gothic|Meiryo|MS (P)?Gothic)/;
const checkFonts = (name, fonts, ok) =>
  process.platform === "win32" ? check(name, ok(fonts), fonts) : console.log(`INFO ${name}: ${JSON.stringify(fonts)}`);

const JA = {
  h1: "Open LLM Translator の設定",
  htmlLang: "ja",
  toggle: "このページを翻訳",
  autoOption: "ブラウザの言語に合わせる（繁體中文）",
  modelOption: "GPT-6 Luna（低価格で高速）",
  toastPrefix: "翻訳に失敗しました：",
  toastKeyInvalid: "API キーが無効です（401）",
  testFailPrefix: "失敗：",
};
const EN = {
  toastPrefix: "Translation failed: ",
  toastKeyInvalid: "API key is invalid (401)",
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
  const hintFonts = await renderedFonts(opt, 'document.querySelector(".hint")');
  checkFonts("[ja] options draw Japanese with a Japanese font, not JhengHei", hintFonts, (f) => f.some((n) => JA_FONT.test(n)) && !f.some((n) => n.includes("JhengHei")));
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

  // "Test connection" runs in the service worker (testConnection), which applies the setting itself.
  await opt.locator("#test").click();
  await opt.waitForFunction(() => document.querySelector("#status").textContent.includes("401"));
  const testText = await opt.locator("#status").textContent();
  check("[ja] test-connection status has the Japanese prefix", testText.startsWith(JA.testFailPrefix), testText);
  check("[ja] test-connection error text is Japanese", testText.includes(JA.toastKeyInvalid), testText);

  // --- popup and page toast in Japanese ----------------------------------------------
  const page = await run.newPage(run.fixture("article.html"));
  const popup = await run.openPopup();
  // Read the popup before opening another tab: focusing a new tab closes the popup on Linux.
  const ps = await popup.state();
  check("[ja] popup toggle", ps.toggle.startsWith(JA.toggle), ps.toggle);
  eq("[ja] popup <html lang>", await popup.eval((w, doc) => doc.documentElement.lang), JA.htmlLang);
  check("[ja] popup model options are Japanese", (await popup.eval((w, doc) => [...doc.querySelectorAll("#model option")].map((o) => o.textContent))).includes(JA.modelOption));
  // The popup is not a Playwright page, so no CDP: check that its Japanese fonts come before system-ui.
  const ffPopup = await popup.eval((w, doc) => w.getComputedStyle(doc.body).fontFamily);
  check("[ja] popup lists Japanese fonts ahead of system-ui", ffPopup.indexOf("Yu Gothic UI") >= 0 && ffPopup.indexOf("Yu Gothic UI") < ffPopup.indexOf("system-ui") && !ffPopup.includes("JhengHei"), ffPopup);
  await run.writeJson("popup-ja.json", ps);
  await popup.click("#toggle");
  const s = await waitForPage(page, (st) => st.toast?.message, { label: "401 toast (ja)" });
  check("[ja] page toast (content script) is Japanese", s.toast.message.startsWith(JA.toastPrefix), s.toast);
  // That text came from the service worker's t(), which applied the setting for this request.
  check("[ja] the service worker's error text is Japanese", s.toast.message.includes(JA.toastKeyInvalid), s.toast);
  await run.screenshot(page, "toast-ja.png");
  eq("[ja] toast is lang=ja", await page.evaluate(() => document.querySelector("llmt-toast").shadowRoot.querySelector(".box").lang), "ja");
  const toastFonts = await renderedFonts(page, 'document.querySelector("llmt-toast").shadowRoot.querySelector(".msg")');
  checkFonts("[ja] toast draws Japanese with a Japanese font, not JhengHei", toastFonts, (f) => f.some((n) => JA_FONT.test(n)) && !f.some((n) => n.includes("JhengHei")));

  // --- a tab injected before the language changed follows the service worker's language --
  // `page` still runs the content script that was told "ja". Switch to English, then let
  // new content fail: the toast's outer text must match the (English) service worker message.
  await opt.bringToFront();
  await opt.locator("#uiLanguage").selectOption("en");
  await opt.waitForFunction(() => document.documentElement.lang === "en");
  await page.bringToFront();
  await page.evaluate(() => {
    const p = document.createElement("p");
    p.textContent = "A freshly loaded paragraph that the extension has not translated yet, with enough words.";
    document.body.prepend(p);
  });
  const stale = await waitForPage(page, (st) => (st.toast?.message?.startsWith(EN.toastPrefix) ? st : null), {
    label: "401 toast after switching to English",
  });
  check("[stale tab] outer text and service worker text are both English", stale.toast.message.includes(EN.toastKeyInvalid), stale.toast);
  await opt.bringToFront();
  await opt.locator("#uiLanguage").selectOption("ja");
  await opt.waitForFunction((t) => document.querySelector("h1").textContent === t, JA.h1);

  // --- back to Follow browser ---------------------------------------------------------
  await opt.bringToFront();
  await opt.locator("#uiLanguage").selectOption("auto");
  await opt.waitForFunction((t) => document.querySelector("h1").textContent === t, ZH.h1);
  eq("[auto] options <html lang>", await opt.evaluate(() => document.documentElement.lang), ZH.htmlLang);
  eq("[auto] uiLanguage saved", (await run.storage()).uiLanguage, "auto");
  await run.screenshot(opt, "options-auto-under-zh-TW.png", { fullPage: true });
  const autoFonts = await renderedFonts(opt, 'document.querySelector(".hint")');
  checkFonts("[auto] options draw Traditional Chinese with Microsoft JhengHei UI, as before", autoFonts, (f) => f.includes("Microsoft JhengHei UI"));

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
