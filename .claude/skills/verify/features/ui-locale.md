# UI language

Every user-facing string (popup, options page, in-page toasts and error tooltips, YouTube subtitle notices, provider error messages, the manifest description and the keyboard-command descriptions) shows in English, Japanese, Simplified Chinese or Traditional Chinese according to the browser's UI language. Any other language shows English. The catalog is `public/_locales/{en,ja,zh_CN,zh_TW}/messages.json`; nothing is stored or chosen inside the extension. The one related default: a fresh profile's target language follows the UI language (`zh-TW/HK/MO` to zh-TW, `zh-CN/SG/zh` to zh-CN, `en*`, `ja`, `ko` to themselves, anything else to en). A stored `targetLang` always wins.

## Sub-features

- `loc-popup` the popup's labels, key warning, notes and shortcut suffix follow the language. `<html lang>` is the catalog's language (`en` for fr).
- `loc-options` the options page's title, labels, hints, buttons, clear-button `aria-label`, the "(in use)" marker (CSS pseudo-content fed from the catalog) and the save/test/delete status messages follow the language.
- `loc-toast` the in-page error toast (content script) and the provider error text inside it (service worker) follow the language.
- `loc-commands` `chrome.commands.getAll()` descriptions and the manifest description follow the language.
- `loc-fallback` a browser language with no catalog (fr) shows English everywhere. zh-HK gets zh_TW from Chrome (observed, not English; the journey asserts it), and other Chinese tags such as zh-SG get zh_CN (measured: `getUILanguage()` zh-SG gives page language zh-CN).
- `loc-default-target` a fresh profile's popup "Translate to" starts on the language that matches the UI language.
- Not localized, by design: the LLM prompt, `console.*` logs, and the language names in the target-language picker (each is shown in its own language).

## How to get to it (user POV)

- Set Chrome's display language (chrome://settings/languages) and restart Chrome. Then open the popup, the options page, `chrome://extensions/shortcuts`, or trigger an error toast.

## Driving it with harness.mjs

Preconditions:

- `launch({ name, locale })`. `locale` defaults to `"zh-TW"`, which is why every other journey keeps its Chinese assertions on any OS. Pass `"en"`, `"ja"`, `"fr"` and so on.
- Pass `settings: { targetLang: null }` to check the fresh-profile default (null means unstored).
- To see the missing-key warning and toast, also pass `settings: { anthropicApiKey: "" }`.

- **Prove the browser language first.** Run `run.sw.evaluate(() => chrome.i18n.getUILanguage())` and compare it with the locale you passed. A mismatch means the run is driving the OS language, not yours.
- **Popup.** Run `popup = await run.openPopup()` and compare `popup.state()` (`toggle`, `warn`, `note`) and `popup.text("#settings")` with the expected strings for the language.
- **Options.** Run `opt = await run.newPage(`chrome-extension://${run.extId}/options.html`)`, wait for `h1` to change from its English fallback (when proving ja or zh), then read button text, `aria-label`, and `getComputedStyle(document.querySelector("label.active"), "::after").content`.
- **Toast.** With no key, `popup.click("#toggle")` then `waitForPage(page, (s) => s.toast?.message)`. `toast.message` and `toast.action` carry the localized text.
- **Commands.** Run `run.sw.evaluate(async () => Object.fromEntries((await chrome.commands.getAll()).map((c) => [c.name, c.description])))`.
- **Proof.** `scripts/journey-ui-locale.mjs` does all of the above for en, ja, zh-CN and fr, plus zh-HK (one artifact dir each: `popup-<lang>.json`, `options-<lang>.png`, `toast-<lang>.png`, `result.json`).

## Gotchas

- Playwright's `locale` context option does not change `chrome.i18n` on Windows: it sets `navigator.language` and `Accept-Language` only, and the extension UI stays in the OS language. The harness passes `--lang=<locale>` as well, which does (checked on Windows), and sets `LANGUAGE` for Linux. On Linux, Chromium (`ui/base/l10n/l10n_util.cc`) reads the UI language from the environment variables `LANGUAGE`, `LC_ALL`, `LC_MESSAGES` and `LANG`, and `--lang` applies on Windows. The journey fails loudly on its first check if a platform ignores both. Do not drop them.
- `chrome.commands.getAll()` also returns an `_execute_action` entry with an empty description. Index by command name.
- The options page paints its English HTML fallback for a moment before `localizePage()` runs. Wait for a localized value, not for the page load.
- With target `en` on the English fixture nothing is sent for translation, so the journey picks another target before triggering the toast.
- `<html lang>` is the catalog's language, not the browser's: under fr it is `en`, because the text is English.
- Opening chrome://extensions/shortcuts is not drivable, so the command descriptions are proven through `chrome.commands.getAll()`, the same data that page lists.
