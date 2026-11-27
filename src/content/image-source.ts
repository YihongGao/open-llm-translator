// Which images on screen to translate, and whether the page lets us read an
// image's own pixels. The decisions are pure functions of measured facts so they
// can be tested without layout; the measuring and the canvas read are at the bottom.

import { sentSize } from "../background/image-geometry";
import type { OriginalImage, ViewRect } from "../shared/messages";

/** Smaller than this (CSS px, the visible part, either side) an image is not offered by "translate images on screen". */
export const MIN_SCREEN_IMAGE_PX = 160;
export const MAX_SCREEN_IMAGES = 4;
/** Long edge of the original sent to the model; same as the screenshot path. */
const MAX_EDGE = 1568;
const JPEG_QUALITY = 0.9;

/** Images worth translating: visible part big enough on both sides, largest visible area first (ties keep page order), at most `max`. */
export function pickScreenImages<T extends { visible: ViewRect }>(items: readonly T[], min = MIN_SCREEN_IMAGE_PX, max = MAX_SCREEN_IMAGES): T[] {
  return items
    .filter((i) => i.visible.width >= min && i.visible.height >= min)
    .map((item, order) => ({ item, order, area: item.visible.width * item.visible.height }))
    .sort((a, b) => b.area - a.area || a.order - b.order)
    .slice(0, max)
    .map((e) => e.item);
}

export interface OriginalFacts {
  complete: boolean;
  naturalWidth: number;
  naturalHeight: number;
  renderedWidth: number;
  renderedHeight: number;
  /** The whole element is inside the viewport. */
  fullyVisible: boolean;
  objectFit: string;
  /** No padding or border: the element's box is the picture's box. */
  plainBox: boolean;
  /** Something between the image and the viewport rotates, flips or skews it (scaling and moving are harmless: boxes are fractions). */
  transformed: boolean;
}

/** True when the image's file pixels line up with its on-screen box, so boxes found in them map onto the element. */
export function canSendOriginal(f: OriginalFacts): boolean {
  if (!f.complete || f.naturalWidth <= 0 || f.naturalHeight <= 0 || f.renderedWidth <= 0 || f.renderedHeight <= 0) return false;
  if (!f.fullyVisible || !f.plainBox || f.transformed) return false;
  if (f.objectFit === "fill") return true;
  const natural = f.naturalWidth / f.naturalHeight;
  const rendered = f.renderedWidth / f.renderedHeight;
  return Math.abs(natural / rendered - 1) <= 0.01;
}

// --- measuring (needs a DOM) ------------------------------------------------------

function isFlipOrRotation(transform: string): boolean {
  if (transform === "none") return false;
  try {
    const m = new DOMMatrix(transform);
    return !(m.a > 0 && m.d > 0 && Math.abs(m.b) < 1e-6 && Math.abs(m.c) < 1e-6);
  } catch {
    return true;
  }
}

const BOX_INSET_PROPS = [
  ...["top", "right", "bottom", "left"].map((side) => `padding-${side}`),
  ...["top", "right", "bottom", "left"].map((side) => `border-${side}-width`),
];

function measure(img: HTMLImageElement, rect: DOMRect, visible: ViewRect): OriginalFacts {
  const own = getComputedStyle(img);
  const px = (v: string) => parseFloat(v) || 0;
  const inset = BOX_INSET_PROPS.map((prop) => px(own.getPropertyValue(prop)));
  let transformed = false;
  for (let e: Element | null = img; e && !transformed; e = e.parentElement) {
    const s = getComputedStyle(e);
    transformed = isFlipOrRotation(s.transform) || (s.rotate !== "none" && s.rotate !== "") || (s.scale !== "none" && s.scale !== "" && /-/.test(s.scale));
  }
  return {
    complete: img.complete,
    naturalWidth: img.naturalWidth,
    naturalHeight: img.naturalHeight,
    renderedWidth: rect.width,
    renderedHeight: rect.height,
    fullyVisible: visible.width >= rect.width - 1 && visible.height >= rect.height - 1,
    objectFit: own.objectFit,
    plainBox: inset.every((v) => v === 0),
    transformed,
  };
}

/**
 * Reads the image's own pixels through a canvas: downscaled to a 1568 px long
 * edge, JPEG. A page that serves the image without CORS taints the canvas and the
 * read throws; every failure means "no original", and the caller sends a screenshot.
 */
export async function captureOriginal(img: HTMLImageElement, rect: DOMRect, visible: ViewRect): Promise<OriginalImage | undefined> {
  try {
    if (!canSendOriginal(measure(img, rect, visible))) return undefined;
    const { width, height } = sentSize({ width: img.naturalWidth, height: img.naturalHeight }, MAX_EDGE);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    // JPEG has no alpha: a transparent PNG would turn black.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
    if (!blob) return undefined;
    return { base64: await toBase64(blob), width, height };
  } catch {
    return undefined;
  }
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(",") + 1));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
