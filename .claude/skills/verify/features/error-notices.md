# Error notices

When translation fails for the whole page (missing key, invalid key, rate limit, network), the page shows one toast at the top right with the reason and, when the fix is in settings, an 開啟設定 button. Each failed segment shows a ⚠ marker. Clicking it shows that segment's reason. After fixing the cause, turning translation off and on again retries the failed segments.

## Sub-features

- `err-no-key` with no key for the selected model's provider, the popup warns before translating and the page shows the toast. No API call is made.
- `err-invalid-key` a 401 from the provider shows `Anthropic API key 無效（401），請到設定頁確認`.
- `err-rate-limit` a 429 shows `翻譯失敗：超過速率限制（429），稍後再試` with no 開啟設定 button.
- `err-marker` each failed segment renders `⚠` (`llmt-translation.llmt-error`, reason in `data-llmt-error`). Clicking it shows the toast for that reason.
- `err-open-settings` the toast's 開啟設定 opens the options page.
- `err-retry` toggling off and on after a fix clears the toast and retries the failed segments.

## How to get to it (user POV)

- Translate any page with no key set, or with a bad key.
- Click a ⚠ next to a paragraph.
- Click 開啟設定 in the toast, or in the popup's yellow banner.

## Driving it with harness.mjs

Preconditions:

- `launch({ name, settings: { anthropicApiKey: "" } })` for `err-no-key`. Use `launch({ name, mock: "401" })` for `err-invalid-key` and `launch({ name, mock: "429" })` for `err-rate-limit`.

- **No-key popup warning.** Open the fixture and the popup with `run.newPage(run.fixture())` and `run.openPopup()`. `state().warn` is `"尚未設定 Anthropic（Claude） 的 API key。"`.
- **No-key toast.** Click `popup.click("#toggle")`, then `waitForPage(page, s => s.toast !== null)`. The toast is `{ message: "翻譯失敗：尚未設定 Anthropic（Claude） 的 API key", detail: "修正後，關閉再開啟翻譯即可重試失敗的段落。", action: "開啟設定" }`, `errors` is 6 and `run.calls.length` is 0.
- **Invalid key.** With `mock: "401"`, toggle from the popup and wait for the toast. `toast.message` is `"翻譯失敗：Anthropic API key 無效（401），請到設定頁確認"`, and every `byHost` entry has `state: "error"` and `text: "⚠"`.
- **Rate limit.** With `mock: "429"`, toggle from the popup and wait for the toast with `{ timeout: 20000 }`. The toast is `{ message: "翻譯失敗：超過速率限制（429），稍後再試", action: null }`, and `run.calls.length` is 3 (the first try plus the SDK's 2 retries).
- **Marker detail.** Close the toast, then click the first marker with `page.locator("llmt-translation.llmt-error").first().click()`. The toast reappears with that segment's `data-llmt-error` text.
- **Open settings.** In the no-key run, click the toast's action. A new tab at `chrome-extension://<extId>/options.html` is added to `run.ctx.pages()`.
- **Retry after fix.** In that options tab, run `opt.locator("#anthropicApiKey").fill("sk-ant-verify-fixed")` and click role button `儲存`. Under `mock: "401"` you cannot fix the key, so use the no-key launch for this step. Then run `page.bringToFront()` and toggle off, then on, from the popup. `pageState` has `toast: null`, `errors: 0` and `done >= 6`, and `run.calls.length` is 1.
- **Proof.** Save the popup state, the toast JSON, a screenshot showing the toast and ⚠ markers, and `run.calls.length` for each sub-feature.

## Gotchas

- The toast lives in a shadow root. `document.querySelector(".msg")` finds nothing. Use `pageState().toast` or a Playwright locator chained from `llmt-toast`.
- The toast's action is reached with `page.locator("llmt-toast").locator(".action").click()`. Playwright locators pierce the open shadow root.
- The Anthropic SDK retries 429 and 5xx (`maxRetries: 2`, about 2 s with backoff) before the error surfaces. Raise the `waitForPage` timeout, and expect 3 entries in `run.calls`, not 1.
- The key the harness writes by default is a fake `sk-ant-verify-mock`. Under `mock: false` it produces a real 401 from Anthropic, which is a valid `err-invalid-key` run but costs nothing only because the request fails.
