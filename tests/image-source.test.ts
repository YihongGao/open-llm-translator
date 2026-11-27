import { describe, expect, it } from "vitest";
import { canSendOriginal, pickScreenImages, type OriginalFacts } from "../src/content/image-source";

const vis = (width: number, height: number) => ({ visible: { x: 0, y: 0, width, height } });

describe("pickScreenImages", () => {
  it("keeps images whose visible part is at least 160 px on both sides", () => {
    const picked = pickScreenImages([{ n: "ok", ...vis(160, 160) }, { n: "narrow", ...vis(159, 400) }, { n: "short", ...vis(400, 159) }]);
    expect(picked.map((p) => p.n)).toEqual(["ok"]);
  });

  it("puts the largest visible area first and keeps page order among equals", () => {
    const picked = pickScreenImages([{ n: "small", ...vis(200, 200) }, { n: "big1", ...vis(300, 400) }, { n: "big2", ...vis(300, 400) }, { n: "mid", ...vis(250, 300) }]);
    expect(picked.map((p) => p.n)).toEqual(["big1", "big2", "mid", "small"]);
  });

  it("takes at most four", () => {
    const items = Array.from({ length: 7 }, (_, i) => ({ n: i, ...vis(200 + i, 200) }));
    expect(pickScreenImages(items).map((p) => p.n)).toEqual([6, 5, 4, 3]);
  });

  it("returns nothing for no candidates", () => {
    expect(pickScreenImages([])).toEqual([]);
  });
});

describe("canSendOriginal", () => {
  // The measured manga viewer: a 1190x1684 blob shown at 300x425 with object-fit: fill.
  const manga: OriginalFacts = {
    complete: true,
    naturalWidth: 1190,
    naturalHeight: 1684,
    renderedWidth: 300,
    renderedHeight: 425,
    fullyVisible: true,
    objectFit: "fill",
    plainBox: true,
    transformed: false,
  };

  it("sends the original for a fully visible, decoded image shown with object-fit: fill", () => {
    expect(canSendOriginal(manga)).toBe(true);
  });

  it.each<[string, Partial<OriginalFacts>]>([
    ["not loaded yet", { complete: false }],
    ["broken (no natural size)", { naturalWidth: 0 }],
    ["partly scrolled out of view", { fullyVisible: false }],
    ["rotated or flipped by the page", { transformed: true }],
    ["padded or bordered", { plainBox: false }],
    ["not rendered", { renderedWidth: 0 }],
    ["cropped by object-fit: cover to another shape", { objectFit: "cover", renderedWidth: 300, renderedHeight: 300 }],
  ])("falls back to the screenshot when the image is %s", (_name, over) => {
    expect(canSendOriginal({ ...manga, ...over })).toBe(false);
  });

  it("accepts cover or contain when the shapes match within 1%", () => {
    expect(canSendOriginal({ ...manga, objectFit: "contain", renderedHeight: 425.5 })).toBe(true);
    expect(canSendOriginal({ ...manga, objectFit: "cover", renderedHeight: 440 })).toBe(false);
  });
});
