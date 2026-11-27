# Architecture

Open LLM Translator is a Chrome MV3 extension built from five esbuild bundles (`scripts/build.mjs`):

| Bundle | Runs in |
|---|---|
| `background` | Service worker (ESM) |
| `content` | Isolated world of the page, injected on demand (IIFE) |
| `youtube-hook` | YouTube's main world, injected on demand (IIFE) |
| `popup` | Toolbar menu |
| `options` | Options page |

## Translation flow

```
content script (injected on click)            background service worker
  segmenter: splits inline runs                 translator: dedupe → IndexedDB cache → provider
  IntersectionObserver: viewport only  ──Port──►  providers/: Anthropic SDK, OpenAI/Gemini fetch + SSE
  MutationObserver: SPA / dynamic content ◄────  protocol: "[n] text" line format, parsed while streaming
  render: inserts <llmt-translation> into the original element
```

1. The content script (`src/content/index.ts`) segments the page, translates only what is in the viewport, rescans on DOM mutation, and batches segments (at most 3000 characters or 40 segments per batch).
2. It opens one long-lived `Port` per page and sends `translate` requests. Results stream back as `segment` / `segment-error` / `batch-done` events. Wire types are in `src/shared/messages.ts`.
3. The background worker (`src/background/index.ts`) caps concurrent API requests at 3 across all tabs, aborts work when the port disconnects, and calls `runBatch` in `translator.ts`.
4. `translator.ts` dedupes, checks the IndexedDB cache (key = SHA-256 of a revision + origin + model + target language + text; bumping the revision drops translations a prompt fix made wrong), and sends misses to the provider. Every segment receives either a translation or an error.
5. `protocol.ts` builds the prompt and parses the streamed output line by line.

## Files

| File | Responsibility |
|---|---|
| `src/content/segmenter.ts` | Decides what text counts as a segment, where its translation goes, and whether it is inline or a block |
| `src/content/index.ts` | Viewport scheduling, batching, rendering, SPA rescans |
| `src/background/translator.ts` | Per-batch pipeline; guarantees every segment gets a translation or an error |
| `src/background/protocol.ts` | Prompt and streaming-output parser |
| `src/background/providers/` | `TranslationProvider` interface and the three implementations; `registry.ts` picks one by model id |
| `src/background/cache-warmup.ts` | Lets one Anthropic request per prompt prefix write the prompt cache before others fan out |
| `src/popup/popup.ts` | Toolbar menu |
| `src/shared/i18n.ts` | The UI string resolver: `t(key, ...subs)` over the bundled catalogs (keys typed from the English catalog), `setUiLanguage()` for the user's choice, `localeFor()` for "Follow browser", and `localizePage()` for `data-i18n` markup. Its only `chrome.i18n` call is `getUILanguage()` |
| `public/_locales/{en,ja,zh_CN,zh_TW}/messages.json` | UI string catalog (`en` is `default_locale`); also the manifest description and command descriptions |
| `src/shared/tab-control.ts` | Injection, toggling and state queries for a tab (shared by the menu and keyboard shortcuts) |
| `src/content/toast.ts` | Error notice (Shadow DOM) |
| `src/page/youtube-hook.ts` | Read-only hook in YouTube's main world: reads the captions the player downloads itself (`/api/timedtext`) and forwards them to the content script |
| `src/shared/youtube-bridge.ts` | Message format between the hook and the content script (JSON-string `CustomEvent`s on `document`) and its validation |
| `src/content/youtube/captions.ts` | json3 parsing, merging captions into sentences, picking the source track |
| `src/content/youtube/refill.ts` | Top-up scheduling: translates 5 minutes at a time, refilling when less than 60 seconds remain ahead |
| `src/content/youtube/controller.ts` | Subtitle lifecycle: on/off, video changes, sending translations, syncing to the timeline |
| `src/content/youtube/overlay.ts` | Bilingual subtitle box inside the player |

## Design decisions

- **Line format, not JSON.** One segment per line (`[n] text`), so each segment can render as soon as its line arrives and translations appear one by one.
- **Translations go inside the original element.** They inherit its font, color and link styles. When a paragraph is a single `<a>`, the translation goes inside the `<a>` so clicking it follows the link.
- **Injected on demand.** `activeTab` plus `scripting`: no content script on every page, and no `<all_urls>` permission. The popup and keyboard commands both go through `src/shared/tab-control.ts`.
- **Content scripts cannot read `chrome.storage`.** The background sets `setAccessLevel("TRUSTED_CONTEXTS")` so the API key stays out of page-adjacent contexts. Anything the content script needs, such as the target language, travels inside messages; each request carries its own target language so a change in another tab cannot switch a page mid-translation.
- **OpenAI and Gemini use `fetch` against their REST APIs.** No SDKs (both ship frequently); request formats follow the official API references, and both send `store: false`. Only Anthropic needs explicit prompt-cache breakpoints and warm-up; the other two cache automatically.
- **YouTube captions are read from the player's own requests.** Caption URLs carry signatures and a player-generated `pot` token, so self-built requests often come back empty or rate-limited. The hook only reads responses, and only for the main player's (`#movie_player`) current video; thumbnail-preview requests are dropped. Turning subtitles on toggles CC once to make the player fetch again, so no persistent script or youtube.com host permission is needed. When the player's track is already in the target language (for example a video with human Chinese subtitles), the original is taken from the human track in the same language as the auto-generated captions; if no original can be determined, nothing is translated.
- **UI language: our own resolver, with a user setting.** `chrome.i18n.getMessage` always uses the browser's language and cannot be switched at run time, so `t()` looks messages up itself in the four catalogs (`public/_locales`, imported as JSON and bundled into `background`, `content`, `popup` and `options`; not into `youtube-hook`, which has no UI). It reproduces Chrome's rules: the catalog's message, else English; `$name$`, `$1` and `$$` placeholders; and for "Follow browser" the same locale Chrome would pick (`localeFor()`: zh-HK and zh-MO get zh_TW, other Chinese tags such as zh-SG get zh_CN, anything else English). `tests/ui-language.test.ts` pins the rules, and `journey-ui-locale-fidelity.mjs` checks in real Chrome that `t()` equals `chrome.i18n.getMessage` for every key. The setting `uiLanguage` (`"auto"` or a locale, stored in `chrome.storage.local`) holds one module-level value in `i18n.ts`, so there is one resolution path whether or not the user chose a language. Whoever loads settings applies it: the popup and options page after `loadSettings()`, the service worker on each translate and test-connection request, and the content script (it cannot read storage) from the `uiLanguage` field of the toggle and set-lang messages and from every `segment-error` port event. The event field exists because a tab injected before the user changed the setting would otherwise wrap a service-worker message in the old language's outer text; the content script and the YouTube controller adopt it before rendering, so the outer string always matches the message. The options page re-localizes in place when the select changes. What does not switch at once on an already-translated tab: notices the content script writes itself (the connection-lost tooltip, the already-in-target-language notices, the YouTube notices not caused by a translate error) keep the language from the tab's last toggle or target-language change, and a toast, tooltip or marker already on screen keeps its text until it is replaced. Not overridable: the manifest description and the keyboard-command descriptions on `chrome://extensions/shortcuts`, which Chrome reads itself in the browser's language. A test checks that every locale has the same keys and placeholders. The language of the *translations* is a separate user setting (`targetLang`); only its default follows the browser's UI language, not the `uiLanguage` setting (`defaultSettings()` maps `getUILanguage()` onto `TARGET_LANGUAGES`, and a stored value always wins); language names in that picker stay in their own language. Not localized: the LLM prompt (`protocol.ts`) and `console.*` logs.
- **The translation cache is partitioned by origin** to contain prompt injection: a page can at most tamper with translations on its own site.

## Hidden-text filtering

Before text is sent, segments the user cannot see are dropped. This is best effort. It catches common techniques: `display`/`visibility`/`opacity`, sr-only clipping, zero-width or zero-height overflow containers, text under 2px, transparent text, and invisible Unicode characters. It does not catch same-color text (white on white), absolutely positioned text within 600px of the top of the page, or `transform` tricks. The main defenses are the system prompt (page text is data, not instructions) and the per-origin cache.

Hidden blocks that are inside the viewport are rechecked once a second, so content revealed by scroll animations (AOS, WOW.js), dropdowns and accordions is translated after it opens.
