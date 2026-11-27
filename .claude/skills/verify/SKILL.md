---
name: verify
description: Drive the Open LLM Translator Chrome extension (MV3) in a real Playwright Chromium to prove user-facing behavior — toolbar popup, in-page bilingual translation, error toasts, options page, YouTube subtitles — with the LLM API mocked at the network boundary (free) or real (costs money). Use after changing anything under src/ or public/, before claiming a feature works, or to reproduce a bug the way a user hits it.
---

# Verify the extension

The user surfaces are Chrome UI, not a server: the **toolbar popup** (`popup.html`), the **page itself** (translations injected as `<llmt-translation>` nodes, error toast as `<llmt-toast>` with an open shadow root), the **options page** (`options.html`), and **YouTube's player** (subtitle overlay). The harness loads the unpacked E2E build into Playwright's Chromium and drives each surface.

Feature recipes live in [features/README.md](features/README.md). Read the index, then the file for the feature you are proving.

## Launch

1. Build: `npm run build:e2e`. This writes `dist-e2e/`, the normal build plus `<all_urls>` host access. Never ship it.
2. Run a drive script that imports the harness. Drive scripts must live in `.claude/skills/verify/scripts/` so Node resolves `playwright` from the repo's `node_modules`:

```js
import { launch, waitForPage, pageState, segmentsOf, MOCK_PREFIX } from "./harness.mjs";
const run = await launch({ name: "my-check" });           // mock: "ok" by default
try {
  const page = await run.newPage(run.fixture("article.html")); // opens tab + makes it active
  const popup = await run.openPopup();                       // the real toolbar popup for that tab
  await popup.click("#toggle");                              // 翻譯此頁
  const s = await waitForPage(page, (s) => s.done >= 5 && s.pending === 0);
  await run.screenshot(page, "translated.png");
} finally {
  await run.close();                                         // prints the artifacts dir
}
```

Run it with `node .claude/skills/verify/scripts/<file>.mjs`. Set `HEADED=1` to watch.

`launch()` is ready when it returns: the service worker is up, settings are written to `chrome.storage.local`, the mock is routed, and a helper tab (`popup.html#verify-helper`, used to reach the real popup) is open. It refuses to start if `dist-e2e/` is missing or older than `src/` or `public/`.

`launch(opts)`:
- `name` (required): names the artifact dir.
- `mock`:
  - `"ok"` (default): Anthropic answers every segment `[n] text` with `〔譯〕text`.
  - `"401"`: invalid key.
  - `"429"`: rate limit.
  - `false`: real API. This costs money and needs a real key passed in `settings`. Ask the user before using it.
- `locale` (default `"zh-TW"`): the browser UI language that `chrome.i18n` follows, set with `--lang`. Pass `"en"`, `"ja"` or any tag. See [features/ui-locale.md](features/ui-locale.md).
- `settings`: merged over the default `{ anthropicApiKey: "sk-ant-verify-mock", model: "claude-haiku-5-5", targetLang: "zh-TW" }`. Use `{ anthropicApiKey: "" }` for the missing-key path.

OpenAI and Gemini requests are never mocked. They are aborted and logged in `run.calls` as `unmocked`. Prove UI paths with an Anthropic model.

The `run` object:
- `run.newPage(url)`: opens `url` in a new tab and makes it the active tab.
- `run.openPopup()`: opens the popup and returns `{ state(), click(sel), select(sel, value), text(sel), eval(fn, arg), isOpen() }`. `state()` returns the toggle, subtitles button, warning, note, language, and model as the user sees them.
- `pageState(page)`: returns `{ hidden, done, pending, errors, byHost[], toast }`. `byHost[].host` is the id of the closest ancestor with an id, so fixture ids are the handles.
- `waitForPage(page, pred, { timeout, label })`: waits until `pred(pageState)` holds.
- `run.calls`: every mocked API request body. `segmentsOf(body)` gives the source lines a request sent.
- `run.storage()`: `chrome.storage.local`, with keys masked.
- `run.logs()`: the service worker's `[llmt]` batch lines.
- `run.sw`: the service worker. Use it only for setup or inspection, never as the user action.
- `run.extId`, `run.fixtureBase`, `run.artifacts`.

**Isolation:** every launch gets its own temp profile, its own copy of `dist-e2e/`, and a random fixture port. Runs can go in parallel, and none of them touches the user's Chrome.

**Teardown:** call `run.close()` in `finally`. It saves `worker-logs.txt` and `api-calls.json`, then closes Chromium, stops the fixture server, and deletes the temp dir.

## Doctor

```bash
node .claude/skills/verify/scripts/doctor.mjs
```

This check is read-only and exits 0 when the setup is ready. It checks:
- Playwright's Chromium is installed. If not, run `npx playwright install chromium`.
- `dist-e2e/` is the E2E build and newer than `src/` and `public/`.
- No browser processes are stranded from a crashed run.

It also lists leftover `llmt-verify-*` temp dirs. Run it first, and again whenever a launch or drive step fails.

## Drive

Stable handles:
- Popup:
  - `#toggle`: 翻譯此頁 / 顯示原文, with the shortcut appended, e.g. `（Alt+A）`.
  - `#subs`: 開啟雙語字幕. Shown only on `youtube.com/watch` or while subtitles are on.
  - `#targetLang`, `#model`
  - `#warn` (`.show` when visible) with `#warnText`
  - `#note` (role `status`)
  - `#settings`, `#shortcuts`
- Page:
  - `llmt-translation.llmt-inline` / `.llmt-block`
  - `.llmt-pending`, `.llmt-error`
  - `data-llmt-source` (`api` | `cache`), `data-llmt-model`, `data-llmt-error`
  - `html.llmt-hidden` while translation is toggled off
  - `llmt-toast` shadow root: `.msg`, `.detail`, `.action`, `.close`
- Options page (a normal tab at `chrome-extension://<extId>/options.html`, so use Playwright locators):
  - Inputs and selects: `#model`, `#anthropicApiKey`, `#openaiApiKey`, `#geminiApiKey`, `#targetLang`
  - Buttons: role button `儲存`, role button `測試連線`, and one per provider named `清除 Anthropic API key` / `清除 OpenAI API key` / `清除 Gemini API key` (disabled when no key is stored; click opens a `confirm` dialog, so register `page.once("dialog", ...)` first). Journey: `journey-options-clear-key.mjs`
  - Status: `#status`
- Fixture: `fixtures/article.html`, served at `run.fixture()`. Element ids are the probes:
  - `title`, `intro`, `link-only`, `li-1`, `li-2`: should translate.
  - `btn`, `code`, `no-translate`: must not translate.
  - `far`: below the fold.
  - Add fixtures as new files in `fixtures/`, never edit a probe another journey relies on.

The keyboard shortcuts (`Alt+A`, `Alt+S`) cannot be driven: Chromium handles extension commands in browser UI, and CDP key events never reach it. Drive the popup instead, and report the shortcut path as not verified. The `chrome.commands.onCommand` handler reaches the same `toggleTab()` as the popup.

Shipped journey (also the reference for writing new ones):

```bash
node .claude/skills/verify/scripts/journey-page-translation.mjs   # exit 0 = all checks passed
```

## Evidence

Artifacts go to `.verify-artifacts/<ISO-stamp>-<name>/` at the repo root. The directory is gitignored and survives cleanup. Save evidence with `run.screenshot(page, file)` and `run.writeJson(file, data)`. `close()` adds `worker-logs.txt` (batch stats: segments, cached, sent, tokens) and `api-calls.json` (full request bodies).

Proof standards:
- **Use the real user path.** Toggle through `run.openPopup()` + `#toggle`, not `chrome.tabs.sendMessage` from the worker. Change settings through the popup or options UI, not `chrome.storage.local.set`, unless the setting is a precondition.
- **Capture before and after.** Record popup state before the action and page state after it. A final screenshot alone is not proof.
- **Check side effects.** Assert what went over the wire (`segmentsOf` on `run.calls`: which segments were sent, which were not, and the language line in the system prompt). Also assert the persisted settings (`run.storage()`), not just what renders.
- **Only the LLM API is mocked.** That is the external boundary the extension already isolates behind `TranslationProvider`; everything in the extension runs for real. A mocked run proves UI, protocol, batching, and cache behavior, but not translation quality or provider wire compatibility. For those, run with `mock: false` (with user approval) or `node scripts/e2e.mjs translate <url>`.
- **E2E build vs. shipped build.** `dist-e2e/` has `<all_urls>`, so injection would also succeed without the `activeTab` grant a real click gives. A pass does not prove the shipped build's permission model. When a change touches injection or permissions, say so and have a human click the toolbar icon in a `dist/` build.

## Cleanup

`run.close()` is the normal teardown. After a crash or a killed script:

```bash
node .claude/skills/verify/scripts/cleanup.mjs --dry-run   # show what it would do
node .claude/skills/verify/scripts/cleanup.mjs
```

It kills only processes whose command line contains `llmt-verify-` (our temp profile), never by process name, and removes `llmt-verify-*` temp dirs. It never touches `.verify-artifacts/`. Do not run it while another verify run is live, because it would delete that run's profile.

## Helpers

All of these are in `scripts/` and run with `node <path>`:
- `harness.mjs`: the library described above. Not run directly.
- `doctor.mjs`: the read-only readiness check.
- `cleanup.mjs [--dry-run]`: crash cleanup.
- `journey-page-translation.mjs`: the end-to-end proof of page translation. Copy it as the template for a new journey.
