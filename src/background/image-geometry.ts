// Coordinate maths for image translation, kept free of canvas and chrome APIs.
//
// Three spaces are involved:
//   - CSS px of the viewport (what getBoundingClientRect reports),
//   - device px of the screenshot (CSS px x devicePixelRatio x page zoom),
//   - px of the image that is sent to the model (the crop, downscaled).
// The screenshot's size relative to the viewport gives the first scale, so DPR
// and zoom need no separate handling.

import type { ViewRect } from "../shared/messages";

export interface Size {
  width: number;
  height: number;
}

/** A ViewRect in device px of the screenshot. */
export type Crop = ViewRect;

/** Part of the screenshot that shows `visible`, in device px, clamped to the screenshot. */
export function cropFor(visible: ViewRect, viewport: Size, bitmap: Size): Crop {
  const sx = bitmap.width / viewport.width;
  const sy = bitmap.height / viewport.height;
  const x0 = Math.max(0, Math.floor(visible.x * sx));
  const y0 = Math.max(0, Math.floor(visible.y * sy));
  const x1 = Math.min(bitmap.width, Math.ceil((visible.x + visible.width) * sx));
  const y1 = Math.min(bitmap.height, Math.ceil((visible.y + visible.height) * sy));
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

/** Size of the image sent to the model: the crop, scaled down so its long edge is at most `maxEdge`. */
export function sentSize(crop: Size, maxEdge: number): Size {
  const scale = Math.min(1, maxEdge / Math.max(crop.width, crop.height));
  return { width: Math.max(1, Math.round(crop.width * scale)), height: Math.max(1, Math.round(crop.height * scale)) };
}

/** Per side, as a share of the box's own width/height. Measured boxes are slightly tight (spike, 2026-11). */
export const BOX_PAD = 0.15;

/**
 * Horizontal padding for boxes taller than wide (vertical source text). On
 * vertical Japanese the model's boxes often leave the first or last column
 * outside (Sonnet 5.5, mangaz, 2026-11-27); 15% was not enough to cover it.
 */
export const TALL_BOX_PAD_X = 0.3;

export interface Pad {
  x: number;
  y: number;
}

/** Padding per side for a box in px: wider for tall boxes, whose columns the model tends to cut off. */
export function padFor(pxBox: readonly [number, number, number, number]): Pad {
  const [x0, y0, x1, y1] = pxBox;
  return { x: y1 - y0 >= 1.1 * (x1 - x0) ? TALL_BOX_PAD_X : BOX_PAD, y: BOX_PAD };
}

/** Padding of the outline the fill colour is sampled on. */
export const SAMPLE_PAD = 0.08;

const asPad = (pad: number | Pad): Pad => (typeof pad === "number" ? { x: pad, y: pad } : pad);

/**
 * A box in the sent image (px) as a padded box in fractions (0-1) of the image
 * element's box. The sent image shows `visible`; `image` is the whole element.
 */
export function toImageFractions(
  pxBox: readonly [number, number, number, number],
  sent: Size,
  visible: ViewRect,
  image: ViewRect,
  pad: number | Pad = padFor(pxBox),
): [number, number, number, number] {
  const [x0, y0, x1, y1] = pxBox;
  const p = asPad(pad);
  const dx = (x1 - x0) * p.x;
  const dy = (y1 - y0) * p.y;
  const fx = (px: number) => clamp01((visible.x + (px / sent.width) * visible.width - image.x) / image.width);
  const fy = (py: number) => clamp01((visible.y + (py / sent.height) * visible.height - image.y) / image.height);
  return [fx(x0 - dx), fy(y0 - dy), fx(x1 + dx), fy(y1 + dy)];
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Target languages whose comics read top-to-bottom. */
const VERTICAL_LANGS = new Set(["zh-TW", "zh-CN", "ja"]);

/**
 * Vertical text when the target language allows it and the box is taller than
 * wide. Bubbles of vertical Japanese are mostly only a little taller than wide;
 * a stricter ratio (1.6 was tried) set them horizontally, mixed with vertical
 * neighbours on the same page (mangaz, 2026-11-27).
 */
export function isVertical(pxBox: readonly [number, number, number, number], targetLang: string): boolean {
  if (!VERTICAL_LANGS.has(targetLang)) return false;
  const [x0, y0, x1, y1] = pxBox;
  return y1 - y0 >= 1.1 * (x1 - x0);
}

export type Rgb = readonly [number, number, number];

const median = (v: number[]) => v.sort((a, b) => a - b)[Math.floor(v.length / 2)] ?? 255;

/** Per-channel median: a few dark outliers (the bubble outline, a glyph) do not tint it. */
export function medianRgb(samples: readonly Rgb[]): Rgb {
  if (!samples.length) return [255, 255, 255];
  return [0, 1, 2].map((c) => median(samples.map((s) => s[c]!))) as unknown as Rgb;
}

/** Background colour as the per-channel median of `samples`, and the text colour that reads on it. */
export function pickFill(samples: readonly Rgb[]): { fill: string; ink: string } {
  const [r, g, b] = medianRgb(samples);
  // Rec. 709 relative luminance on the gamma-encoded values: enough to pick black or white.
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return { fill: `rgb(${r}, ${g}, ${b})`, ink: luminance > 0.5 ? "#111111" : "#ffffff" };
}

/**
 * Pixels along the outline of `box` (px of an RGBA image `width` wide), every
 * `step` px. The outline sits just outside the glyphs (SAMPLE_PAD), on the
 * bubble's background: the wider padding the overlay draws with reaches past
 * the bubble into the artwork and sampled grey screentone (mangaz, 2026-11-27).
 */
export function perimeterSamples(
  rgba: Uint8ClampedArray,
  size: Size,
  box: readonly [number, number, number, number],
  pad: number | Pad = SAMPLE_PAD,
  step = 2,
): Rgb[] {
  const [x0, y0, x1, y1] = box;
  const p = asPad(pad);
  const dx = (x1 - x0) * p.x;
  const dy = (y1 - y0) * p.y;
  const left = clampInt(x0 - dx, size.width);
  const right = clampInt(x1 + dx, size.width);
  const top = clampInt(y0 - dy, size.height);
  const bottom = clampInt(y1 + dy, size.height);
  const out: Rgb[] = [];
  const at = (x: number, y: number) => {
    const i = (y * size.width + x) * 4;
    out.push([rgba[i]!, rgba[i + 1]!, rgba[i + 2]!]);
  };
  for (let x = left; x <= right; x += step) {
    at(x, top);
    at(x, bottom);
  }
  for (let y = top; y <= bottom; y += step) {
    at(left, y);
    at(right, y);
  }
  return out;
}

const clampInt = (v: number, size: number) => Math.min(size - 1, Math.max(0, Math.round(v)));

export type PxBox = readonly [x0: number, y0: number, x1: number, y1: number];
export type Point = readonly [x: number, y: number];

/**
 * How far past the text box the bubble is searched for, per side: half the box's long side. A
 * one-column box can miss a column wider than itself, so a share of its own width is not enough.
 */
function searchPad([x0, y0, x1, y1]: PxBox): Pad {
  const reach = Math.max(x1 - x0, y1 - y0) / 2;
  return { x: reach / Math.max(1, x1 - x0), y: reach / Math.max(1, y1 - y0) };
}
/** Largest per-channel difference from the sampled background that still counts as bubble background. */
const BACKGROUND_TOLERANCE = 48;
/** Share of a side of the search area the flood may reach before it counts as having leaked out there. */
const LEAK_SHARE = 0.03;
/** Rows per vertex pair of the cover outline at most this many bands tall. */
const MAX_BANDS = 24;

/**
 * Where to paint over the original text (`shape`, a polygon) and where to lay the
 * translation out (`text`, a box inside it), both in px of the sent image.
 *
 * A padded rectangle around the text reaches past round bubbles into the artwork
 * (mangaz, 2026-11-27). Instead the bubble's background is flooded from the text
 * box (pixels within BACKGROUND_TOLERANCE of `background`) and the cover follows
 * it row by row, so it stops at the bubble outline. Where the flood runs out of
 * the search area along a side it found no outline there (text on open artwork,
 * screentone, a bubble joined to the next one): that side is cut to the padded
 * rectangle the overlay used before.
 */
export function coverFor(rgba: Uint8ClampedArray, size: Size, box: PxBox, background: Rgb): { shape: Point[]; text: PxBox } {
  const [bx0, by0, bx1, by1] = box.map(Math.round) as [number, number, number, number];
  const padded = paddedBox(box, padFor(box), size);
  const search = paddedBox(box, searchPad(box), size);
  const [sx0, sy0, sx1, sy1] = search;
  const w = sx1 - sx0 + 1;
  const h = sy1 - sy0 + 1;
  const isBackground = (x: number, y: number) => {
    const i = (y * size.width + x) * 4;
    return (
      Math.abs(rgba[i]! - background[0]) <= BACKGROUND_TOLERANCE &&
      Math.abs(rgba[i + 1]! - background[1]) <= BACKGROUND_TOLERANCE &&
      Math.abs(rgba[i + 2]! - background[2]) <= BACKGROUND_TOLERANCE
    );
  };

  // Flood fill from the background pixels in the middle half of the text box. The model's box can
  // stick out of the bubble (mangaz, a burst bubble boxed down into the white road below it);
  // its middle is inside.
  const reached = new Uint8Array(w * h);
  const queue: number[] = [];
  const [qx, qy] = [(bx1 - bx0) / 4, (by1 - by0) / 4];
  for (let y = Math.max(Math.round(by0 + qy), sy0); y <= Math.min(Math.round(by1 - qy), sy1); y++)
    for (let x = Math.max(Math.round(bx0 + qx), sx0); x <= Math.min(Math.round(bx1 - qx), sx1); x++)
      if (isBackground(x, y)) {
        reached[(y - sy0) * w + (x - sx0)] = 1;
        queue.push(x, y);
      }
  for (let q = 0; q < queue.length; q += 2) {
    const x = queue[q]!;
    const y = queue[q + 1]!;
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as const) {
      if (nx < sx0 || nx > sx1 || ny < sy0 || ny > sy1) continue;
      const k = (ny - sy0) * w + (nx - sx0);
      if (reached[k] || !isBackground(nx, ny)) continue;
      reached[k] = 1;
      queue.push(nx, ny);
    }
  }

  // A side leaked when the flood reached too much of it. A side on the image border does not count:
  // a bubble cut off by the page edge legitimately reaches it.
  const share = (n: number, at: (i: number) => number) => {
    let hit = 0;
    for (let i = 0; i < n; i++) hit += reached[at(i)]!;
    return hit / n;
  };
  const leaks = (onBorder: boolean, n: number, at: (i: number) => number) => !onBorder && share(n, at) > LEAK_SHARE;
  const lx0 = leaks(sx0 === 0, h, (i) => i * w) ? padded[0] : sx0;
  const lx1 = leaks(sx1 === size.width - 1, h, (i) => i * w + w - 1) ? padded[2] : sx1;
  const ly0 = leaks(sy0 === 0, w, (i) => i) ? padded[1] : sy0;
  const ly1 = leaks(sy1 === size.height - 1, w, (i) => (h - 1) * w + i) ? padded[3] : sy1;

  // Row spans of the flood, always covering the text box itself.
  const spans: ([number, number] | null)[] = [];
  for (let y = ly0; y <= ly1; y++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let x = lx0; x <= lx1; x++)
      if (reached[(y - sy0) * w + (x - sx0)]) {
        lo = Math.min(lo, x);
        hi = Math.max(hi, x);
      }
    if (y >= by0 && y <= by1) {
      lo = Math.min(lo, Math.max(bx0, lx0));
      hi = Math.max(hi, Math.min(bx1, lx1));
    }
    spans.push(lo <= hi ? [lo, hi] : null);
  }
  const rowOf = (y: number) => spans[y - ly0] ?? null;

  // The flood is connected and contains text box rows, so its rows are one run.
  const rows = spans.flatMap((s, i) => (s ? [ly0 + i] : []));
  if (!rows.length) return { shape: corners(padded), text: padded };
  const top = rows[0]!;
  const bottom = rows.at(-1)! + 1;

  // Outline: the union of each band's spans, left side down, right side up.
  const band = Math.max(1, Math.ceil((bottom - top) / MAX_BANDS));
  const left: Point[] = [];
  const right: Point[] = [];
  for (let y = top; y < bottom; y += band) {
    const end = Math.min(bottom, y + band);
    let lo = Infinity;
    let hi = -Infinity;
    for (let r = y; r < end; r++) {
      const s = rowOf(r);
      if (s) {
        lo = Math.min(lo, s[0]);
        hi = Math.max(hi, s[1] + 1);
      }
    }
    // One vertex per band, at its middle row: corners at the band's edges would step out past a
    // round bubble wherever its outline curves.
    left.push([lo, (y + end) / 2]);
    right.push([hi, (y + end) / 2]);
  }
  // The first and last rows close it off at their own width, not their band's.
  const [first, last] = [rowOf(top)!, rowOf(bottom - 1)!];
  left.unshift([first[0], top]);
  right.unshift([first[1] + 1, top]);
  left.push([last[0], bottom]);
  right.push([last[1] + 1, bottom]);
  const shape = [...left, ...right.reverse()];

  // Text: as wide as the bubble is on every row of the text box, then as tall as that width allows,
  // inside the padded rectangle so it reads like the overlay did before.
  let tx0 = padded[0];
  let tx1 = padded[2] + 1;
  for (let y = Math.max(by0, top); y < Math.min(by1, bottom); y++) {
    const s = rowOf(y);
    if (!s) continue;
    tx0 = Math.max(tx0, s[0]);
    tx1 = Math.min(tx1, s[1] + 1);
  }
  tx0 = Math.min(tx0, bx0);
  tx1 = Math.max(tx1, bx1);
  const fits = (y: number) => {
    const s = rowOf(y);
    return !!s && s[0] <= tx0 && s[1] + 1 >= tx1;
  };
  let ty0 = by0;
  let ty1 = by1;
  while (ty0 > Math.max(padded[1], top) && fits(ty0 - 1)) ty0--;
  while (ty1 < Math.min(padded[3] + 1, bottom) && fits(ty1)) ty1++;
  return { shape, text: [tx0, ty0, tx1, ty1] };
}

/** `box` padded by `pad`, in whole px inside the image (last pixel inclusive). */
function paddedBox(box: PxBox, pad: Pad, size: Size): [number, number, number, number] {
  const [x0, y0, x1, y1] = box;
  const dx = (x1 - x0) * pad.x;
  const dy = (y1 - y0) * pad.y;
  return [clampInt(x0 - dx, size.width), clampInt(y0 - dy, size.height), clampInt(x1 + dx, size.width), clampInt(y1 + dy, size.height)];
}

const corners = ([x0, y0, x1, y1]: PxBox): Point[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

/** A point in px of the sent image as fractions (0-1) of the image element's box. */
export function toImagePoint([px, py]: Point, sent: Size, visible: ViewRect, image: ViewRect): [number, number] {
  return [
    clamp01((visible.x + (px / sent.width) * visible.width - image.x) / image.width),
    clamp01((visible.y + (py / sent.height) * visible.height - image.y) / image.height),
  ];
}
