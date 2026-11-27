# Options page

The settings page where the user enters an API key per provider, picks the model and target language, saves, and checks the setup with 測試連線, which translates one sample sentence through the selected provider.

## Sub-features

- `opt-load` model and language show the stored settings when the page opens. Key fields stay empty: a saved key is never put back into the page; its placeholder reads `已儲存（…WXYZ），要更換請貼上新的 key` (last four characters, only for keys of 16+ characters), or the example format (`sk-ant-...`) when none is stored.
- `opt-save` 儲存 persists model, language and only the keys typed into their fields (trimmed); an empty key field keeps the stored key. Fields empty after saving. Shows 已儲存（已開啟的頁面需重新切換翻譯才會套用新語言）.
- `opt-clear` 清除 next to a key deletes that stored key after a confirm. Proven by `scripts/journey-options-clear-key.mjs`.
- `opt-test` 測試連線 saves first, then shows `成功：<translated sample>` or `失敗：<reason>`.
- `opt-image-model` 圖片翻譯 model (`#imageModel`) lists the Anthropic models only, shows the stored `imageModel` (default `claude-sonnet-5-5`), and 儲存 persists it. Its effect on the request is proven by `scripts/journey-image-translation.mjs`.
- `opt-active-key` the label of the key field the selected model uses is marked active.
- `opt-ui-language` the UI language select applies and saves on change, without 儲存, and re-localizes the page in place. See [ui-locale.md](./ui-locale.md) (`loc-setting`).

## How to get to it (user POV)

- Right-click the toolbar icon, then 選項.
- Click ⚙ 設定 in the popup.
- Click 開啟設定 in the popup's key warning or in a page toast.

## Driving it with harness.mjs

Preconditions:

- Default `launch({ name })`. The page is a normal tab, so use Playwright locators.

- **Open.** Run `opt = await run.newPage(`chrome-extension://${run.extId}/options.html`)`. `#anthropicApiKey` is empty and its placeholder starts with `已儲存` once loading finishes (wait for that, not for a value), `#model` is `claude-haiku-5-5` and `#targetLang` is `zh-TW`. The popup entry is `popup.click("#settings")`, after which a new options tab appears in `run.ctx.pages()`.
- **Test connection.** Run `opt.getByRole("button", { name: "測試連線" }).click()`, then wait until `#status` no longer contains `測試中`. `#status` reads `成功：〔譯〕Kubernetes is an open source container orchestration engine.` and `run.calls` has one request.
- **Save.** Run `opt.locator("#targetLang").selectOption("ja")`, then `opt.getByRole("button", { name: "儲存" }).click()`. `#status` reads `已儲存（已開啟的頁面需重新切換翻譯才會套用新語言）` and `run.storage().targetLang` is `"ja"`.
- **Saved settings take effect.** Translate the fixture from the popup. The new request's system prompt ends with `Translate every segment into Japanese (日本語).`
- **Test failure.** In a `launch({ name, mock: "401" })` run, click 測試連線. `#status` starts with `失敗：`.
- **Proof.** Save a screenshot of the options page after each action, `#status` text, `run.storage()`, and the relevant `run.calls` entry.

## Gotchas

- The harness keeps `popup.html#verify-helper` open as a tab (`run.helper`) to reach the real popup. Do not drive or close it. It is deliberately not an options tab, because `chrome.runtime.openOptionsPage()` focuses an existing options tab instead of opening a new one.
- Every 開啟設定 / ⚙ 設定 entry calls `openOptionsPage()`. A second click while an options tab exists focuses that tab, so the page count does not grow. Close it or assert on the focused tab's URL.
- 測試連線 saves the form before testing, so a test run also mutates settings. Read `run.storage()` after it, not before.
- Key inputs are write-only `type=password` fields. Assert the stored value through `run.storage()` or `run.sw`; the input never holds the saved key. `scripts/journey-options-write-only-keys.mjs` proves the key appears nowhere in the page's DOM.
- Options settings apply to pages translated afterwards. An already-translated page keeps its language until it is toggled again.
