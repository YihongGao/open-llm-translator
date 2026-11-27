// Journey: translate an image from its right-click entry point, with the API mocked.
// Context menus are browser UI that Playwright cannot click, so the journey calls the
// service worker's debug hook llmtTranslateImage(tabId, { kind: "src", srcUrl }) (E2E builds only), which runs
// the same handler as the menu click. The menu item and its click are NOT verified here.
// Usage: node .claude/skills/verify/scripts/journey-image-translation.mjs
// Exit 0 = every check passed. Evidence in the printed artifacts dir.
import { MOCK_IMAGE_REGIONS, MOCK_PREFIX, hasImage, imageSizeOf, launch, pageState } from "./harness.mjs";

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TOLERANCE_PX = 2;

/** What the user sees over the image: boxes, chip, and the image's own box. */
const overlayState = (page) =>
  page.evaluate(() => {
    const rect = (e) => {
      const b = e.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    };
    const root = document.querySelector("llmt-image-layer")?.shadowRoot ?? null;
    return {
      img: rect(document.querySelector("#page")),
      viewport: { width: innerWidth, height: innerHeight },
      layer: root !== null,
      chip: root?.querySelector(".status")?.textContent ?? null,
      toggle: root?.querySelector(".chip button")?.textContent ?? null,
      regions: [...(root?.querySelectorAll(".region") ?? [])].map((e) => ({
        text: e.textContent,
        vertical: e.classList.contains("vertical"),
        shown: getComputedStyle(e).display !== "none",
        fontSize: e.style.fontSize,
        ...rect(e),
      })),
      patches: [...(root?.querySelectorAll(".patch") ?? [])].map((e) => ({ fill: e.style.background, clip: e.style.clipPath, ...rect(e) })),
    };
  });

async function waitFor(fn, pred, { timeout = 15000, label }) {
  const until = Date.now() + timeout;
  let state;
  while (Date.now() < until) {
    state = await fn();
    if (pred(state)) return state;
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${label}; last state: ${JSON.stringify(state)}`);
}

/**
 * Where the mock's regions may land, derived here from the mock's fractions of the sent image
 * (which covers `visible`), in viewport px. The text box follows the bubble found in the pixels
 * (image-geometry.ts coverFor): it holds the mock's box (`inner`) and stays inside the box padded
 * 15% per side, or 30% left and right for a box taller than wide (`outer`, padFor).
 */
function expectedBoxes(img, visible) {
  return MOCK_IMAGE_REGIONS.map((r) => ({ inner: boxOf(r, img, visible, false), outer: boxOf(r, img, visible, true) }));
}

function boxOf({ box: [x0, y0, x1, y1] }, img, visible, padded) {
  {
    const px = (f, origin, size) => origin + f * size;
    const tall = (y1 - y0) * visible.height >= 1.1 * (x1 - x0) * visible.width;
    const [dx, dy] = padded ? [(x1 - x0) * (tall ? 0.3 : 0.15), (y1 - y0) * 0.15] : [0, 0];
    const left = px(x0 - dx, visible.x, visible.width);
    const right = px(x1 + dx, visible.x, visible.width);
    const top = px(y0 - dy, visible.y, visible.height);
    const bottom = px(y1 + dy, visible.y, visible.height);
    // Regions are drawn inside the image's box.
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const l = clamp(left, img.x, img.x + img.width);
    const r = clamp(right, img.x, img.x + img.width);
    const t = clamp(top, img.y, img.y + img.height);
    const b = clamp(bottom, img.y, img.y + img.height);
    return { x: l, y: t, width: r - l, height: b - t };
  }
}

/** `a` holds `inner` and lies inside `outer`, ±TOLERANCE_PX. */
const within = (a, { inner, outer }) =>
  holds(a, inner) && holds(outer, a);
const holds = (a, b) =>
  a.x <= b.x + TOLERANCE_PX && a.y <= b.y + TOLERANCE_PX && a.x + a.width >= b.x + b.width - TOLERANCE_PX && a.y + a.height >= b.y + b.height - TOLERANCE_PX;

const near = (a, b) => Math.abs(a - b) <= TOLERANCE_PX;
const sameRect = (a, b) => near(a.x, b.x) && near(a.y, b.y) && near(a.width, b.width) && near(a.height, b.height);

const tabIdOf = (run, url) => run.sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, url);
const translate = (run, tabId, src) => run.sw.evaluate(([id, s]) => globalThis.llmtTranslateImage(id, { kind: "src", srcUrl: s }), [tabId, src]);

// ---------------------------------------------------------------------------
// 1. The translation itself.

{
  const run = await launch({ name: "image-translation" });
  try {
    const page = await run.newPage(run.fixture("manga.html"));
    await page.waitForFunction(() => document.querySelector("#page")?.complete);
    const src = await page.evaluate(() => document.querySelector("#page").currentSrc);
    const tabId = await tabIdOf(run, page.url());
    const before = await overlayState(page);
    check("no overlay before the right-click", !before.layer, before);

    // --- whole image visible, default image model
    await translate(run, tabId, src);
    const s1 = await waitFor(() => overlayState(page), (s) => s.chip === "已翻譯 2 處文字", { label: "the done chip" });
    await run.writeJson("01-translated.json", s1);
    await run.screenshot(page, "01-translated.png");

    const calls = run.calls.filter((c) => hasImage(c.body));
    const content = calls[0]?.body.messages.at(-1).content ?? [];
    const images = content.filter((c) => c.type === "image");
    check("one API call, carrying exactly one JPEG image", calls.length === 1 && images.length === 1 && images[0].source.media_type === "image/jpeg" && images[0].source.data.length > 1000, { calls: calls.length, images: images.length });
    check("it used the default imageModel (claude-sonnet-5-5), not the text model", calls[0]?.body.model === "claude-sonnet-5-5", calls[0]?.body.model);
    const stated = imageSizeOf(calls[0].body);
    check("a fully visible image sends its original pixels (900x1280), not the 1x screenshot of its 422x600 box", stated?.width === 900 && stated?.height === 1280, { stated, img: s1.img });
    check("the prompt names the target language", content.some((c) => c.type === "text" && c.text.includes("Traditional Chinese")), null);

    const want = expectedBoxes(s1.img, s1.img);
    check("two regions with the mock's text", s1.regions.length === 2 && s1.regions[0].text === `${MOCK_PREFIX}region 1` && s1.regions[1].text === `${MOCK_PREFIX}region 2`, s1.regions);
    check(`text boxes hold the mock's boxes and stay inside them padded per padFor, ±${TOLERANCE_PX}px`, s1.regions.every((r, i) => within(r, want[i])), { got: s1.regions.map(({ x, y, width, height }) => ({ x, y, width, height })), want });
    check("fill was sampled from the image (white bubbles), not left empty", s1.patches.length === 2 && s1.patches.every((p) => /^rgb\(2[0-9]{2}, 2[0-9]{2}, 2[0-9]{2}\)$/.test(p.fill)), s1.patches.map((p) => p.fill));
    check("each cover is clipped to a polygon and covers the mock's box (the original text)", s1.patches.every((p) => p.clip.startsWith("polygon(")) && want.every((w) => s1.patches.some((p) => holds(p, w.inner))), s1.patches);
    check("text was fitted to the boxes (a font size was chosen)", s1.regions.every((r) => /^\d+px$/.test(r.fontSize)), s1.regions.map((r) => r.fontSize));
    check("a box that is much taller than wide is laid out vertically, the other is not", s1.regions[0].vertical === false && s1.regions[1].vertical === true, s1.regions.map((r) => r.vertical));
    check("the chip offers 顯示原圖", s1.toggle === "顯示原圖", s1.toggle);
    check("the chip carries no page translation (no <llmt-translation> nodes)", (await pageState(page)).done === 0, null);

    // --- original <-> translation
    await page.locator("llmt-image-layer .chip button").first().click();
    const s2 = await overlayState(page);
    check("顯示原圖 hides every box", s2.regions.every((r) => !r.shown) && s2.toggle === "顯示翻譯", s2);
    await run.screenshot(page, "02-original.png");
    await page.locator("llmt-image-layer .chip button").first().click();
    const s3 = await overlayState(page);
    check("顯示翻譯 shows them again", s3.regions.every((r) => r.shown) && s3.toggle === "顯示原圖", s3);

    // --- the image is scrolled half out of view: only the visible part is sent, boxes still map onto the whole image
    await run.sw.evaluate(() => chrome.storage.local.set({ imageModel: "claude-opus-5-5" }));
    await page.evaluate(() => window.scrollTo(0, 300));
    await sleep(300);
    await translate(run, tabId, src);
    const s4 = await waitFor(() => overlayState(page), (s) => s.chip?.includes("僅可見部分"), { label: "the partial chip" });
    await run.writeJson("03-partial.json", s4);
    await run.screenshot(page, "03-partial.png");
    const partialCall = run.calls.filter((c) => hasImage(c.body)).at(-1);
    const stated2 = imageSizeOf(partialCall.body);
    const visible = { x: Math.max(0, s4.img.x), y: Math.max(0, s4.img.y), width: Math.min(s4.img.x + s4.img.width, s4.viewport.width) - Math.max(0, s4.img.x), height: Math.min(s4.img.y + s4.img.height, s4.viewport.height) - Math.max(0, s4.img.y) };
    check("re-translating replaced the overlay (one layer, two regions) and used the new imageModel", s4.regions.length === 2 && partialCall.body.model === "claude-opus-5-5", { regions: s4.regions.length, model: partialCall.body.model });
    check("only the visible part was sent", stated2 && near(stated2.height, visible.height) && visible.height < s4.img.height - 100, { stated2, visible, img: s4.img });
    const want2 = expectedBoxes(s4.img, visible);
    check(`partial boxes map onto the whole image, ±${TOLERANCE_PX}px`, s4.regions.every((r, i) => within(r, want2[i])), { got: s4.regions.map(({ x, y, width, height }) => ({ x, y, width, height })), want: want2 });

    // --- the page swaps the picture: the translation no longer applies
    await page.evaluate(() => {
      document.querySelector("#page").src = "manga.png?v=2";
    });
    const s5 = await waitFor(() => overlayState(page), (s) => !s.layer, { label: "overlay removal on src change" });
    check("changing the image's src removes the overlay", !s5.layer, s5);

    const logs = (await run.logs()).filter((l) => l.includes("[llmt] image"));
    await run.writeJson("04-worker-image-logs.json", logs);
    check("the worker logged each image job with regions and served model", logs.length === 2 && logs.every((l) => /2 regions/.test(l) && /served claude-/.test(l)), logs);
  } catch (err) {
    check("journey ran to completion", false, String(err?.stack ?? err));
  } finally {
    await run.writeJson("result.json", results);
    await run.close();
  }
}

// ---------------------------------------------------------------------------
// 2. No Anthropic key: a notice with 開啟設定, no API call, nothing drawn.

{
  const run = await launch({ name: "image-translation-no-key", settings: { anthropicApiKey: "" } });
  try {
    const page = await run.newPage(run.fixture("manga.html"));
    await page.waitForFunction(() => document.querySelector("#page")?.complete);
    const src = await page.evaluate(() => document.querySelector("#page").currentSrc);
    await translate(run, await tabIdOf(run, page.url()), src);
    const s = await waitFor(() => pageState(page), (s) => s.toast !== null, { label: "the missing-key toast" });
    await run.writeJson("05-no-key-toast.json", s.toast);
    await run.screenshot(page, "05-no-key.png");
    check("missing key: toast says image translation needs an Anthropic key, with 開啟設定", s.toast.message === "無法翻譯這張圖片：圖片翻譯需要 Anthropic（Claude）的 API key" && s.toast.action === "開啟設定", s.toast);
    check("missing key: no API call and nothing drawn", run.calls.length === 0 && !(await overlayState(page)).layer, run.calls.length);
  } catch (err) {
    check("no-key journey ran to completion", false, String(err?.stack ?? err));
  } finally {
    await run.close();
  }
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `${failed.length} check(s) failed` : "all checks passed");
console.log("NOT verified: the context-menu item itself and its click (browser UI), sub-frame images, a real API response.");
process.exit(failed.length ? 1 : 0);
