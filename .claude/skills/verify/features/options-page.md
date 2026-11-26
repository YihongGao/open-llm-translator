# Options page

The settings page where the user enters an API key per provider, picks the model and target language, saves, and checks the setup with 測試連線, which translates one sample sentence through the selected provider.

## Sub-features

- `opt-load` fields show the stored settings when the page opens.
- `opt-save` 儲存 persists model, language and all three keys (trimmed) and shows 已儲存（已開啟的頁面需重新切換翻譯才會套用新語言）.
- `opt-test` 測試連線 saves first, then shows `成功：<translated sample>` or `失敗：<reason>`.
- `opt-active-key` the label of the key field the selected model uses is marked active.

## How to get to it (user POV)

- Right-click the toolbar icon, then 選項.
- Click ⚙ 設定 in the popup.
- Click 開啟設定 in the popup's key warning or in a page toast.

## Driving it with harness.mjs

Preconditions:

- Default `launch({ name })`. The page is a normal tab, so use Playwright locators.

- **Open.** Run `opt = await run.newPage(`chrome-extension://${run.extId}/options.html`)`. `#anthropicApiKey` has a value of 18 characters (the mock key), `#model` is `claude-haiku-5-5` and `#targetLang` is `zh-TW`. The popup entry is `popup.click("#settings")`, after which a new options tab appears in `run.ctx.pages()`.
- **Test connection.** Run `opt.getByRole("button", { name: "測試連線" }).click()`, then wait until `#status` no longer contains `測試中`. `#status` reads `成功：〔譯〕Kubernetes is an open source container orchestration engine.` and `run.calls` has one request.
- **Save.** Run `opt.locator("#targetLang").selectOption("ja")`, then `opt.getByRole("button", { name: "儲存" }).click()`. `#status` reads `已儲存（已開啟的頁面需重新切換翻譯才會套用新語言）` and `run.storage().targetLang` is `"ja"`.
- **Saved settings take effect.** Translate the fixture from the popup. The new request's system prompt ends with `Translate every segment into Japanese (日本語).`
- **Test failure.** In a `launch({ name, mock: "401" })` run, click 測試連線. `#status` starts with `失敗：`.
- **Proof.** Save a screenshot of the options page after each action, `#status` text, `run.storage()`, and the relevant `run.calls` entry.

## Gotchas

- The harness keeps `popup.html#verify-helper` open as a tab (`run.helper`) to reach the real popup. Do not drive or close it. It is deliberately not an options tab, because `chrome.runtime.openOptionsPage()` focuses an existing options tab instead of opening a new one.
- Every 開啟設定 / ⚙ 設定 entry calls `openOptionsPage()`. A second click while an options tab exists focuses that tab, so the page count does not grow. Close it or assert on the focused tab's URL.
- 測試連線 saves the form before testing, so a test run also mutates settings. Read `run.storage()` after it, not before.
- Key inputs are `type=password`. Assert the stored value through `run.storage()`, which shows masked lengths, not the input's rendered text.
- Options settings apply to pages translated afterwards. An already-translated page keeps its language until it is toggled again.
