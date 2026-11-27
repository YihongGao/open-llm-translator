// Journey: "translate images on screen" on a page that mimics a manga viewer (two pages side by side under a
// transparent cover, the <img> cancelling contextmenu), with the API mocked.
// Context menus are browser UI that Playwright cannot click, so the journey calls the service worker's debug hook
// llmtTranslateImage(tabId, { kind: "visible" }) (E2E builds only), which runs the same handler as the menu click.
// The menu item and its click are NOT verified here.
// Cases: (1) same-origin images send their original pixels, (2) one image served cross-origin without CORS taints
// the canvas, so it falls back to the screenshot while the other still sends its original, (3) nothing big enough.
// Usage: node .claude/skills/verify/scripts/journey-image-screen.mjs
// Exit 0 = every check passed. Evidence in the printed artifacts dir.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { FIXTURES, MOCK_IMAGE_REGIONS, MOCK_PREFIX, hasImage, imageSizeOf, launch, pageState } from "./harness.mjs";

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TOLERANCE_PX = 2;
const near = (a, b) => Math.abs(a - b) <= TOLERANCE_PX;
const sameRect = (a, b) => near(a.x, b.x) && near(a.y, b.y) && near(a.width, b.width) && near(a.height, b.height);

/** Every overlay container with the box of the image it follows and its regions, in viewport px. */
const overlayState = (page) =>
  page.evaluate(() => {
    const rect = (e) => {
      const b = e.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    };
    const root = document.querySelector("llmt-image-layer")?.shadowRoot ?? null;
    return {
      imgs: Object.fromEntries(["a", "b", "icon"].map((id) => [id, rect(document.getElementById(id))])),
      layer: root !== null,
      chips: [...(root?.querySelectorAll(".status") ?? [])].map((e) => e.textContent),
      images: [...(root?.querySelectorAll(".image") ?? [])].map((c) => ({
        box: rect(c),
        regions: [...c.querySelectorAll(".region")].map((e) => ({ text: e.textContent, ...rect(e) })),
        fills: [...c.querySelectorAll(".patch")].map((e) => e.style.background),
      })),
    };
  });

async function waitFor(fn, pred, { timeout = 20000, label }) {
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
 * The mock's regions (fractions of the sent image) on a fully visible image's box: the text box
 * holds the mock's box (`inner`) and stays inside it padded 15% per side, or 30% left and right
 * for a box taller than wide in pixels (`outer`, image-geometry.ts coverFor and padFor).
 */
function expectedBoxes(img) {
  return MOCK_IMAGE_REGIONS.map((r) => ({ inner: boxOf(r, img, false), outer: boxOf(r, img, true) }));
}

const holds = (a, b) =>
  a.x <= b.x + TOLERANCE_PX && a.y <= b.y + TOLERANCE_PX && a.x + a.width >= b.x + b.width - TOLERANCE_PX && a.y + a.height >= b.y + b.height - TOLERANCE_PX;
const within = (a, { inner, outer }) => holds(a, inner) && holds(outer, a);

function boxOf({ box: [x0, y0, x1, y1] }, img, padded) {
  {
    const tall = (y1 - y0) * img.height >= 1.1 * (x1 - x0) * img.width;
    const [dx, dy] = padded ? [(x1 - x0) * (tall ? 0.3 : 0.15), (y1 - y0) * 0.15] : [0, 0];
    const clamp = (v) => Math.min(1, Math.max(0, v));
    const [l, t, r, b] = [clamp(x0 - dx), clamp(y0 - dy), clamp(x1 + dx), clamp(y1 + dy)];
    return { x: img.x + l * img.width, y: img.y + t * img.height, width: (r - l) * img.width, height: (b - t) * img.height };
  }
}

const tabIdOf = (run, url) => run.sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, url);
const translateOnScreen = (run, tabId) => run.sw.evaluate((id) => globalThis.llmtTranslateImage(id, { kind: "visible" }), tabId);

/** Serves manga.png from another origin (another port) with no CORS headers: drawing it taints a canvas. */
function farImageServer() {
  const server = createServer(async (_req, res) => {
    res.writeHead(200, { "content-type": "image/png" });
    res.end(await readFile(path.join(FIXTURES, "manga.png")));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/manga.png` })));
}

/** The overlay container that follows `img`, and whether its two regions sit where the mock said. */
function overlayFor(state, img) {
  const container = state.images.find((c) => sameRect(c.box, img));
  const want = expectedBoxes(img);
  return { container, placed: container?.regions.length === 2 && container.regions.every((r, i) => within(r, want[i]) && r.text === `${MOCK_PREFIX}region ${i + 1}`) };
}

async function openSpread(run, { farUrl } = {}) {
  const page = await run.newPage(run.fixture("manga-spread.html"));
  if (farUrl) await page.evaluate((u) => void (document.getElementById("a").src = u), farUrl);
  await page.waitForFunction(() => ["a", "b", "icon"].every((id) => document.getElementById(id).complete && document.getElementById(id).naturalWidth > 0));
  return { page, tabId: await tabIdOf(run, page.url()) };
}

// ---------------------------------------------------------------------------
// 1. Both pages are same-origin: each sends its original pixels.

{
  const run = await launch({ name: "image-screen" });
  try {
    const { page, tabId } = await openSpread(run);
    const covered = await page.evaluate(() => {
      const r = document.getElementById("a").getBoundingClientRect();
      return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.className;
    });
    check("fixture: the cover sits over the image (a right-click would never reach the <img>)", covered === "screen", covered);

    await translateOnScreen(run, tabId);
    const s = await waitFor(() => overlayState(page), (st) => st.chips.length === 2 && st.chips.every((c) => c === "已翻譯 2 處文字"), { label: "two done chips" });
    await run.writeJson("01-spread.json", s);
    await run.screenshot(page, "01-spread.png");

    const calls = run.calls.filter((c) => hasImage(c.body));
    const images = calls.map((c) => c.body.messages.at(-1).content.filter((x) => x.type === "image"));
    check("two API calls, each carrying exactly one JPEG", calls.length === 2 && images.every((i) => i.length === 1 && i[0].source.media_type === "image/jpeg" && i[0].source.data.length > 1000), { calls: calls.length });
    const sizes = calls.map((c) => imageSizeOf(c.body));
    check("each carries the image at its NATURAL size (900x1280), not the 300x427 it is shown at", sizes.length === 2 && sizes.every((z) => z?.width === 900 && z?.height === 1280), sizes);
    check("the icon (100x100) was not sent", calls.length === 2, calls.length);

    const a = overlayFor(s, s.imgs.a);
    const b = overlayFor(s, s.imgs.b);
    check("an overlay with two regions sits over each page, boxes where the mock said, ±2px", !!a.container && !!b.container && a.placed && b.placed, { a, b });
    check("no overlay over the icon", !s.images.some((c) => sameRect(c.box, s.imgs.icon)), s.images.map((c) => c.box));
    check("fill was sampled from the sent pixels (white bubbles)", s.images.every((c) => c.fills.length === 2 && c.fills.every((f) => /^rgb\(2[0-9]{2}, 2[0-9]{2}, 2[0-9]{2}\)$/.test(f))), s.images.map((c) => c.fills));

    const logs = (await run.logs()).filter((l) => l.includes("[llmt] image"));
    await run.writeJson("02-worker-logs.json", logs);
    check("the worker logged both as original 900x1280", logs.length === 2 && logs.every((l) => /original 900x1280/.test(l)), logs);
    check("page translation was not started (no <llmt-translation> nodes)", (await pageState(page)).done === 0, null);
  } catch (err) {
    check("same-origin journey ran to completion", false, String(err?.stack ?? err));
  } finally {
    await run.close();
  }
}

// ---------------------------------------------------------------------------
// 2. Page A comes from another origin without CORS: its canvas is tainted, so it goes by screenshot.

{
  const far = await farImageServer();
  const run = await launch({ name: "image-screen-tainted" });
  try {
    const { page, tabId } = await openSpread(run, { farUrl: far.url });
    await translateOnScreen(run, tabId);
    const s = await waitFor(() => overlayState(page), (st) => st.chips.length === 2 && st.chips.every((c) => c === "已翻譯 2 處文字"), { label: "two done chips" });
    await run.writeJson("03-tainted.json", s);
    await run.screenshot(page, "03-tainted.png");

    const calls = run.calls.filter((c) => hasImage(c.body));
    const sizes = calls.map((c) => imageSizeOf(c.body));
    const shotSize = sizes.find((z) => z && z.width !== 900);
    check("two API calls: B sends its original (900x1280), A falls back to a screenshot of its box", calls.length === 2 && sizes.some((z) => z?.width === 900 && z?.height === 1280) && shotSize && near(shotSize.width, s.imgs.a.width) && near(shotSize.height, s.imgs.a.height), { sizes, a: s.imgs.a });
    const a = overlayFor(s, s.imgs.a);
    const b = overlayFor(s, s.imgs.b);
    check("both pages still get their overlay in the right place", !!a.container && !!b.container && a.placed && b.placed, { a, b });
    const logs = (await run.logs()).filter((l) => l.includes("[llmt] image"));
    check("the worker logged one original and one screenshot", logs.length === 2 && logs.some((l) => /\| original 900x1280/.test(l)) && logs.some((l) => /\| screenshot /.test(l)), logs);
  } catch (err) {
    check("tainted-canvas journey ran to completion", false, String(err?.stack ?? err));
  } finally {
    await run.close();
    far.server.close();
  }
}

// ---------------------------------------------------------------------------
// 3. Nothing big enough on screen: a toast, no API call.

{
  const run = await launch({ name: "image-screen-none" });
  try {
    const { page, tabId } = await openSpread(run);
    await page.evaluate(() => {
      for (const id of ["a", "b"]) document.getElementById(id).style.display = "none";
    });
    await translateOnScreen(run, tabId);
    const s = await waitFor(() => pageState(page), (st) => st.toast !== null, { label: "the no-images toast" });
    check("no image on screen: toast says so, no API call, nothing drawn", s.toast.message === "無法翻譯這張圖片：畫面上沒有可翻譯的圖片" && run.calls.length === 0 && !(await overlayState(page)).layer, { toast: s.toast, calls: run.calls.length });
  } catch (err) {
    check("no-images journey ran to completion", false, String(err?.stack ?? err));
  } finally {
    await run.close();
  }
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `${failed.length} check(s) failed` : "all checks passed");
console.log("NOT verified: the page-context menu item itself and its click (browser UI), a real API response.");
process.exit(failed.length ? 1 : 0);
