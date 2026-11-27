# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Chrome MV3 extension that inserts LLM translations next to the original text (bilingual view), plus bilingual YouTube subtitles. Users bring their own Anthropic / OpenAI / Gemini API key. `docs/architecture.md` has the per-file responsibility table, design decisions, and hidden-text filtering limits; read it before structural changes. `README.md` (English) and `README.zh-TW.md` are for users, and `CONTRIBUTING.md` for contributors; keep the two READMEs in sync. User-facing strings live in `public/_locales/{en,ja,zh_TW}/messages.json` (en is the default locale; the UI follows the browser language and any other language shows English). Never hard-code them; see CONTRIBUTING.md.

## Commands

```bash
npm run build        # esbuild → dist/ (load unpacked from chrome://extensions)
npm run dev          # watch mode; public/ is copied only at startup, so restart after editing it
npm run typecheck    # tsc --noEmit (covers src, scripts, tests)
npm test             # vitest run
npx vitest run tests/segmenter.test.ts            # one file
npx vitest run tests/segmenter.test.ts -t "name"  # one test
npm run check:dist   # store-rejection checks on dist/ (build first)
npm run package      # typecheck + test + build + check:dist → release/*.zip
```

E2E (Playwright, real Chromium; build first with `npm run build:e2e`, which writes `dist-e2e/` with `<all_urls>` — never ship it):

```bash
node scripts/e2e.mjs no-key [url]     # free: missing-key notice path
node scripts/e2e.mjs measure          # free: system-prompt token counts per language
node scripts/e2e.mjs translate <url>  # SPENDS MONEY on real API calls
```

Env: `LLMT_MODEL`, `LLMT_LANG`, `HEADED=1`, `LLMT_SCREENSHOT`, `LLMT_DUMP`. Keys come from env or `.env.local` (gitignored). See the header of `scripts/e2e.mjs`.

Tests touching the DOM need `// @vitest-environment happy-dom` as the first line; the default environment is node. Provider tests run against a local mock SSE server, not real APIs.

## Before declaring a change done

- Any change under `src/`, `scripts/` or `tests/`: run `npm run typecheck` and `npm test`, and both must pass. Report failures with their output; do not call the work done. CI (`.github/workflows/ci.yml`) runs on every PR and push to `main`: the same checks plus `build` and `check:dist`, `npm test` on Windows, and every `.claude/skills/verify/scripts/journey-*.mjs` against the E2E build (mocked API, headless). Branch protection requires only its `ci-ok` job. CI picks up new journeys through that glob, so a journey must use the mock and exit non-zero on failure.

## CI and release

- `.github/workflows/security.yml`: CodeQL and dependency review.
- `.github/workflows/release.yml`: pushing a `v*.*.*` tag runs `npm run package`, attests the zip, and attaches it to a GitHub Release. The tag must equal the version in both `package.json` and `public/manifest.json`. Uploading to the Chrome Web Store stays manual.
- Actions are pinned to commit SHAs with the version in a comment; Dependabot (`.github/dependabot.yml`) bumps them. Pin new actions the same way.
- Changes to user-visible behavior (popup, options page, rendered translations, toasts, YouTube subtitles): also prove it in the real extension with the project `verify` skill (`.claude/skills/verify/`): run `npm run build:e2e`, then the matching journey from its feature map. Unit tests alone don't count as proof for these.
- Behavior changes come with a test that fails without the change.

## Architecture

Five esbuild bundles (`scripts/build.mjs`): `background` (ESM service worker), `content` (IIFE, isolated world), `youtube-hook` (IIFE, YouTube's MAIN world), `popup`, `options`.

**Injection is on demand.** There are no declared content scripts. `src/shared/tab-control.ts` injects CSS + `content.js` (and `youtube-hook.js` into the MAIN world on YouTube) via `activeTab` + `scripting`, then sends a toggle message. The popup and the keyboard commands (handled in the background) both go through it.

**Content scripts cannot read `chrome.storage`** (background sets `setAccessLevel("TRUSTED_CONTEXTS")` so the API key stays out of page-adjacent contexts). Anything the content script needs, such as `targetLang`, travels inside messages. `targetLang` is carried per `TranslateRequest` so a change in another tab cannot switch a page mid-translation.

**Translation flow** (`src/shared/messages.ts` defines the wire types):
1. Content script (`src/content/index.ts`) segments the page (`segmenter.ts`), translates only what is in the viewport (IntersectionObserver), rescans on DOM mutation, and batches segments (≤3000 chars or 40 segments).
2. It opens one long-lived `Port` (`PORT_NAME`) per page and sends `translate` requests. Results stream back as `segment` / `segment-error` / `batch-done` events.
3. Background (`src/background/index.ts`) caps concurrent API requests at 3 across all tabs, aborts work when the port disconnects, and calls `runBatch` in `translator.ts`.
4. `translator.ts` dedupes, checks the IndexedDB cache (`cache.ts`, key = SHA-256 of origin + model + targetLang + text; partitioned by origin to contain prompt injection), and sends misses to the provider. Invariant: every segment receives a translation or an error.
5. `protocol.ts` builds the prompt and parses streamed output in a line format (`[n] text`), not JSON, so segments render as each line arrives.

**Providers** (`src/background/providers/`): `TranslationProvider.translate()` is an async generator of `segment` events ending with exactly one `end` event. Anthropic uses the SDK; OpenAI and Gemini use raw `fetch` + SSE (`http.ts`) and send `store: false`. `registry.ts` picks the provider from the model id. Only Anthropic needs explicit prompt-cache breakpoints, so only it goes through `CacheWarmupGate` (`cache-warmup.ts`), which lets one request per prompt prefix write the cache before the others fan out.

**Adding or changing a model** touches `MODELS` in `src/shared/settings.ts` (UI + provider mapping) and `PRICES` in `src/background/pricing.ts` (cost estimate in the service worker log). Also update the model table in both `README.md` and `README.zh-TW.md`. Unknown model ids fall back to the Anthropic provider.

**YouTube subtitles** are a second, independent feature (`Feature = "page" | "subtitles"`). `src/page/youtube-hook.ts` runs in the MAIN world and only *reads* the player's own `/api/timedtext` responses (signed URLs and `pot` tokens make self-built requests unreliable). It forwards them to the content script as JSON-string `CustomEvent`s on `document`, validated by `src/shared/youtube-bridge.ts`. `src/content/youtube/controller.ts` owns the lifecycle and uses the same Port protocol as page translation. `refill.ts` schedules 5-minute windows, topping up when less than 60s remains ahead.

## Release constraints

`npm run package` refuses to zip if `typecheck` or `test` fails, or if `scripts/check-dist.mjs` finds an E2E manifest name, broad host permissions (`<all_urls>`, `*://*/*`), missing icons, source maps, the `llmtMeasurePrompts` debug helper (gated on the build-time `__LLMT_DEBUG__` flag, true only for `--watch` and `--e2e` builds), `\uXXXX`-escaped CJK text, or remote/dynamic code (`eval(`, `new Function(`, `importScripts(`, `import("http…")`). Keep new code and dependencies compatible with these checks. Store listing text is in `docs/store-submission.md`; the privacy policy in `docs/privacy-policy.md` must be updated when data handling changes. `docs/api-key-security.md` and its `.zh-TW.md` twin describe, for users, how the API key is stored and shielded, citing `settings.ts`, `options.ts` (write-only key fields), `tab-control.ts`, `redact.ts` and the manifest's host permissions; update both when any of that changes.
