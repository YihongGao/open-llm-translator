// Right-click "translate this image" and "translate images on screen": locate the
// <img> elements in the page, get their pixels (the image's own, read in the
// page, or a crop of one screenshot of the tab), ask Claude for the text regions
// of each, and stream them back to the content script, which draws them over the
// images.
//
// No fetch of the image URL from the worker: it would hit CORS and cookies, and
// needs host permissions. The page already shows the image; the content script
// reads it where it is allowed to, and the screenshot covers the rest.

import type { ImageLocateResult, ImageMessage, ImageRegion, ImageTarget, LocatedImage, OriginalImage, ViewRect } from "../shared/messages";
import { setUiLanguage, t } from "../shared/i18n";
import { loadSettings, resolveImageModel, type Settings } from "../shared/settings";
import { ensureContentScript, getTabState } from "../shared/tab-control";
import { withSlot } from "./concurrency";
import { coverFor, cropFor, isVertical, medianRgb, perimeterSamples, pickFill, sentSize, toImageFractions, toImagePoint } from "./image-geometry";
import { estimateCostUsd } from "./pricing";
import { describeAnthropicError, isAbort } from "./providers/anthropic";
import { streamImageRegions, type ImageInput } from "./providers/anthropic-image";
import { redactSecrets } from "./redact";

/** Long edge of the image sent to the model. Larger images are downscaled; ~2.5k input tokens per page. */
const MAX_EDGE = 1568;
const JPEG_QUALITY = 0.9;

/** Context menu entries; created on install/update (items persist across worker restarts). */
export const IMAGE_MENU_ID = "llmt-translate-image";
export const SCREEN_MENU_ID = "llmt-translate-screen-images";

/** The parts of chrome.contextMenus.OnClickData this needs. */
export interface MenuClick {
  menuItemId: string | number;
  srcUrl?: string;
}

/** What a menu click asks for, or null when the item is not ours. */
export function targetForClick(info: MenuClick): ImageTarget | null {
  if (info.menuItemId === IMAGE_MENU_ID) return { kind: "src", srcUrl: info.srcUrl ?? "" };
  if (info.menuItemId === SCREEN_MENU_ID) return { kind: "visible" };
  return null;
}

let nextJob = 0;

/** The pixels that will be sent for one image. */
interface Prepared {
  input: ImageInput;
  size: { width: number; height: number };
  /** RGBA pixels of the encoded image, for sampling background colours. */
  rgba: Uint8ClampedArray;
}

export async function translateImages(tab: chrome.tabs.Tab, target: ImageTarget, frameId = 0): Promise<void> {
  const tabId = tab.id;
  if (tabId === undefined) return;

  // The key check comes first: with no key there is nothing to capture, and no overlay to show.
  const settings = await loadSettings();
  setUiLanguage(settings.uiLanguage);
  const { uiLanguage } = settings;
  if (!(await ensureReady(tabId))) {
    console.info("[llmt] this tab cannot be scripted");
    return;
  }
  const noJob = async (message: string, settingsFix = false) => {
    await tell(tabId, { type: "llmt-image-end", jobId: "", count: 0, partial: false, error: { message, settings: settingsFix }, uiLanguage });
  };

  if (!settings.anthropicApiKey) return noJob(t("imageErrNeedAnthropicKey"), true);
  // Only the top frame has a content script that can draw over the image.
  if (frameId) return noJob(t("imageErrIframe"));
  if (target.kind === "src" && !target.srcUrl) return noJob(t("imageErrNotFound"));

  const answer = await tell(tabId, { type: "llmt-image-locate", target, uiLanguage });
  if (!answer) return;
  const located = answer.reply as ImageLocateResult;
  if (!located.ok) {
    const key = { "not-found": "imageErrNotFound", "not-visible": "imageErrNotVisible", "no-images": "imageErrNoneOnScreen" } as const;
    return noJob(t(key[located.reason]));
  }

  // One screenshot for all of them (captureVisibleTab is rate-limited), taken only when some image has no original.
  const { viewport, images } = located;
  let shot: ImageBitmap | null = null;
  let shotError = new Error("no screenshot");
  if (images.some((i) => !i.original)) {
    try {
      shot = await createImageBitmap(await (await fetch(await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" }))).blob());
    } catch (err) {
      shotError = err instanceof Error ? err : new Error(String(err));
    }
  }
  try {
    await Promise.all(images.map((image) => translateOne(tabId, settings, image, viewport, shot ?? shotError)));
  } finally {
    shot?.close();
  }
}

/** One image, start to end; its failure is shown on its own overlay and never touches the others. */
async function translateOne(
  tabId: number,
  settings: Settings,
  located: LocatedImage,
  viewport: { width: number; height: number },
  screenshot: ImageBitmap | Error,
): Promise<void> {
  const { jobId, image, visible, original } = located;
  // The content script's id is only unique per page; the job number keeps the log lines apart.
  const logId = `${++nextJob}`;
  const fail = async (message: string, settingsFix = false) => {
    await tell(tabId, { type: "llmt-image-end", jobId, count: 0, partial: false, error: { message, settings: settingsFix }, uiLanguage: settings.uiLanguage });
  };

  let sent: Prepared;
  // The part of the image element that the sent pixels show.
  let shows: ViewRect;
  try {
    if (original) {
      sent = await prepareOriginal(original);
      shows = image;
    } else {
      if (screenshot instanceof Error) throw screenshot;
      sent = await prepareCrop(screenshot, visible, viewport);
      shows = visible;
    }
  } catch (err) {
    return fail(t("imageErrCapture", err instanceof Error ? err.message : String(err)));
  }
  await tell(tabId, { type: "llmt-image-captured", jobId });

  const partial = !original && (visible.width < image.width - 1 || visible.height < image.height - 1);
  const model = resolveImageModel(settings.imageModel);
  const stop = new AbortController();
  let count = 0;
  let declined = false;
  try {
    await withSlot(async () => {
      const started = Date.now();
      for await (const ev of streamImageRegions(settings.anthropicApiKey, model, sent.input, settings.targetLang, stop.signal)) {
        if (ev.kind === "region") {
          const samples = perimeterSamples(sent.rgba, sent.size, ev.box);
          const cover = coverFor(sent.rgba, sent.size, ev.box, medianRgb(samples));
          const region: ImageRegion = {
            box: toImageFractions(cover.text, sent.size, shows, image, 0),
            cover: cover.shape.map((p) => toImagePoint(p, sent.size, shows, image)),
            text: ev.text,
            ...pickFill(samples),
            vertical: isVertical(ev.box, settings.targetLang),
          };
          count++;
          // The tab closed or navigated away: stop paying for output nobody sees.
          if (!(await tell(tabId, { type: "llmt-image-region", jobId, region }))) stop.abort();
          continue;
        }
        let line = `[llmt] image ${logId}: ${count} regions, ${Date.now() - started} ms, tokens in/out ${ev.usage.inputTokens}/${ev.usage.outputTokens}`;
        const cost = estimateCostUsd(ev.servedModel, ev.usage);
        if (cost !== undefined) line += `, ≈ $${cost.toFixed(4)}`;
        const source = `${original ? "original" : "screenshot"} ${sent.size.width}x${sent.size.height}`;
        console.info(`${line} | ${source} | requested ${model} → served ${ev.servedModel}${ev.reason === "complete" ? "" : ` (${ev.reason})`}`);
        if (ev.reason === "refusal" && count === 0) declined = true;
      }
    });
  } catch (err) {
    if (isAbort(err)) return;
    const info = describeAnthropicError(err);
    return fail(redactSecrets(info.message), info.settings);
  }
  if (declined) return fail(t("imageErrDeclined"));
  await tell(tabId, { type: "llmt-image-end", jobId, count, partial, uiLanguage: settings.uiLanguage });
}

/** True when the tab has a content script (injecting one if needed). */
async function ensureReady(tabId: number): Promise<boolean> {
  if (await getTabState(tabId)) return true;
  return ensureContentScript(tabId);
}

/** Sends to the top frame. null: nobody received it (tab closed or navigated). */
async function tell(tabId: number, msg: ImageMessage): Promise<{ reply: unknown } | null> {
  try {
    return { reply: await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }) };
  } catch {
    return null;
  }
}

/** The page already encoded the image; it is decoded here only to sample background colours. */
async function prepareOriginal(original: OriginalImage): Promise<Prepared> {
  const bitmap = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${original.base64}`)).blob());
  try {
    const size = { width: bitmap.width, height: bitmap.height };
    const ctx = new OffscreenCanvas(size.width, size.height).getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);
    return {
      input: { base64: original.base64, mediaType: "image/jpeg", ...size },
      size,
      rgba: ctx.getImageData(0, 0, size.width, size.height).data,
    };
  } finally {
    bitmap.close();
  }
}

/** Crops the visible part of the image out of the tab screenshot, downscales it, encodes it as JPEG. */
async function prepareCrop(bitmap: ImageBitmap, visible: ViewRect, viewport: { width: number; height: number }): Promise<Prepared> {
  const crop = cropFor(visible, viewport, bitmap);
  if (crop.width < 1 || crop.height < 1) throw new Error("empty crop");
  const size = sentSize(crop, MAX_EDGE);
  const canvas = new OffscreenCanvas(size.width, size.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bitmap, crop.x, crop.y, crop.width, crop.height, 0, 0, size.width, size.height);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY });
  return {
    input: { base64: toBase64(new Uint8Array(await blob.arrayBuffer())), mediaType: "image/jpeg", ...size },
    size,
    rgba: ctx.getImageData(0, 0, size.width, size.height).data,
  };
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function registerImageMenu(): void {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: IMAGE_MENU_ID, title: t("menuTranslateImage"), contexts: ["image"] });
    // Manga viewers cover images with transparent elements and cancel right-clicks on them, so Chrome reports the page, not the image.
    chrome.contextMenus.create({ id: SCREEN_MENU_ID, title: t("menuTranslateVisibleImages"), contexts: ["page"] });
  });
}
