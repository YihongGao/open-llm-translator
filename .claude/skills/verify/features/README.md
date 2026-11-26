# Open LLM Translator verification map

This directory is the maintained source for verifying the user-facing behavior of the extension. Read this index before driving anything, then use the matching feature file as the recipe. Harness API, launch, doctor and cleanup are in [../SKILL.md](../SKILL.md).

## Baseline preconditions

- `npm run build:e2e` has run after the last change. `node .claude/skills/verify/scripts/doctor.mjs` exits 0.
- Each journey calls `launch({ name })`, which creates a fresh profile. That means empty settings and an empty translation cache, plus the defaults: mock key, `claude-haiku-5-5`, `zh-TW`.
- The default API mock is `"ok"`: every segment `[n] text` comes back as `〔譯〕text`.
- Pages come from `run.fixture()` (`fixtures/article.html`), except YouTube, which needs the live site.
- Never drive the user's own Chrome or a profile a different run created.

## Driving conventions

- Drive scripts live in `.claude/skills/verify/scripts/` and import `./harness.mjs`. Run them with `node`.
- Make the target tab active (`run.newPage` does) before `run.openPopup()`. The popup attaches to the active tab.
- Toggle and change settings through the popup or options UI. `run.sw` is for preconditions and inspection only.
- Wait on `waitForPage` predicates, not fixed sleeps. Translation is async and streamed.
- Use fixture element ids as handles. Add new fixture files rather than changing probes in `article.html`.

## Proof and skip reporting

- Popup proof is `popup.state()` before and after the action, saved as JSON. Page proof is `pageState(page)` JSON plus a screenshot.
- Wire proof is `segmentsOf(call.body)` and the system prompt's last line (`Translate every segment into …`) from `run.calls`.
- Settings proof is `run.storage()` read after the UI action.
- Record the feature file, sub-feature ID and entry point with every artifact (artifact dir name + `result.json`).
- The keyboard-shortcut entry points are not drivable. Report them as skipped, never as verified through the popup.
- A mocked run does not prove translation quality or provider compatibility. Say which mock mode the proof used.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with harness.mjs` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact call and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

## Features

- [Page translation](./page-translation.md): toggle from the popup, viewport-lazy translation, skipped elements, restore original. Proven by `scripts/journey-page-translation.mjs`.
- [Popup language and model](./popup-language-model.md): switch target language (re-translates the open page) and model (key warning, persisted).
- [Error notices](./error-notices.md): missing key, invalid key, rate limit. Covers the toast, the ⚠ markers and retry on re-toggle.
- [Options page](./options-page.md): write-only API key fields, 清除, model, language, 儲存, 測試連線. Proven by `scripts/journey-options-write-only-keys.mjs` and `scripts/journey-options-clear-key.mjs`.
- [YouTube bilingual subtitles](./youtube-subtitles.md): subtitle overlay on `youtube.com/watch`. Needs the live site and is not yet proven by a run.
