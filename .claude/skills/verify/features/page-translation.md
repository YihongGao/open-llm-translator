# Page translation

The user turns on translation for the current tab. Each visible text block gets an LLM translation inserted inside it, inline for short lines and as a new line for long ones, and the original stays in place. Blocks below the fold translate when scrolled into view. Buttons, code and `translate="no"` content are left alone. Toggling again hides the translations and shows only the original.

## Sub-features

- `page-on` turns translation on from the popup's 翻譯此頁 and translates the first screen.
- `page-layout` renders short segments inline (`llmt-inline`) and long ones as a block (`llmt-block`); single-link segments get the translation inside the link.
- `page-br-paragraphs` splits paragraphs written as text separated by `<br><br>` (no `<p>`, as on forum posts) into one segment each, with the translation between the two breaks. Journey: `journey-br-paragraphs.mjs` on `fixtures/forum-br.html`.
- `page-skip` leaves `<button>`, `<pre>` and `[translate=no]` untranslated and unsent.
- `page-lazy` translates off-screen blocks only after they scroll into view.
- `page-off` hides translations from the popup's 顯示原文 (`html.llmt-hidden`).
- `page-cache` serves repeated text from the IndexedDB cache (`data-llmt-source="cache"`) on re-translation.
- `page-shortcut` toggles with `Alt+A` (`⌥A` on macOS).

## How to get to it (user POV)

- Click the toolbar icon, then 翻譯此頁（Alt+A）. Click it again (now 顯示原文) to restore.
- Press `Alt+A` on the page.

## Driving it with harness.mjs

Preconditions:

- Default `launch({ name })` (mock `"ok"`, mock key, `zh-TW`).
- `doctor.mjs` exits 0.

- **Popup before.** Open the fixture and the popup. Call `page = await run.newPage(run.fixture("article.html"))`, `popup = await run.openPopup()`, then `popup.state()`. The result has `toggle` starting with `翻譯此頁` and `warn: null`.
- **Turn on.** Click the toggle with `popup.click("#toggle")`. The popup closes (`popup.isOpen()` is false). `waitForPage(page, s => s.done >= 5 && s.pending === 0)` resolves, and `byHost` has `title`, `intro`, `link-only`, `li-1` and `li-2` with `source: "api"` and text `〔譯〕<source>`.
- **Skipped elements.** Check the same state. `byHost` has no entry for `btn`, `code` or `no-translate`. `segmentsOf` over `run.calls` contains `Scheduling basics` and nothing matching `Do not translate|kubectl get pods|opts out`.
- **Lazy below the fold.** Before scrolling, `byHost` has no `far` entry. Call `page.locator("#far").scrollIntoViewIfNeeded()`, then wait for a `far` entry with `state: "done"`. `run.logs()` shows a second `[llmt] batch` line with 1 segment.
- **Turn off.** Run `page.bringToFront()`, then `popup = await run.openPopup()`. `popup.state().toggle` starts with `顯示原文`. Call `popup.click("#toggle")`. `pageState(page).hidden` is true and `page.locator("llmt-translation").first().isHidden()` is true.
- **Cache on re-toggle.** Toggle off, then on, from the popup. The translations reappear and `run.calls` gains no entry. Then run `page.reload()` and `page.bringToFront()`, and toggle on from the popup. All 6 first-screen `byHost` entries have `source: "cache"`, still with no new call.
- **Proof.** Run `node .claude/skills/verify/scripts/journey-page-translation.mjs`. It exits 0, and its artifact dir holds `01-popup-before.json`, `02-page-translated.{json,png}`, `03-after-scroll.png`, `04-popup-while-active.json`, `05-restored.png`, `06-segments-sent.json` and `result.json`.

## Gotchas

- `page-shortcut` cannot be driven. CDP key events do not reach Chromium's extension-command handling (`Alt+A` was tried: 0 translations). Report it as skipped.
- `dist-e2e/` has `<all_urls>`, so injection works even without the `activeTab` grant. A pass here does not prove the shipped permission model.
- The nav line (`Overview · Further reading`) is one inline segment across two links. Expect 6 first-screen segments, not 5.
- `li-1` renders as `block` and `li-2` as `inline`. Layout depends on rendered width, so assert layout only for elements whose length decides it clearly.
- The popup's `window.close()` runs after a successful toggle. Call `openPopup()` again for the next popup step rather than reusing the old handle.
- A fresh profile has an empty cache, so the first run is always `source: "api"`. Cache hits need a second toggle in the same `launch`.
