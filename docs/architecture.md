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
4. `translator.ts` dedupes, checks the IndexedDB cache (key = SHA-256 of origin + model + target language + text), and sends misses to the provider. Every segment receives either a translation or an error.
5. `protocol.ts` builds the prompt and parses the streamed output line by line.

## Image translation flow

A separate feature from page translation, with two menu items (`contextMenus`): "Translate this image" (context `image`) and "Translate images on screen" (context `page`). Both resolve to one `ImageTarget` (`{kind:"src", srcUrl}` or `{kind:"visible"}`) and one handler. It runs on single requests, not a Port.

The page item exists because manga viewers cover images with transparent elements and cancel `contextmenu` on the `<img>` itself (measured on vw.mangaz.com, 2026-11), so Chrome reports the page context, never the image, and the image item cannot appear. The content script therefore finds images by geometry (`getBoundingClientRect`), never by hit testing or URL.

```
background (image-translate.ts)                      content script (image-overlay.ts)
  contextMenus.onClicked ── llmt-image-locate ───►   find the <img>(s): by URL, or the ≤ 4 largest with
                         (target)                      ≥ 160 px visible per side; hide old overlays,
                         ◄── per image: rects ─────   wait two frames (our pixels out of the shot),
                             + original pixels?       read each fully visible image through a canvas
  one captureVisibleTab, only if an image lacks an
  original → per image: crop to the visible part
  → downscale (long edge ≤ 1568) → JPEG
  ── llmt-image-captured ───────────────────────►   show the "translating" chip
  one Anthropic vision call per image, concurrently
  (anthropic-image.ts), regions parsed while streaming
  ── llmt-image-region × N ─────────────────────►   draw one box per region
  ── llmt-image-end ────────────────────────────►   chip: N regions / partial / failed
```

1. The click grants `activeTab` for the tab, which allows injecting the content script (`ensureContentScript` in `tab-control.ts`, which does not activate page translation) and `captureVisibleTab`. Only the top frame is supported; for an image in an iframe the content script shows a notice.
2. The content script answers `llmt-image-locate` with, per image, its box, the part inside the viewport (CSS px), and optionally its original pixels, plus the viewport size. For a `src` target, fewer than 64 CSS px visible on a side is refused; for `visible`, an image needs 160 px on both sides, at most 4 are taken, largest first, and none gives a toast.
   Original pixels (`image-source.ts`) are sent only when the image is fully visible, loaded, unpadded, not rotated or flipped by the page, and its file shape matches its box (`object-fit: fill`, or aspect ratios within 1%). It is drawn to a canvas (downscaled to a 1568 px long edge) and encoded as JPEG. A page that serves the image without CORS taints the canvas, the read throws, and that image falls back to the screenshot. Boxes map onto the element in fractions either way, so the overlay does not care which was sent.
3. The background takes at most one screenshot per click (`captureVisibleTab` is rate-limited to about 2 calls per second) and crops each image out of it (scale = screenshot width / viewport width, which absorbs devicePixelRatio and page zoom), or uses the original as sent, then sends it with the prompt from `image-protocol.ts`, and converts each returned pixel box into fractions of the whole image element (`image-geometry.ts`), with a fill colour sampled just outside the text and a text colour that reads on it. The fill is not a rectangle: `coverFor` floods the bubble's background from the middle of the box and the overlay clips the fill to that outline (`clip-path: polygon`), so it covers the whole bubble, including a column the model's box missed, without spilling onto the artwork around a round bubble. A side where the flood escapes (a gap in a burst's outline, text on open artwork) is cut back to the box padded 15% per side, 30% left and right for vertical text.
4. Each image is its own job with its own overlay and chip; its failure shows on its own chip. The API calls run inside the same 3-request cap as page translation (`withSlot`).

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
| `src/background/image-translate.ts` | Image translation: menu click to `ImageTarget`, locate, one screenshot, crop or use the original, call the model per image, send regions; registers the two context-menu entries |
| `src/background/image-protocol.ts` | Image prompt (pixel coordinates of the image that was sent) and the incremental region-line parser |
| `src/background/image-geometry.ts` | Pure maths: screenshot crop, downscale, pixel box to fractions, vertical-text test, fill colour, bubble outline (`coverFor`) |
| `src/background/providers/anthropic-image.ts` | The vision call (Anthropic only); not a `TranslationProvider`, which is text-only |
| `src/background/concurrency.ts` | The shared cap on simultaneous API requests |
| `src/content/image-source.ts` | Which on-screen images to translate (size threshold, cap, order) and whether the page lets us read an image's own pixels (pure decision, then a canvas read) |
| `src/content/image-overlay.ts` | Overlay layer (Shadow DOM): boxes over the image, status chip, original/translation toggle, cleanup |
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
- **UI language: our own resolver, with a user setting.** `chrome.i18n.getMessage` always uses the browser's language and cannot be switched at run time, so `t()` looks messages up itself in the four catalogs (`public/_locales`, imported as JSON and bundled into `background`, `content`, `popup` and `options`; not into `youtube-hook`, which has no UI). It reproduces Chrome's rules: the catalog's message, else English; `$name$`, `$1` and `$$` placeholders; and for "Follow browser" the same locale Chrome would pick (`localeFor()`: zh-HK and zh-MO get zh_TW, other Chinese tags such as zh-SG get zh_CN, anything else English). `tests/ui-language.test.ts` pins the rules, and `journey-ui-locale-fidelity.mjs` checks in real Chrome that `t()` equals `chrome.i18n.getMessage` for every key. The setting `uiLanguage` (`"auto"` or a locale, stored in `chrome.storage.local`) holds one module-level value in `i18n.ts`, so there is one resolution path whether or not the user chose a language. Whoever loads settings applies it: the popup and options page after `loadSettings()`, the service worker on each translate and test-connection request, and the content script (it cannot read storage) from the `uiLanguage` field of the toggle and set-lang messages, of the image-translation `llmt-image-locate` and `llmt-image-end` messages, and of every `segment-error` port event. The event field exists because a tab injected before the user changed the setting would otherwise wrap a service-worker message in the old language's outer text; the content script and the YouTube controller adopt it before rendering, so the outer string always matches the message. The options page re-localizes in place when the select changes. What does not switch at once on an already-translated tab: notices the content script writes itself (the connection-lost tooltip, the already-in-target-language notices, the YouTube notices not caused by a translate error) keep the language from the tab's last toggle or target-language change, and a toast, tooltip or marker already on screen keeps its text until it is replaced. Not overridable: the manifest description and the keyboard-command descriptions on `chrome://extensions/shortcuts`, which Chrome reads itself in the browser's language. A test checks that every locale has the same keys and placeholders. The language of the *translations* is a separate user setting (`targetLang`); only its default follows the browser's UI language, not the `uiLanguage` setting (`defaultSettings()` maps `getUILanguage()` onto `TARGET_LANGUAGES`, and a stored value always wins); language names in that picker stay in their own language. Not localized: the LLM prompt (`protocol.ts`) and `console.*` logs.
- **Original pixels when the page allows it, a screenshot otherwise.** The worker cannot fetch an arbitrary image URL without broad host permissions (CORS, cookies, signed URLs), but the content script runs in the page: for a same-origin or CORS-enabled image it can draw the element to a canvas and send the file's own resolution (1190x1684 instead of about 630x890 for a screenshot on a manga viewer; the spike showed accuracy drops at low resolution). It never fetches the URL or touches the page. When the canvas is tainted, or the image is partly off screen, scaled oddly, or transformed, `activeTab` plus `captureVisibleTab` reads what is on screen: only the visible part, at screen resolution.
- **The overlay sits on top of the image; the `<img>` is never touched.** Replacing `src` would need the image bytes, break lazy loaders and viewers, and cannot be undone cleanly. The overlay follows the image's box (scroll, resize, `ResizeObserver`), ignores pointer events so page clicks still work, and goes away when the image's `src`/`srcset` changes or the element leaves the DOM.
- **No cache for image results.** Boxes depend on what part of the image was visible and at what size, and the key would be the pixels. Translating the same image again costs another request.
- **Image translation is Claude only.** Box coordinates were measured on Claude models only (spike, 2026-11: about 100% of dialogue regions found, boxes slightly tight, hence the 15% padding). It has its own model setting (`imageModel`, default Sonnet 5.5) and always uses the Anthropic key.
- **The translation cache is partitioned by origin** to contain prompt injection: a page can at most tamper with translations on its own site.

## Hidden-text filtering

Before text is sent, segments the user cannot see are dropped. This is best effort. It catches common techniques: `display`/`visibility`/`opacity`, sr-only clipping, zero-width or zero-height overflow containers, text under 2px, transparent text, and invisible Unicode characters. It does not catch same-color text (white on white), absolutely positioned text within 600px of the top of the page, or `transform` tricks. The main defenses are the system prompt (page text is data, not instructions) and the per-origin cache.

Hidden blocks that are inside the viewport are rechecked once a second, so content revealed by scroll animations (AOS, WOW.js), dropdowns and accordions is translated after it opens.
