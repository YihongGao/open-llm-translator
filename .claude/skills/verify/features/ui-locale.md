# UI language

Every user-facing string (popup, options page, in-page toasts and error tooltips, YouTube subtitle notices, provider error messages, the manifest description and the keyboard-command descriptions) shows in English, Japanese, Simplified Chinese or Traditional Chinese according to the UI language setting on the options page: **Follow browser** (the default, `uiLanguage: "auto"`) uses the browser's UI language, and any other language shows English; or the user picks English, 日本語, 简体中文 or 繁體中文 and that wins over the browser. The catalog is `public/_locales/{en,ja,zh_CN,zh_TW}/messages.json`; `t()` in `src/shared/i18n.ts` resolves from it itself, because `chrome.i18n.getMessage` cannot switch language at run time. The one related default: a fresh profile's target language follows the UI language (`zh-TW/HK/MO` to zh-TW, `zh-CN/SG/zh` to zh-CN, `en*`, `ja`, `ko` to themselves, anything else to en). A stored `targetLang` always wins.

## Sub-features

- `loc-popup` the popup's labels, key warning, notes and shortcut suffix follow the language. `<html lang>` is the catalog's language (`en` for fr).
- `loc-options` the options page's title, labels, hints, buttons, clear-button `aria-label`, the "(in use)" marker (CSS pseudo-content fed from the catalog) and the save/test/delete status messages follow the language.
- `loc-toast` the in-page error toast (content script) and the provider error text inside it (service worker) follow the language.
- `loc-commands` `chrome.commands.getAll()` descriptions and the manifest description follow the *browser* language only: Chrome reads them itself, so the setting cannot change them (the options page says so).
- `loc-setting` the options page's UI language select (Follow browser / English / 日本語 / 简体中文 / 繁體中文) applies and saves on change, re-localizes the page in place (typed key fields and unsaved model picks survive), and the popup, page toast and service-worker error text follow it. Proven by `scripts/journey-ui-language-setting.mjs`.
- `loc-fidelity` with Follow browser, `t()` returns exactly what `chrome.i18n.getMessage` returns for every key (substitutions containing `$` included). Proven by `scripts/journey-ui-locale-fidelity.mjs`.
- `loc-fallback` a browser language with no catalog (fr) shows English everywhere. zh-HK gets zh_TW from Chrome (observed, not English; the journey asserts it), and other Chinese tags such as zh-SG get zh_CN (measured: `getUILanguage()` zh-SG gives page language zh-CN).
- `loc-default-target` a fresh profile's popup "Translate to" starts on the language that matches the UI language.
- Not localized, by design: the LLM prompt, `console.*` logs, and the language names in the target-language picker (each is shown in its own language).

## How to get to it (user POV)

- Options page, **UI language** select. Or leave it on Follow browser and set Chrome's display language (chrome://settings/languages), then restart Chrome. Then open the popup, the options page, `chrome://extensions/shortcuts`, or trigger an error toast.

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
- **Setting.** Pass `settings: { uiLanguage: "ja" }` to start with a choice stored, or drive the select: `opt.locator("#uiLanguage").selectOption("ja")`, then wait for `h1` to change. `run.storage().uiLanguage` is `"ja"` right after the change, with no Save click. Under `mock: "401"`, `popup.click("#toggle")` gives a page toast whose text comes from the service worker's `t()`; the content script gets the language in the toggle message.
- **Proof.** `scripts/journey-ui-locale.mjs` does all of the above for en, ja, zh-CN and fr, plus zh-HK (one artifact dir each: `popup-<lang>.json`, `options-<lang>.png`, `toast-<lang>.png`, `result.json`). `scripts/journey-ui-language-setting.mjs` proves the setting under a zh-TW browser (`options-ja-under-zh-TW.png`, `toast-ja.png`). `scripts/journey-ui-locale-fidelity.mjs` compares `t()` with `chrome.i18n.getMessage` for every key in six browser languages.

## Gotchas

- Playwright's `locale` context option does not change `chrome.i18n` on Windows: it sets `navigator.language` and `Accept-Language` only, and the extension UI stays in the OS language. The harness passes `--lang=<locale>` as well, which does (checked on Windows), and sets `LANGUAGE` for Linux. On Linux, Chromium (`ui/base/l10n/l10n_util.cc`) reads the UI language from the environment variables `LANGUAGE`, `LC_ALL`, `LC_MESSAGES` and `LANG`, and `--lang` applies on Windows. The journey fails loudly on its first check if a platform ignores both. Do not drop them.
- `chrome.commands.getAll()` also returns an `_execute_action` entry with an empty description. Index by command name.
- The options page paints its English HTML fallback for a moment before `localizePage()` runs. Wait for a localized value, not for the page load. With a stored choice the page localizes twice, first in the browser's language and then in the choice, so wait for the choice's text. In 8 headless loads the first paint already showed the choice (storage answers in about 10 ms).
- With target `en` on the English fixture nothing is sent for translation, so the journey picks another target before triggering the toast.
- `<html lang>` is the catalog's language, not the browser's: under fr it is `en`, because the text is English.
- Opening chrome://extensions/shortcuts is not drivable, so the command descriptions are proven through `chrome.commands.getAll()`, the same data that page lists.
