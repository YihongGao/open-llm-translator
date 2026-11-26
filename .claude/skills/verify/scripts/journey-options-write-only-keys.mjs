// Journey: a saved API key is never shown again on the options page and cannot
// be copied from it; an empty field keeps the stored key, a pasted one replaces it.
// Usage: node .claude/skills/verify/scripts/journey-options-write-only-keys.mjs
// Exit 0 = every check passed. Evidence in the printed artifacts dir.
import { launch } from "./harness.mjs";

const SAVED = "sk-ant-verify-saved-key-WXYZ";
const NEW = "sk-ant-verify-replaced-key-7788";
const run = await launch({ name: "options-write-only-keys", settings: { anthropicApiKey: SAVED } });
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
};
const stored = (key) => run.sw.evaluate(async (k) => (await chrome.storage.local.get(k))[k], key);
/** Every place the page could expose a key: input values, attributes, text. */
const pageLeaks = (page, secret) =>
  page.evaluate(
    (s) => [...document.querySelectorAll("input")].some((i) => i.value.includes(s)) || document.documentElement.outerHTML.includes(s),
    secret,
  );
const field = (page) => page.locator("#anthropicApiKey");

try {
  let page = await run.ctx.newPage();
  await page.goto(`chrome-extension://${run.extId}/options.html`);
  await page.waitForFunction(() => document.querySelector("#anthropicApiKey").placeholder.startsWith("已儲存"));
  await run.screenshot(page, "01-loaded.png", { fullPage: true });

  // 1. Loaded: the saved key is not in the page, only its last four characters.
  check("field is empty after load", (await field(page).inputValue()) === "");
  check("placeholder shows only the last four characters", (await field(page).getAttribute("placeholder")).includes("…WXYZ"), await field(page).getAttribute("placeholder"));
  check("saved key appears nowhere in the page", !(await pageLeaks(page, SAVED)));
  check("hint explains the key is not shown again", /儲存後不會再顯示完整的 key/.test(await page.locator("form").textContent()));

  // 2. Save with the field empty: the stored key stays.
  await page.locator("#targetLang").selectOption("ja");
  await page.getByRole("button", { name: "儲存" }).click();
  await page.waitForFunction(() => document.querySelector("#status").textContent.startsWith("已儲存"));
  check("empty field keeps the stored key", (await stored("anthropicApiKey")) === SAVED);
  check("other settings still save", (await stored("targetLang")) === "ja");

  // 3. 測試連線 with the field empty uses the stored key.
  await page.getByRole("button", { name: "測試連線" }).click();
  await page.waitForFunction(() => !document.querySelector("#status").textContent.includes("測試中"));
  const testStatus = await page.locator("#status").textContent();
  check("測試連線 succeeds with the stored key", testStatus.startsWith("成功："), testStatus);
  check("測試連線 made one API request", run.calls.filter((c) => c.provider === "anthropic").length === 1, run.calls.length);
  check("still no key in the page after testing", !(await pageLeaks(page, SAVED)));

  // 4. Paste a new key and save: it replaces the old one and the field empties.
  await field(page).fill(NEW);
  await page.getByRole("button", { name: "儲存" }).click();
  await page.waitForFunction(() => document.querySelector("#anthropicApiKey").value === "");
  await run.screenshot(page, "04-after-replace.png", { fullPage: true });
  check("pasted key replaces the stored one", (await stored("anthropicApiKey")) === NEW);
  check("field emptied after save", (await field(page).inputValue()) === "");
  check("placeholder shows the new key's last four", (await field(page).getAttribute("placeholder")).includes("…7788"));
  check("new key appears nowhere in the page", !(await pageLeaks(page, NEW)));

  // 5. Reopen the page: still nothing to copy.
  await page.close();
  page = await run.ctx.newPage();
  await page.goto(`chrome-extension://${run.extId}/options.html`);
  await page.waitForFunction(() => document.querySelector("#anthropicApiKey").placeholder.startsWith("已儲存"));
  await run.screenshot(page, "05-reopened.png", { fullPage: true });
  check("reopened page shows no key", (await field(page).inputValue()) === "" && !(await pageLeaks(page, NEW)));
} catch (err) {
  check("journey ran to completion", false, String(err?.stack ?? err));
} finally {
  await run.writeJson("result.json", results);
  await run.close();
}
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `${failed.length} check(s) failed` : "all checks passed");
process.exit(failed.length ? 1 : 0);
