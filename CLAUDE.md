# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Chrome MV3 extension that inserts LLM translations next to the original text (bilingual view), plus bilingual YouTube subtitles. Users bring their own Anthropic / OpenAI / Gemini API key. README.md (in Traditional Chinese) has the per-file responsibility table, design decisions, and known limitations; read it before structural changes. User-facing strings are Traditional Chinese.

## Commands

```bash
npm run build        # esbuild → dist/ (load unpacked from chrome://extensions)
npm run dev          # watch mode; public/ is copied only at startup, so restart after editing it
npm run typecheck    # tsc --noEmit (covers src, scripts, tests)
npm test             # vitest run
npx vitest run tests/segmenter.test.ts            # one file
npx vitest run tests/segmenter.test.ts -t "name"  # one test
npm run package      # build + store checks → release/*.zip
```

E2E (Playwright, real Chromium; build first with `npm run build:e2e`, which writes `dist-e2e/` with `<all_urls>` — never ship it):

```bash
node scripts/e2e.mjs no-key [url]     # free: missing-key notice path
node scripts/e2e.mjs measure          # free: system-prompt token counts per language
node scripts/e2e.mjs translate <url>  # SPENDS MONEY on real API calls
```

Env: `LLMT_MODEL`, `LLMT_LANG`, `HEADED=1`, `LLMT_SCREENSHOT`, `LLMT_DUMP`. Keys come from env or `.env.local` (gitignored). See the header of `scripts/e2e.mjs`.

Tests touching the DOM need `// @vitest-environment happy-dom` as the first line; the default environment is node. Provider tests run against a local mock SSE server, not real APIs.

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

**Adding or changing a model** touches `MODELS` in `src/shared/settings.ts` (UI + provider mapping) and `PRICES` in `src/background/pricing.ts` (cost estimate in the service worker log). Also update the README model table. Unknown model ids fall back to the Anthropic provider.

**YouTube subtitles** are a second, independent feature (`Feature = "page" | "subtitles"`). `src/page/youtube-hook.ts` runs in the MAIN world and only *reads* the player's own `/api/timedtext` responses (signed URLs and `pot` tokens make self-built requests unreliable). It forwards them to the content script as JSON-string `CustomEvent`s on `document`, validated by `src/shared/youtube-bridge.ts`. `src/content/youtube/controller.ts` owns the lifecycle and uses the same Port protocol as page translation. `refill.ts` schedules 5-minute windows, topping up when less than 60s remains ahead.

## Release constraints

`npm run package` refuses to zip if the manifest has an E2E name or broad host permissions (`<all_urls>`, `*://*/*`), if source maps are present, or if bundles contain remote/dynamic code (`eval(`, `new Function(`, `importScripts(`, `import("http…")`). Keep new code and dependencies compatible with these checks. Store listing text is in `docs/store-submission.md`; the privacy policy in `docs/privacy-policy.md` must be updated when data handling changes.
