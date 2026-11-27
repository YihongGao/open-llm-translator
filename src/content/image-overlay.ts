// Draws translated text over speech bubbles. One Shadow DOM layer covers the
// viewport (page CSS cannot restyle it, ours cannot leak); each translated
// image gets a container that follows the <img>'s box, holding one box per
// region and a small status chip. The page's own DOM is never touched: the
// <img> keeps its src, and the boxes ignore pointer events so manga viewers
// still turn pages on click.

import { parseUiLanguage, setUiLanguage, t } from "../shared/i18n";
import type { ImageLocateResult, ImageMessage, ImageRegion, ImageTarget, LocatedImage, ViewRect } from "../shared/messages";
import { captureOriginal, pickScreenImages } from "./image-source";
import { hideToast, showToast } from "./toast";

export const IMAGE_LAYER_TAG = "llmt-image-layer";

/** Smaller than this (CSS px, the visible part) there is nothing worth reading. */
const MIN_VISIBLE_PX = 64;
const MIN_FONT_PX = 9;
const MAX_FONT_PX = 40;
const BOX_PADDING_PX = 3;
/** Gives up waiting for animation frames in a background tab, where none are delivered. */
const FRAME_WAIT_MS = 250;

const CSS = `
:host { all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483646; }
.image { position: absolute; pointer-events: none; }
.region {
  position: absolute; box-sizing: border-box; overflow: hidden; display: flex; align-items: center; justify-content: center;
  padding: ${BOX_PADDING_PX}px; text-align: center; line-height: 1.2;
  font-family: system-ui, -apple-system, "PingFang TC", "Noto Sans TC", "Hiragino Sans", sans-serif; font-weight: 600;
}
.t { flex: none; width: 100%; overflow-wrap: anywhere; }
.region.vertical .t { width: auto; height: 100%; writing-mode: vertical-rl; text-orientation: upright; }
.tcy { text-combine-upright: all; }
.patch { position: absolute; }
.image.original .region, .image.original .patch { display: none; }
.chip {
  position: absolute; display: flex; align-items: center; gap: 2px; pointer-events: auto;
  padding: 2px 4px 2px 10px; border-radius: 999px; background: rgba(24, 24, 27, .88); color: #fff;
  font: 12px/1.4 system-ui, -apple-system, "PingFang TC", "Noto Sans TC", sans-serif; box-shadow: 0 2px 8px rgba(0, 0, 0, .35);
}
.chip[hidden], .chip button[hidden] { display: none; }
.status { margin-right: 4px; }
.chip button {
  all: unset; cursor: pointer; padding: 1px 8px; border-radius: 999px; font-size: 12px;
}
.chip button:hover, .chip button:focus-visible { background: rgba(255, 255, 255, .22); }
.chip.error .status { color: #ffb4a9; }
`;

interface RegionEntry {
  el: HTMLElement;
  inner: HTMLElement;
  vertical: boolean;
  /** Largest font size (px) at which this region's text fits its box; set by fit(). */
  fitPx: number;
}

interface Job {
  id: string;
  img: HTMLImageElement;
  box: HTMLElement;
  chip: HTMLElement;
  status: HTMLElement;
  toggle: HTMLButtonElement;
  regions: RegionEntry[];
  /** "waiting": the screenshot is not taken yet, so nothing of ours may be visible. */
  state: "waiting" | "translating" | "done" | "error";
  partial: boolean;
  showingOriginal: boolean;
  /** Size the regions were last fitted at, to refit only when the image box changes. */
  fittedAt: { width: number; height: number } | null;
  attrs: MutationObserver;
}

const jobs = new Map<HTMLImageElement, Job>();
const byId = new Map<string, Job>();
let layer: { host: HTMLElement; root: ShadowRoot } | null = null;
let nextJob = 0;
let frame = 0;
let resizes: ResizeObserver | null = null;

export function isImageMessage(msg: unknown): msg is ImageMessage {
  return typeof (msg as { type?: unknown } | null)?.type === "string" && (msg as { type: string }).type.startsWith("llmt-image-");
}

/** Returns true when it will answer asynchronously (only "locate" is answered). */
export function handleImageMessage(msg: ImageMessage, sendResponse: (r: ImageLocateResult) => void): boolean {
  // Content scripts cannot read storage: the chip and toasts follow the language the job was started in.
  if (msg.type === "llmt-image-locate" || msg.type === "llmt-image-end") setUiLanguage(parseUiLanguage(msg.uiLanguage));
  switch (msg.type) {
    case "llmt-image-locate":
      void locateImages(msg.target).then(sendResponse);
      return true;
    case "llmt-image-captured": {
      const job = byId.get(msg.jobId);
      if (job) setState(job, "translating");
      return false;
    }
    case "llmt-image-region": {
      const job = byId.get(msg.jobId);
      if (job) addRegion(job, msg.region);
      return false;
    }
    case "llmt-image-end":
      endJob(msg);
      return false;
  }
}

// --- locating -------------------------------------------------------------------

function viewport(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight };
}

function visibleRect(r: DOMRect, vp: { width: number; height: number }): ViewRect {
  const x = Math.max(0, r.left);
  const y = Math.max(0, r.top);
  return { x, y, width: Math.max(0, Math.min(r.right, vp.width) - x), height: Math.max(0, Math.min(r.bottom, vp.height) - y) };
}

const rectOf = (r: DOMRect): ViewRect => ({ x: r.left, y: r.top, width: r.width, height: r.height });

interface Found {
  img: HTMLImageElement;
  rect: DOMRect;
  visible: ViewRect;
}

/**
 * Finds the images to translate, replaces their overlays, and answers once our
 * own pixels are gone from the screen so the screenshot shows the bare images.
 * Images are found by their boxes, never by hit testing: manga viewers cover them
 * with transparent elements and cancel right-clicks on the <img>.
 */
async function locateImages(target: ImageTarget): Promise<ImageLocateResult> {
  hideToast();
  const vp = viewport();
  const found = target.kind === "src" ? findBySrc(target.srcUrl, vp) : findOnScreen(vp);
  if (!Array.isArray(found)) return found;

  for (const { img } of found) {
    const old = jobs.get(img);
    if (old) removeJob(old);
  }
  const created = found.map(({ img }) => ({ img, job: createJob(img) }));
  await twoFrames();
  // The page may have moved while we waited; measure again.
  const images = await Promise.all(
    created.map(async ({ img, job }): Promise<LocatedImage> => {
      const rect = img.getBoundingClientRect();
      const visible = visibleRect(rect, vp);
      return { jobId: job.id, image: rectOf(rect), visible, original: await captureOriginal(img, rect, visible) };
    }),
  );
  return { ok: true, viewport: vp, images };
}

function findBySrc(srcUrl: string, vp: { width: number; height: number }): Found[] | Extract<ImageLocateResult, { ok: false }> {
  let best: Found | null = null;
  for (const img of document.querySelectorAll("img")) {
    if (!srcUrl || (img.currentSrc !== srcUrl && img.src !== srcUrl)) continue;
    const rect = img.getBoundingClientRect();
    const visible = visibleRect(rect, vp);
    // The same picture can appear several times (thumbnails, repeated panels): take the one most on screen.
    if (!best || visible.width * visible.height > best.visible.width * best.visible.height) best = { img, rect, visible };
  }
  if (!best) return { ok: false, reason: "not-found" };
  if (best.visible.width < MIN_VISIBLE_PX || best.visible.height < MIN_VISIBLE_PX) return { ok: false, reason: "not-visible" };
  return [best];
}

function findOnScreen(vp: { width: number; height: number }): Found[] | Extract<ImageLocateResult, { ok: false }> {
  const all: Found[] = [];
  for (const img of document.querySelectorAll("img")) {
    if (getComputedStyle(img).visibility === "hidden") continue;
    const rect = img.getBoundingClientRect();
    all.push({ img, rect, visible: visibleRect(rect, vp) });
  }
  const picked = pickScreenImages(all);
  return picked.length ? picked : { ok: false, reason: "no-images" };
}

function twoFrames(): Promise<void> {
  const frames = new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  return Promise.race([frames, new Promise<void>((resolve) => setTimeout(resolve, FRAME_WAIT_MS))]);
}

// --- jobs -----------------------------------------------------------------------

function ensureLayer(): ShadowRoot {
  if (layer?.host.isConnected) return layer.root;
  const host = document.createElement(IMAGE_LAYER_TAG);
  host.setAttribute("translate", "no");
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = CSS;
  root.append(style);
  document.documentElement.append(host);
  layer = { host, root };
  window.addEventListener("scroll", schedule, { capture: true, passive: true });
  window.addEventListener("resize", schedule, { passive: true });
  resizes = new ResizeObserver(schedule);
  return root;
}

function createJob(img: HTMLImageElement): Job {
  const root = ensureLayer();
  const box = el("div", "image");
  const chip = el("div", "chip");
  const status = el("span", "status");
  const toggle = el("button") as HTMLButtonElement;
  toggle.type = "button";
  const remove = el("button") as HTMLButtonElement;
  remove.type = "button";
  remove.textContent = "✕";
  remove.setAttribute("aria-label", t("imageRemove"));
  remove.title = t("imageRemove");
  chip.append(status, toggle, remove);
  // The chip sits over the page: its clicks are ours, not the page's (viewers turn pages on click).
  for (const type of ["click", "mousedown", "mouseup", "pointerdown", "pointerup", "dblclick"])
    chip.addEventListener(type, (e) => e.stopPropagation());
  box.append(chip);
  root.append(box);

  const job: Job = {
    id: `img-${++nextJob}`,
    img,
    box,
    chip,
    status,
    toggle,
    regions: [],
    state: "waiting",
    partial: false,
    showingOriginal: false,
    fittedAt: null,
    attrs: new MutationObserver(() => removeJob(job)),
  };
  toggle.addEventListener("click", () => {
    job.showingOriginal = !job.showingOriginal;
    box.classList.toggle("original", job.showingOriginal);
    render(job);
  });
  remove.addEventListener("click", () => removeJob(job));
  // A different picture in the same <img> makes the translation wrong.
  job.attrs.observe(img, { attributes: true, attributeFilter: ["src", "srcset"] });
  resizes?.observe(img);
  jobs.set(img, job);
  byId.set(job.id, job);
  render(job);
  position(job);
  return job;
}

function el(tag: string, className?: string): HTMLElement {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

function removeJob(job: Job): void {
  job.attrs.disconnect();
  resizes?.unobserve(job.img);
  job.box.remove();
  jobs.delete(job.img);
  byId.delete(job.id);
  if (jobs.size) return;
  // Last one: leave nothing behind.
  window.removeEventListener("scroll", schedule, { capture: true });
  window.removeEventListener("resize", schedule);
  resizes?.disconnect();
  resizes = null;
  cancelAnimationFrame(frame);
  frame = 0;
  layer?.host.remove();
  layer = null;
}

function setState(job: Job, state: Job["state"]): void {
  job.state = state;
  render(job);
}

function render(job: Job): void {
  const n = job.regions.length;
  job.chip.hidden = job.state === "waiting";
  job.chip.classList.toggle("error", job.state === "error");
  job.toggle.hidden = job.state !== "done" || n === 0;
  job.toggle.textContent = job.showingOriginal ? t("imageShowTranslation") : t("imageShowOriginal");
  job.status.textContent =
    job.state === "error"
      ? t("imageStatusFailed")
      : job.state !== "done"
        ? t("imageStatusTranslating")
        : n === 0
          ? t("imageStatusNone")
          : t(job.partial ? "imageStatusPartial" : "imageStatusDone", String(n));
}

function addRegion(job: Job, region: ImageRegion): void {
  const [x0, y0, x1, y1] = region.box;
  const box = el("div", region.vertical ? "region vertical" : "region");
  const inner = el("div", "t");
  // Text nodes only: the text came from a model reading untrusted pixels.
  if (region.vertical) inner.append(...verticalRuns(region.text));
  else inner.textContent = region.text;
  box.style.cssText = `${placeAt(region.box)};color:${region.ink}`;
  box.append(inner);
  // Before the chip, so the chip stays on top.
  job.box.insertBefore(box, job.chip);
  // Under every region's text, so a bubble's cover never hides a neighbour's translation.
  job.box.prepend(coverPatch(region));
  const entry: RegionEntry = { el: box, inner, vertical: region.vertical, fitPx: MIN_FONT_PX };
  job.regions.push(entry);
  fit(entry);
  applyJobFont(job);
  render(job);
}

const placeAt = ([x0, y0, x1, y1]: readonly number[]) =>
  `left:${x0! * 100}%;top:${y0! * 100}%;width:${(x1! - x0!) * 100}%;height:${(y1! - y0!) * 100}%`;

/** The region's fill, clipped to its cover polygon (the bubble's inside). */
function coverPatch(region: ImageRegion): HTMLElement {
  const xs = region.cover.map(([x]) => x);
  const ys = region.cover.map(([, y]) => y);
  const [x0, y0, x1, y1] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const rel = (v: number, lo: number, hi: number) => (hi > lo ? Math.round(((v - lo) / (hi - lo)) * 10000) / 100 : 0);
  const points = region.cover.map(([x, y]) => `${rel(x, x0, x1)}% ${rel(y, y0, y1)}%`).join(",");
  const patch = el("div", "patch");
  patch.style.cssText = `${placeAt([x0, y0, x1, y1])};background:${region.fill};clip-path:polygon(${points})`;
  return patch;
}

/** Runs of one or two half-width letters or digits ("50", "L2"), set side by side in one vertical cell. */
const TATE_CHU_YOKO = /(?<![0-9A-Za-z])([0-9A-Za-z]{1,2})(?![0-9A-Za-z])/;

/** Text nodes for vertical text, with short Latin runs wrapped for tate-chu-yoko. */
export function verticalRuns(text: string): Node[] {
  return text.split(TATE_CHU_YOKO).map((part, i) => {
    if (i % 2 === 0) return document.createTextNode(part);
    const span = document.createElement("span");
    span.className = "tcy";
    span.textContent = part;
    return span;
  });
}

/**
 * One font size for the whole image, like the lettering of a printed page: the
 * median of what each region could fit, and no larger than what a region fits.
 * Sizing each box on its own gave 40px in one bubble and 12px next to it.
 */
function applyJobFont(job: Job): void {
  const fits = job.regions.map((r) => r.fitPx).sort((a, b) => a - b);
  const median = fits[Math.floor(fits.length / 2)] ?? MIN_FONT_PX;
  for (const r of job.regions) r.el.style.fontSize = `${Math.min(r.fitPx, median)}px`;
}

function endJob(msg: Extract<ImageMessage, { type: "llmt-image-end" }>): void {
  const job = byId.get(msg.jobId);
  if (msg.error) {
    if (job) {
      setState(job, "error");
      job.status.title = msg.error.message;
    }
    // A job that never started (iframe, image not found) has only the toast to say so.
    if (job || msg.jobId === "") showImageError(msg.error.message, msg.error.settings);
    return;
  }
  if (!job) return;
  job.partial = msg.partial;
  setState(job, "done");
}

function showImageError(message: string, settings: boolean): void {
  showToast({
    message: t("toastImageFailed", message),
    action: settings
      ? { label: t("openSettings"), onClick: () => void chrome.runtime.sendMessage({ type: "llmt-open-options" }) }
      : undefined,
    autoHideMs: settings ? undefined : 10000,
  });
}

// --- layout ---------------------------------------------------------------------

/** One reposition per frame, however many scroll/resize events arrive. */
function schedule(): void {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    for (const job of [...jobs.values()]) position(job);
  });
}

/** Puts the job's container on the image's current box, clipped to the viewport. */
function position(job: Job): void {
  if (!job.img.isConnected) return removeJob(job);
  const r = job.img.getBoundingClientRect();
  const vp = viewport();
  const s = job.box.style;
  s.display = r.width > 0 && r.height > 0 ? "" : "none";
  s.left = `${r.left}px`;
  s.top = `${r.top}px`;
  s.width = `${r.width}px`;
  s.height = `${r.height}px`;
  const cut = { top: Math.max(0, -r.top), right: Math.max(0, r.right - vp.width), bottom: Math.max(0, r.bottom - vp.height), left: Math.max(0, -r.left) };
  s.clipPath = `inset(${cut.top}px ${cut.right}px ${cut.bottom}px ${cut.left}px)`;
  // Keep the chip on screen while the image's corner is scrolled out of view.
  job.chip.style.top = `${cut.top + 6}px`;
  job.chip.style.right = `${cut.right + 6}px`;
  if (job.fittedAt?.width !== r.width || job.fittedAt?.height !== r.height) {
    job.fittedAt = { width: r.width, height: r.height };
    for (const entry of job.regions) fit(entry);
    applyJobFont(job);
  }
}

/**
 * Largest font size at which the text fits its box (binary search over
 * integers; each probe is one layout). Text that does not fit even at the
 * minimum is clipped by the box rather than spilling over the artwork.
 */
function fit(entry: RegionEntry): void {
  const { el: box, inner, vertical } = entry;
  const availW = box.clientWidth - 2 * BOX_PADDING_PX;
  const availH = box.clientHeight - 2 * BOX_PADDING_PX;
  if (availW <= 0 || availH <= 0) return; // no layout yet (hidden or detached); position() fits again later
  const fits = () => (vertical ? inner.offsetWidth <= availW : inner.offsetHeight <= availH) && inner.scrollWidth <= inner.clientWidth + 1;
  let lo = MIN_FONT_PX;
  let hi = Math.max(MIN_FONT_PX, Math.min(MAX_FONT_PX, Math.floor(vertical ? availW : availH)));
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    box.style.fontSize = `${mid}px`;
    if (fits()) lo = mid;
    else hi = mid - 1;
  }
  box.style.fontSize = `${lo}px`;
  entry.fitPx = lo;
}
