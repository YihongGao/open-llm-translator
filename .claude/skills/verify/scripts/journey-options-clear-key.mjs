// Journey: delete a stored API key from the options page with the 清除 button.
// Usage: node .claude/skills/verify/scripts/journey-options-clear-key.mjs
// Exit 0 = every check passed. Evidence in the printed artifacts dir.
import { launch } from "./harness.mjs";

const run = await launch({
  name: "options-clear-key",
  settings: { anthropicApiKey: "sk-ant-verify-mock", openaiApiKey: "sk-verify-openai" },
});
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
};
const stored = (key) => run.sw.evaluate(async (k) => (await chrome.storage.local.get(k))[k], key);

try {
  const page = await run.ctx.newPage();
  await page.goto(`chrome-extension://${run.extId}/options.html`);
  const clear = (name) => page.getByRole("button", { name: `清除 ${name} API key` });
  await clear("Anthropic").waitFor({ timeout: 5000 });
  await page.locator("#anthropicApiKey").waitFor();
  // Load is async: wait until the stored key has filled the field.
  await page.waitForFunction(() => document.querySelector("#anthropicApiKey").value !== "");
  await run.screenshot(page, "01-options-loaded.png", { fullPage: true });

  check("Gemini clear button disabled (no stored key)", await clear("Gemini").isDisabled());
  check("Anthropic and OpenAI clear buttons enabled", (await clear("Anthropic").isEnabled()) && (await clear("OpenAI").isEnabled()));

  // Unsaved edit elsewhere must survive a clear and must not be saved.
  await page.locator("#geminiApiKey").fill("unsaved-gemini");

  // Cancel: nothing changes.
  let dialogMessage = null;
  page.once("dialog", (d) => {
    dialogMessage = d.message();
    void d.dismiss();
  });
  await clear("Anthropic").click();
  await page.waitForTimeout(300);
  check("confirm names the provider", /Anthropic/.test(dialogMessage ?? ""), dialogMessage);
  check("dismiss keeps the stored key", (await stored("anthropicApiKey")) === "sk-ant-verify-mock");
  check("dismiss keeps the field value", (await page.locator("#anthropicApiKey").inputValue()) === "sk-ant-verify-mock");
  check("dismiss leaves button enabled", await clear("Anthropic").isEnabled());

  // Accept: only that key goes.
  page.once("dialog", (d) => void d.accept());
  await clear("Anthropic").click();
  await page.waitForFunction(() => document.querySelector("#status").textContent !== "");
  const keys = await run.sw.evaluate(() => chrome.storage.local.get(null));
  await run.writeJson("02-storage-after-clear-keys.json", Object.keys(keys));
  await run.screenshot(page, "02-options-after-clear.png", { fullPage: true });
  check("anthropicApiKey removed from storage", !("anthropicApiKey" in keys), Object.keys(keys));
  check("field emptied", (await page.locator("#anthropicApiKey").inputValue()) === "");
  check("status says deleted", /已刪除.*Anthropic/.test(await page.locator("#status").textContent()), await page.locator("#status").textContent());
  check("openaiApiKey intact", keys.openaiApiKey === "sk-verify-openai");
  check("unsaved Gemini edit not saved", !("geminiApiKey" in keys) || keys.geminiApiKey === "");
  check("unsaved Gemini edit still in the field", (await page.locator("#geminiApiKey").inputValue()) === "unsaved-gemini");
  check("Anthropic clear button now disabled", await clear("Anthropic").isDisabled());
  check("OpenAI clear button still enabled", await clear("OpenAI").isEnabled());

  // Popup warns about the missing key for an Anthropic model.
  const article = await run.newPage(run.fixture("article.html"));
  const popup = await run.openPopup();
  const state = await popup.state();
  await run.writeJson("03-popup-state.json", state);
  check("popup shows missing-key warning", /Anthropic/.test(state.warn ?? ""), state);
  void article;
} catch (err) {
  check("journey ran to completion", false, String(err?.stack ?? err));
} finally {
  await run.writeJson("result.json", results);
  await run.close();
}
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `${failed.length} check(s) failed` : "all checks passed");
process.exit(failed.length ? 1 : 0);
