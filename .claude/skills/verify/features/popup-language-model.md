# Popup language and model

From the toolbar popup the user picks the target language and the model. A language change re-translates a page that is already translated, right away. A model change is saved and used for later segments, and the popup warns when that model's provider has no API key.

## Sub-features

- `lang-switch` changing 翻譯成 saves `targetLang` and re-translates the active, translated page into the new language.
- `lang-persist` the choice survives reopening the popup and applies to the next page.
- `model-switch` changing Model saves `model` and shows 新的 model 會用在之後翻譯的段落。
- `model-key-warn` picking a model whose provider has no key shows the #warn banner naming that provider, with 開啟設定.

## How to get to it (user POV)

- Click the toolbar icon, then use the 翻譯成 dropdown.
- Click the toolbar icon, then use the Model dropdown (grouped by provider).

## Driving it with harness.mjs

Preconditions:

- Default `launch({ name })`. The fixture page is translated (see [page-translation](./page-translation.md) `page-on`), and `waitForPage(page, s => s.done >= 5)` holds.

- **Switch language.** Reopen the popup and pick Korean. Run `popup = await run.openPopup()`, note `n = run.calls.length`, then `popup.select("#targetLang", "ko")`. Within ~1.5 s, `run.calls.length` is `n + 1`. That call's `body.system[0].text` ends with `Translate every segment into Korean (한국어).`, `pageState(page)` returns to `done >= 6`, and `run.storage().targetLang` is `"ko"`.
- **Persisted.** Reopen the popup with `run.openPopup()`. `state().targetLang` is `"ko"`.
- **Switch model.** Pick an OpenAI model with `popup.select("#model", "gpt-6-luna")`. `state()` shows `model: "gpt-6-luna"`, `note: "新的 model 會用在之後翻譯的段落。"` and `warn: "尚未設定 OpenAI（GPT） 的 API key。"`. `run.storage().model` is `"gpt-6-luna"`.
- **Warning action.** Click `popup.click("#warnSettings")`. A tab at `chrome-extension://<extId>/options.html` is opened, or focused if one already exists, and it is the last entry of `run.ctx.pages()`.
- **Proof.** Save `popup.state()` before and after each change, `run.storage()`, and the system-prompt last line of the newest `run.calls` entry with `run.writeJson`. Take a page screenshot after the re-translation.

## Gotchas

- A `<select>` change does not close the popup. `run.openPopup()` closes an open popup first, because `chrome.action.openPopup()` rejects with "Failed to open popup" while one is showing.
- The mock prefixes every language with `〔譯〕`, so the rendered text cannot prove the language. Assert the system prompt's `Translate every segment into …` line in `run.calls`.
- With an OpenAI or Gemini model selected, translating fails with the missing-key toast (no key in the default settings). If a key is set, the request is aborted, because only Anthropic is mocked. Switch back to a `claude-*` model before driving translation.
- The options page's 儲存 does not re-translate open pages (its status says so). Only the popup's language change does.
