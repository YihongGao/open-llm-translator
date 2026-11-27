# Image translation

Right-clicking an image and choosing 翻譯這張圖片, or right-clicking the page and choosing 翻譯畫面上的圖片, draws the translation over each speech bubble or caption of the image (of every image on screen, for the page item). A small chip at the image's top-right corner shows the status, switches between the original and the translation, and removes the overlay. The boxes ignore the mouse, so a manga viewer still turns pages on click.

## Sub-features

- `img-translate` the image is sent to Claude once and each returned region is drawn at its position over the image, in the target language. A fully visible, loaded, unrotated image whose file shape matches its box is read through a canvas and sent at its own resolution (long edge capped at 1568, JPEG); otherwise the visible part of one tab screenshot is cropped and sent.
- `img-screen` the page-context item translates every `<img>` with at least 160 CSS px visible on both sides, at most 4, largest first, each with its own overlay and chip. Images are found by geometry, so ones covered by transparent divs (manga viewers) work. None on screen shows a toast.
- `img-original-fallback` an image served cross-origin without CORS taints the canvas: that image is sent as a screenshot crop while the others still send originals. The worker log line says `original WxH` or `screenshot WxH`.
- `img-partial` an image scrolled partly out of view translates only the visible part; the chip says 僅可見部分 and the boxes still land on the whole image's box.
- `img-toggle` the chip's 顯示原圖 hides the boxes and becomes 顯示翻譯; ✕ removes the overlay.
- `img-replace` translating the same image again replaces its overlay. Changing the `<img>`'s `src` or removing it from the DOM removes the overlay.
- `img-model` the request uses Settings → 圖片翻譯 model (`imageModel`, default Claude Sonnet 5.5, Anthropic models only), not the text model.
- `img-no-key` with no Anthropic key the page shows a toast with 開啟設定 and nothing is sent or drawn.
- `img-not-found` a url the page no longer has, an image with less than 64 CSS px visible on a side, and an image inside an iframe each show a toast that says why.

## How to get to it (user POV)

- Right-click an image on any page, choose 翻譯這張圖片 in the context menu.
- On a viewer that covers its images, right-click the page and choose 翻譯畫面上的圖片.
- Choose the model in the options page, 圖片翻譯 model.

## Driving it with harness.mjs

Preconditions:

- `npm run build:e2e`. `launch({ name })` for the translation paths, `launch({ name, settings: { anthropicApiKey: "" } })` for `img-no-key`. The default mock answers an image request (one with an image block) with two regions at the fractions in `MOCK_IMAGE_REGIONS` (harness.mjs) of the image size the prompt states, text `〔譯〕region 1` and `〔譯〕region 2`. `hasImage(body)` and `imageSizeOf(body)` read those requests.
- Fixture `run.fixture("manga-spread.html")`: two 900x1280 pages shown 300 px wide side by side (`#a`, `#b`) under a transparent `.screen` div, `contextmenu` cancelled on the `<img>`s, and a 100 px `#icon` that must be skipped. `journey-image-screen.mjs` serves `manga.png` from a second port with no CORS headers for the tainted case.
- Fixture `run.fixture("manga.html")`: `#page`, a 900x1280 synthetic comic page shown 600 px tall at x=100, with a tall spacer below so a script can scroll it half out of view.

- **Translate.** The context menu cannot be clicked from Playwright. Call the service worker's debug hook, which runs the same handler as the menu click: `run.sw.evaluate(([id, t]) => globalThis.llmtTranslateImage(id, t), [tabId, { kind: "src", srcUrl }])` (or `{ kind: "visible" }` for the page item), with `srcUrl = await page.evaluate(() => document.querySelector("#page").currentSrc)`. The hook exists only in E2E and watch builds. It resolves when the job is done. The page then has `llmt-image-layer` (open shadow root) with `.image` (one per translated image), `.region` boxes positioned in percent of the image box, and `.chip` with `.status` and buttons (toggle, ✕).
- **Wire proof.** `run.calls.filter((c) => hasImage(c.body))`: one call, one `image` content block with `media_type: "image/jpeg"`, `body.model` equal to `imageModel`, and the prompt's `this W×H image` equal to the image's natural size when an original was sent (fully visible, same-origin), or to the CSS size of what was visible when a screenshot was (partly visible, or tainted; headless runs at devicePixelRatio 1).
- **Position proof.** Each `.region`'s `getBoundingClientRect()` holds the mock fraction mapped onto the image's rect and lies inside it padded per `padFor` (15% per side, 30% left and right for a tall box), ±2 px. The journey recomputes both itself. The fill is a separate `.patch` per region, clipped with `clip-path: polygon(...)` to the bubble found in the pixels; the journey checks it holds the mock box and carries a sampled white fill.
- **Toggle.** `page.locator("llmt-image-layer .chip button").first().click()`: boxes get `display: none` and the label reads 顯示翻譯.
- **Partial.** `page.evaluate(() => window.scrollTo(0, 300))`, then translate again. The prompt states the visible height only, the chip reads `已翻譯 2 處文字（僅可見部分）`.
- **Cleanup.** `page.evaluate(() => { document.querySelector("#page").src = "manga.png?v=2"; })` removes the layer.
- **No key.** Translate with the no-key launch. `pageState(page).toast` is `{ message: "無法翻譯這張圖片：圖片翻譯需要 Anthropic（Claude）的 API key", action: "開啟設定" }`, `run.calls.length` is 0.
- **Proof.** Saved by `scripts/journey-image-translation.mjs`: overlay state JSON, screenshots, the worker's `[llmt] image` log lines. `run.calls[0].body.messages[0].content[0].source.data` is the base64 JPEG that was sent; decode it to check it holds the bare image, with no chip or boxes of ours.

## Gotchas

- The context-menu item and its click are browser UI and are not verified by any run. Report them as not verified, for both items. So are images inside an iframe (the hook always passes frame 0) and a real model response.
- The E2E build has `<all_urls>`, so `captureVisibleTab` works without the `activeTab` grant a real right-click gives. A pass does not prove the shipped permission model.
- The mock ignores the pixels: it only proves geometry, protocol and rendering. Box accuracy and translation quality need `mock: false` (costs money, ask first) or the spike in `prototypes/manga-spike/`.
- Make the tab active (`run.newPage` does) before translating: `captureVisibleTab` captures the active tab of its window.
- Wait for the image to load (`#page` `.complete`) before reading `currentSrc` and translating.
- The overlay's boxes are in a shadow root. `document.querySelector(".region")` finds nothing; use `document.querySelector("llmt-image-layer").shadowRoot` or a Playwright locator chained from `llmt-image-layer`.
- The two regions' sizes come from the mock's fractions, so a box of the mock may sit over no bubble in the fixture. That is not a bug in the overlay.
