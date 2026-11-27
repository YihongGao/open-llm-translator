// @vitest-environment happy-dom
// The image overlay's behaviour on the page: finding the image, drawing boxes
// at fractional positions, the chip, and cleanup. happy-dom has no layout, so
// each image's box is stubbed; font fitting needs real layout and is covered by
// the E2E journey.
import { setUiLanguage } from "../src/shared/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleImageMessage } from "../src/content/image-overlay";
import type { ImageLocateResult, ImageRegion, ImageTarget, LocatedImage } from "../src/shared/messages";

const SRC = "https://img.test/page-1.png";

function addImage(src: string, rect: { left: number; top: number; width: number; height: number }): HTMLImageElement {
  const img = document.createElement("img");
  img.src = src;
  img.getBoundingClientRect = () =>
    ({ ...rect, x: rect.left, y: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height, toJSON() {} }) as DOMRect;
  document.body.append(img);
  return img;
}

function locateTarget(target: ImageTarget): Promise<ImageLocateResult> {
  return new Promise((resolve) => handleImageMessage({ type: "llmt-image-locate", target, uiLanguage: "auto" }, resolve));
}
const locate = (srcUrl = SRC) => locateTarget({ kind: "src", srcUrl });

const region = (over: Partial<ImageRegion> = {}): ImageRegion => ({
  box: [0.1, 0.2, 0.5, 0.4],
  cover: [[0.1, 0.2], [0.5, 0.2], [0.5, 0.4], [0.1, 0.4]],
  text: "你好",
  fill: "rgb(255, 255, 255)",
  ink: "#111111",
  vertical: false,
  ...over,
});

const layer = () => document.querySelector("llmt-image-layer")?.shadowRoot ?? null;
const chipText = () => layer()?.querySelector(".status")?.textContent ?? null;
const regions = () => [...(layer()?.querySelectorAll<HTMLElement>(".region") ?? [])];

/** The one image a "src" locate finds, with the viewport. */
async function ok(src = SRC): Promise<LocatedImage & { viewport: { width: number; height: number } }> {
  const r = await locate(src);
  if (!r.ok) throw new Error(`locate failed: ${r.reason}`);
  expect(r.images).toHaveLength(1);
  return { ...r.images[0]!, viewport: r.viewport };
}

beforeEach(() => {
  vi.spyOn(window, "innerWidth", "get").mockReturnValue(1000);
  vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
});

afterEach(async () => {
  // Jobs outlive a test: removing the images ends them on the next reposition, and the layer goes with the last one.
  document.body.innerHTML = "";
  window.dispatchEvent(new Event("resize"));
  await new Promise((r) => setTimeout(r, 30));
  document.querySelector("llmt-toast")?.remove();
  vi.restoreAllMocks();
});

describe("locate", () => {
  it("answers with the image's box, the visible part and the viewport", async () => {
    addImage(SRC, { left: 100, top: 50, width: 400, height: 600 });
    const r = await ok();
    expect(r.image).toEqual({ x: 100, y: 50, width: 400, height: 600 });
    expect(r.visible).toEqual({ x: 100, y: 50, width: 400, height: 600 });
    expect(r.viewport).toEqual({ width: 1000, height: 800 });
    expect(r.jobId).toBeTruthy();
  });

  it("clips the visible part to the viewport", async () => {
    addImage(SRC, { left: 100, top: -200, width: 400, height: 1400 });
    const r = await ok();
    expect(r.image).toEqual({ x: 100, y: -200, width: 400, height: 1400 });
    expect(r.visible).toEqual({ x: 100, y: 0, width: 400, height: 800 });
  });

  it("reports not-found for an empty url, even when an <img> has no src", async () => {
    document.body.append(document.createElement("img"));
    expect(await locate("")).toEqual({ ok: false, reason: "not-found" });
  });

  it("reports not-found for an unknown url", async () => {
    addImage(SRC, { left: 100, top: 50, width: 400, height: 600 });
    expect(await locate("https://img.test/other.png")).toEqual({ ok: false, reason: "not-found" });
  });

  it.each([
    ["a sliver at the bottom edge", { left: 100, top: 780, width: 400, height: 600 }],
    ["too narrow", { left: 100, top: 50, width: 40, height: 600 }],
  ])("reports not-visible for an image that is %s", async (_name, rect) => {
    addImage(SRC, rect);
    expect(await locate()).toEqual({ ok: false, reason: "not-visible" });
  });

  it("with the same picture shown twice, takes the one most on screen", async () => {
    addImage(SRC, { left: 0, top: 700, width: 300, height: 300 }); // 100 px visible
    addImage(SRC, { left: 400, top: 100, width: 300, height: 300 }); // fully visible
    expect((await ok()).image.x).toBe(400);
  });

  it("shows nothing of ours until the screenshot is taken", async () => {
    addImage(SRC, { left: 100, top: 50, width: 400, height: 600 });
    const { jobId } = await ok();
    expect(layer()?.querySelector<HTMLElement>(".chip")?.hidden).toBe(true);
    handleImageMessage({ type: "llmt-image-captured", jobId }, () => {});
    expect(layer()?.querySelector<HTMLElement>(".chip")?.hidden).toBe(false);
    expect(chipText()).toBe("翻譯中…");
  });

  it("re-translating an image replaces its overlay", async () => {
    addImage(SRC, { left: 100, top: 50, width: 400, height: 600 });
    const first = await ok();
    handleImageMessage({ type: "llmt-image-captured", jobId: first.jobId }, () => {});
    handleImageMessage({ type: "llmt-image-region", jobId: first.jobId, region: region() }, () => {});
    const second = await ok();
    expect(second.jobId).not.toBe(first.jobId);
    expect(layer()?.querySelectorAll(".image")).toHaveLength(1);
    expect(regions()).toHaveLength(0);
    // A late region of the replaced job is ignored.
    handleImageMessage({ type: "llmt-image-region", jobId: first.jobId, region: region() }, () => {});
    expect(regions()).toHaveLength(0);
  });
});

describe("locate: images on screen", () => {
  const xs = (r: ImageLocateResult) => (r.ok ? r.images.map((i) => i.image.x) : r);

  it("finds every image that is big enough on both sides, largest visible part first, at most four", async () => {
    addImage("https://img.test/a.png", { left: 0, top: 0, width: 200, height: 200 });
    addImage("https://img.test/b.png", { left: 210, top: 0, width: 300, height: 425 });
    addImage("https://img.test/c.png", { left: 520, top: 0, width: 300, height: 425 });
    addImage("https://img.test/icon.png", { left: 830, top: 0, width: 100, height: 100 });
    addImage("https://img.test/narrow.png", { left: 0, top: 500, width: 159, height: 250 });
    addImage("https://img.test/d.png", { left: 1, top: 430, width: 170, height: 170 });
    addImage("https://img.test/e.png", { left: 700, top: 430, width: 170, height: 170 });
    const r = await locateTarget({ kind: "visible" });
    // b and c tie on area (page order), then a (200x200), then d (170x170) before e; capped at four.
    expect(xs(r)).toEqual([210, 520, 0, 1]);
    expect(layer()?.querySelectorAll(".image")).toHaveLength(4);
  });

  it("measures the visible part of each image against the viewport", async () => {
    addImage("https://img.test/a.png", { left: 100, top: 500, width: 300, height: 425 });
    const r = await locateTarget({ kind: "visible" });
    expect(r.ok && r.images[0]!.visible).toEqual({ x: 100, y: 500, width: 300, height: 300 });
  });

  it("gives each image its own job", async () => {
    addImage("https://img.test/a.png", { left: 0, top: 0, width: 300, height: 425 });
    addImage("https://img.test/b.png", { left: 310, top: 0, width: 300, height: 425 });
    const r = await locateTarget({ kind: "visible" });
    expect(r.ok && new Set(r.images.map((i) => i.jobId)).size).toBe(2);
  });

  it("reports no-images when nothing on screen is big enough", async () => {
    addImage("https://img.test/icon.png", { left: 0, top: 0, width: 100, height: 100 });
    addImage("https://img.test/below.png", { left: 0, top: 700, width: 400, height: 400 });
    expect(await locateTarget({ kind: "visible" })).toEqual({ ok: false, reason: "no-images" });
  });

  it("skips images that are hidden", async () => {
    addImage("https://img.test/a.png", { left: 0, top: 0, width: 300, height: 425 }).style.visibility = "hidden";
    expect(await locateTarget({ kind: "visible" })).toEqual({ ok: false, reason: "no-images" });
  });

  it("sends no original for an image with no decoded pixels", async () => {
    addImage("https://img.test/a.png", { left: 0, top: 0, width: 300, height: 425 });
    const r = await locateTarget({ kind: "visible" });
    expect(r.ok && r.images[0]!.original).toBeUndefined();
  });
});

describe("regions", () => {
  async function started() {
    const img = addImage(SRC, { left: 100, top: 50, width: 400, height: 600 });
    const { jobId } = await ok();
    handleImageMessage({ type: "llmt-image-captured", jobId }, () => {});
    return { img, jobId };
  }

  it("places each region by percentages of the image box, with its colours and text", async () => {
    const { jobId } = await started();
    handleImageMessage({ type: "llmt-image-region", jobId, region: region() }, () => {});
    const [box] = regions();
    expect(box!.style.left).toBe("10%");
    expect(box!.style.top).toBe("20%");
    expect(box!.style.width).toBe("40%");
    expect(box!.style.height).toBe("20%");
    expect(box!.style.color).toBe("#111111");
    expect(box!.textContent).toBe("你好");
  });

  it("paints the fill only inside the cover polygon, under the text", async () => {
    const { jobId } = await started();
    const cover: [number, number][] = [[0.2, 0.1], [0.6, 0.3], [0.2, 0.5]];
    handleImageMessage({ type: "llmt-image-region", jobId, region: region({ cover }) }, () => {});
    const patch = layer()!.querySelector<HTMLElement>(".patch")!;
    expect([patch.style.left, patch.style.top, patch.style.width, patch.style.height]).toEqual(["20%", "10%", "40%", "40%"]);
    expect(patch.style.background).toContain("255");
    expect(patch.style.clipPath.replace(/\s/g, "")).toBe("polygon(0%0%,100%50%,0%100%)");
    expect(patch.compareDocumentPosition(regions()[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("follows the image box", async () => {
    const { jobId } = await started();
    const container = layer()!.querySelector<HTMLElement>(".image")!;
    expect(container.style.left).toBe("100px");
    expect(container.style.top).toBe("50px");
    expect(container.style.width).toBe("400px");
    expect(container.style.height).toBe("600px");
    expect(jobId).toBeTruthy();
  });

  it("renders text as text, never as markup", async () => {
    const { jobId } = await started();
    handleImageMessage({ type: "llmt-image-region", jobId, region: region({ text: "<img src=x onerror=alert(1)>" }) }, () => {});
    expect(regions()[0]!.querySelector("img")).toBeNull();
    expect(regions()[0]!.textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("marks vertical regions", async () => {
    const { jobId } = await started();
    handleImageMessage({ type: "llmt-image-region", jobId, region: region({ vertical: true }) }, () => {});
    expect(regions()[0]!.classList.contains("vertical")).toBe(true);
  });

  it("lets clicks through the boxes to the page", async () => {
    const { jobId } = await started();
    handleImageMessage({ type: "llmt-image-region", jobId, region: region() }, () => {});
    expect(document.querySelector("llmt-image-layer")).not.toBeNull();
    // The host is pointer-events:none and only the chip opts back in.
    const css = layer()!.querySelector("style")!.textContent!;
    expect(css).toMatch(/:host \{[^}]*pointer-events: none/);
    expect(css).toMatch(/\.chip \{[^}]*pointer-events: auto/);
    expect(css).not.toMatch(/\.region \{[^}]*pointer-events: auto/);
  });
});

describe("chip", () => {
  async function translated(partial = false) {
    addImage(SRC, { left: 100, top: 50, width: 400, height: 600 });
    const { jobId } = await ok();
    handleImageMessage({ type: "llmt-image-captured", jobId }, () => {});
    handleImageMessage({ type: "llmt-image-region", jobId, region: region() }, () => {});
    handleImageMessage({ type: "llmt-image-region", jobId, region: region({ box: [0.1, 0.5, 0.5, 0.7] }) }, () => {});
    handleImageMessage({ type: "llmt-image-end", jobId, count: 2, partial, uiLanguage: "auto" }, () => {});
    return jobId;
  }

  it("counts the regions when done", async () => {
    await translated();
    expect(chipText()).toBe("已翻譯 2 處文字");
  });

  it("says when only the visible part of the image was translated", async () => {
    await translated(true);
    expect(chipText()).toBe("已翻譯 2 處文字（僅可見部分）");
  });

  it("toggles between the original and the translation", async () => {
    await translated();
    const toggle = layer()!.querySelector<HTMLButtonElement>(".chip button")!;
    expect(toggle.textContent).toBe("顯示原圖");
    toggle.click();
    expect(layer()!.querySelector(".image")!.classList.contains("original")).toBe(true);
    expect(toggle.textContent).toBe("顯示翻譯");
    toggle.click();
    expect(layer()!.querySelector(".image")!.classList.contains("original")).toBe(false);
  });

  it("says so when no text was found, with nothing to toggle", async () => {
    addImage(SRC, { left: 100, top: 50, width: 400, height: 600 });
    const { jobId } = await ok();
    handleImageMessage({ type: "llmt-image-end", jobId, count: 0, partial: false, uiLanguage: "auto" }, () => {});
    expect(chipText()).toBe("沒有找到文字");
    expect(layer()!.querySelector<HTMLButtonElement>(".chip button")!.hidden).toBe(true);
  });

  it("the remove button takes the overlay and the layer away", async () => {
    await translated();
    layer()!.querySelectorAll<HTMLButtonElement>(".chip button")[1]!.click();
    expect(document.querySelector("llmt-image-layer")).toBeNull();
  });

  it("keeps chip clicks from reaching the page", async () => {
    await translated();
    const onPage = vi.fn();
    document.addEventListener("click", onPage);
    layer()!.querySelector<HTMLButtonElement>(".chip button")!.click();
    document.removeEventListener("click", onPage);
    expect(onPage).not.toHaveBeenCalled();
  });
});

describe("errors", () => {
  const toast = () => document.querySelector("llmt-toast")?.shadowRoot ?? null;

  it("a failed job shows a failed chip and a notice with the reason", async () => {
    addImage(SRC, { left: 100, top: 50, width: 400, height: 600 });
    const { jobId } = await ok();
    handleImageMessage({ type: "llmt-image-captured", jobId }, () => {});
    handleImageMessage({ type: "llmt-image-end", jobId, count: 0, partial: false, error: { message: "超過速率限制", settings: false }, uiLanguage: "auto" }, () => {});
    expect(chipText()).toBe("翻譯失敗");
    expect(toast()?.querySelector(".msg")?.textContent).toBe("無法翻譯這張圖片：超過速率限制");
    expect(toast()?.querySelector(".action")).toBeNull();
  });

  it("a notice without a job (no key, iframe) is only a notice, with 開啟設定 when the fix is in settings", () => {
    handleImageMessage(
      { type: "llmt-image-end", jobId: "", count: 0, partial: false, error: { message: "需要 key", settings: true }, uiLanguage: "auto" },
      () => {},
    );
    expect(layer()).toBeNull();
    expect(toast()?.querySelector(".msg")?.textContent).toBe("無法翻譯這張圖片：需要 key");
    expect(toast()?.querySelector(".action")?.textContent).toBe("開啟設定");
  });

  it("words the notice in the UI language the job was started with, not the browser's", () => {
    handleImageMessage(
      { type: "llmt-image-end", jobId: "", count: 0, partial: false, error: { message: "x", settings: false }, uiLanguage: "en" },
      () => {},
    );
    expect(toast()?.querySelector(".msg")?.textContent).toBe("Can't translate this image: x");
    setUiLanguage("auto");
  });

  it("ignores the end of a job that was replaced or removed", async () => {
    handleImageMessage({ type: "llmt-image-end", jobId: "img-999", count: 1, partial: false, uiLanguage: "auto" }, () => {});
    handleImageMessage(
      { type: "llmt-image-end", jobId: "img-999", count: 0, partial: false, error: { message: "x", settings: false }, uiLanguage: "auto" },
      () => {},
    );
    expect(toast()).toBeNull();
  });
});

describe("cleanup", () => {
  it("removes the overlay when the image's src changes", async () => {
    const img = addImage(SRC, { left: 100, top: 50, width: 400, height: 600 });
    await ok();
    expect(layer()).not.toBeNull();
    img.src = "https://img.test/page-2.png";
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelector("llmt-image-layer")).toBeNull();
  });

  it("removes the overlay when the image leaves the DOM (on the next reposition)", async () => {
    const img = addImage(SRC, { left: 100, top: 50, width: 400, height: 600 });
    await ok();
    img.remove();
    window.dispatchEvent(new Event("resize"));
    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelector("llmt-image-layer")).toBeNull();
  });

  it("repositions on resize", async () => {
    const img = addImage(SRC, { left: 100, top: 50, width: 400, height: 600 });
    await ok();
    img.getBoundingClientRect = () => ({ left: 10, top: 20, width: 200, height: 300, right: 210, bottom: 320 }) as DOMRect;
    window.dispatchEvent(new Event("resize"));
    await new Promise((r) => setTimeout(r, 50));
    const container = layer()!.querySelector<HTMLElement>(".image")!;
    expect(container.style.left).toBe("10px");
    expect(container.style.width).toBe("200px");
  });
});
