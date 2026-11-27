import { describe, expect, it } from "vitest";
import {
  coverFor,
  cropFor,
  isVertical,
  padFor,
  perimeterSamples,
  pickFill,
  sentSize,
  toImageFractions,
  type Rgb,
} from "../src/background/image-geometry";

const viewport = { width: 1000, height: 800 };

describe("cropFor", () => {
  it("is the visible rect itself at 1x", () => {
    expect(cropFor({ x: 100, y: 50, width: 400, height: 600 }, viewport, { width: 1000, height: 800 })).toEqual({
      x: 100, y: 50, width: 400, height: 600,
    });
  });

  it("scales by the screenshot's size, so devicePixelRatio 2 doubles the crop", () => {
    expect(cropFor({ x: 100, y: 50, width: 400, height: 600 }, viewport, { width: 2000, height: 1600 })).toEqual({
      x: 200, y: 100, width: 800, height: 1200,
    });
  });

  it("handles page zoom: 150% zoom shrinks the CSS viewport, the screenshot keeps its pixels", () => {
    // 1500x1200 device px showing a 1000x800 CSS px viewport.
    const crop = cropFor({ x: 10, y: 10, width: 100, height: 100 }, viewport, { width: 1500, height: 1200 });
    expect(crop).toEqual({ x: 15, y: 15, width: 150, height: 150 });
  });

  it("rounds outward so no edge of the image is cut, and stays inside the screenshot", () => {
    expect(cropFor({ x: 0.4, y: 0.4, width: 10.2, height: 10.2 }, viewport, { width: 1000, height: 800 })).toEqual({
      x: 0, y: 0, width: 11, height: 11,
    });
    const edge = cropFor({ x: 900, y: 700, width: 100.5, height: 100.5 }, viewport, { width: 1000, height: 800 });
    expect(edge.x + edge.width).toBe(1000);
    expect(edge.y + edge.height).toBe(800);
  });
});

describe("sentSize", () => {
  it("leaves a small crop alone", () => {
    expect(sentSize({ width: 800, height: 1200 }, 1568)).toEqual({ width: 800, height: 1200 });
  });

  it("scales the long edge down to the limit, keeping the aspect ratio", () => {
    expect(sentSize({ width: 2000, height: 3136 }, 1568)).toEqual({ width: 1000, height: 1568 });
    expect(sentSize({ width: 4000, height: 1000 }, 1568)).toEqual({ width: 1568, height: 392 });
  });
});

describe("toImageFractions", () => {
  const image = { x: 100, y: 100, width: 400, height: 600 };

  it("maps a box of the sent image onto the image element, padded by 15% per side", () => {
    // The whole image is visible and sent 1:1; the box is 100x100 px at (100,200) in the image.
    const sent = { width: 400, height: 600 };
    const [x0, y0, x1, y1] = toImageFractions([100, 200, 200, 300], sent, image, image);
    expect(x0).toBeCloseTo(85 / 400);
    expect(y0).toBeCloseTo(185 / 600);
    expect(x1).toBeCloseTo(215 / 400);
    expect(y1).toBeCloseTo(315 / 600);
  });

  it("is independent of the downscale: the sent size only sets the pixel unit", () => {
    const a = toImageFractions([100, 200, 200, 300], { width: 400, height: 600 }, image, image);
    const b = toImageFractions([50, 100, 100, 150], { width: 200, height: 300 }, image, image);
    a.forEach((v, i) => expect(b[i]).toBeCloseTo(v));
  });

  it("measures against the whole image when only its lower part was visible", () => {
    // The image's top edge is 100 px above the viewport, so the sent image starts 100 px into it.
    const scrolled = { x: 100, y: -100, width: 400, height: 600 };
    const visible = { x: 100, y: 0, width: 400, height: 500 };
    // Box at the very top of the visible part, 10px tall, in a 1:1 sent image.
    const [, y0, , y1] = toImageFractions([50, 0, 150, 10], { width: 400, height: 500 }, visible, scrolled, 0);
    expect(y0).toBeCloseTo(100 / 600);
    expect(y1).toBeCloseTo(110 / 600);
  });

  it("clamps to the image", () => {
    const sent = { width: 400, height: 600 };
    expect(toImageFractions([0, 0, 40, 60], sent, image, image)).toEqual([0, 0, expect.any(Number), expect.any(Number)]);
    const [, , x1, y1] = toImageFractions([380, 580, 400, 600], sent, image, image);
    expect(x1).toBe(1);
    expect(y1).toBe(1);
  });

  it("follows a zoomed page: the sent image covers the same CSS rect whatever the DPR", () => {
    // Same visible rect, but a 2x screenshot sent at 2x size: same fractions as 1x.
    const one = toImageFractions([100, 200, 200, 300], { width: 400, height: 600 }, image, image);
    const two = toImageFractions([200, 400, 400, 600], { width: 800, height: 1200 }, image, image);
    one.forEach((v, i) => expect(two[i]).toBeCloseTo(v));
  });
});

describe("isVertical", () => {
  it("needs a vertical-capable target language and a clearly tall box", () => {
    expect(isVertical([0, 0, 40, 200], "ja")).toBe(true);
    expect(isVertical([0, 0, 40, 200], "zh-TW")).toBe(true);
    expect(isVertical([0, 0, 40, 200], "zh-CN")).toBe(true);
    expect(isVertical([0, 0, 40, 200], "en")).toBe(false);
    expect(isVertical([0, 0, 40, 200], "ko")).toBe(false);
  });

  it("keeps squarish and wide boxes horizontal", () => {
    expect(isVertical([0, 0, 100, 100], "ja")).toBe(false);
    expect(isVertical([0, 0, 100, 105], "ja")).toBe(false);
    expect(isVertical([0, 0, 200, 40], "ja")).toBe(false);
  });

  it("sets a bubble only somewhat taller than wide vertically", () => {
    expect(isVertical([0, 0, 100, 140], "ja")).toBe(true);
    expect(isVertical([0, 0, 85, 110], "zh-TW")).toBe(true);
  });
});

describe("pickFill", () => {
  const px = (r: number, g: number, b: number): Rgb => [r, g, b];

  it("takes the per-channel median, so a few dark outliers (the bubble outline) do not tint it", () => {
    const samples = [px(250, 250, 250), px(252, 252, 252), px(251, 251, 251), px(0, 0, 0), px(20, 20, 20)];
    expect(pickFill(samples).fill).toBe("rgb(250, 250, 250)");
  });

  it("picks dark ink on a light fill and light ink on a dark fill", () => {
    expect(pickFill([px(255, 255, 255)]).ink).toBe("#111111");
    expect(pickFill([px(20, 20, 30)]).ink).toBe("#ffffff");
    expect(pickFill([px(255, 220, 0)]).ink).toBe("#111111");
    expect(pickFill([px(40, 60, 200)]).ink).toBe("#ffffff");
  });

  it("falls back to white with no samples", () => {
    expect(pickFill([])).toEqual({ fill: "rgb(255, 255, 255)", ink: "#111111" });
  });
});

describe("perimeterSamples", () => {
  /** 100x100 grey page with a white bubble (20..80) holding black text (40..60). */
  function page(): Uint8ClampedArray {
    const data = new Uint8ClampedArray(100 * 100 * 4);
    for (let y = 0; y < 100; y++)
      for (let x = 0; x < 100; x++) {
        const v = x >= 40 && x < 60 && y >= 40 && y < 60 ? 0 : x >= 20 && x < 80 && y >= 20 && y < 80 ? 255 : 128;
        data.set([v, v, v, 255], (y * 100 + x) * 4);
      }
    return data;
  }

  it("samples the padded outline, which lies on the bubble background and not on the glyphs", () => {
    const samples = perimeterSamples(page(), { width: 100, height: 100 }, [40, 40, 60, 60]);
    expect(samples.length).toBeGreaterThan(20);
    expect(samples.every(([r]) => r === 255)).toBe(true);
    expect(pickFill(samples).fill).toBe("rgb(255, 255, 255)");
  });

  it("samples just outside the glyphs, not on the wider box the overlay draws for tall text", () => {
    // Grey page, white bubble x 35..65 / y 25..75 hugging tall black text x 40..60 / y 30..70.
    const data = new Uint8ClampedArray(100 * 100 * 4);
    for (let y = 0; y < 100; y++)
      for (let x = 0; x < 100; x++) {
        const v = x >= 40 && x < 60 && y >= 30 && y < 70 ? 0 : x >= 35 && x < 65 && y >= 25 && y < 75 ? 255 : 128;
        data.set([v, v, v, 255], (y * 100 + x) * 4);
      }
    const box = [40, 30, 60, 70] as const;
    // The overlay's padding for this box reaches the grey page...
    expect(pickFill(perimeterSamples(data, { width: 100, height: 100 }, box, padFor(box))).fill).toBe("rgb(128, 128, 128)");
    // ...the default sampling outline stays on the bubble.
    expect(pickFill(perimeterSamples(data, { width: 100, height: 100 }, box)).fill).toBe("rgb(255, 255, 255)");
  });

  it("stays inside the image when the padded box reaches past its edge", () => {
    const samples = perimeterSamples(page(), { width: 100, height: 100 }, [90, 90, 100, 100]);
    expect(samples.length).toBeGreaterThan(0);
    expect(samples.every((s) => s.every((c) => Number.isFinite(c)))).toBe(true);
  });
});

describe("padFor", () => {
  it("pads tall boxes (vertical text) more on the left and right, where the model cuts columns off", () => {
    expect(padFor([0, 0, 100, 200])).toEqual({ x: 0.3, y: 0.15 });
  });

  it("pads wide and square boxes evenly", () => {
    expect(padFor([0, 0, 200, 100])).toEqual({ x: 0.15, y: 0.15 });
    expect(padFor([0, 0, 100, 100])).toEqual({ x: 0.15, y: 0.15 });
  });

  it("is what toImageFractions applies by default", () => {
    const image = { x: 0, y: 0, width: 1000, height: 1000 };
    const sent = { width: 1000, height: 1000 };
    expect(toImageFractions([400, 300, 500, 500], sent, image, image)).toEqual([0.37, 0.27, 0.53, 0.53]);
  });
});

describe("coverFor", () => {
  const size = { width: 200, height: 200 };
  const white = [255, 255, 255] as const;
  /** Grey artwork (128), a white ellipse bubble with a black outline, black text in its middle. */
  function bubble(): Uint8ClampedArray {
    const data = new Uint8ClampedArray(200 * 200 * 4);
    for (let y = 0; y < 200; y++)
      for (let x = 0; x < 200; x++) {
        const e = ((x - 100) / 28) ** 2 + ((y - 100) / 55) ** 2;
        const text = x >= 85 && x < 115 && y >= 60 && y < 140 && x % 6 < 4;
        const v = e > 1.08 ? 128 : e > 1 || text ? 0 : 255;
        data.set([v, v, v, 255], (y * 200 + x) * 4);
      }
    return data;
  }
  const insideEllipse = ([x, y]: readonly [number, number]) => ((x - 100) / 31) ** 2 + ((y - 100) / 58) ** 2 <= 1;

  it("follows a round bubble instead of covering the artwork outside it", () => {
    const box = [85, 60, 115, 140] as const;
    const { shape } = coverFor(bubble(), size, box, white);
    // The padded rectangle the overlay used before reaches the grey artwork at its corners...
    const [px0, py0] = [85 - 30 * padFor(box).x, 60 - 80 * padFor(box).y];
    expect(insideEllipse([px0, py0])).toBe(false);
    // ...the cover stays inside the bubble.
    expect(shape.every(insideEllipse)).toBe(true);
  });

  it("covers every glyph, and reaches past a column the model's box cut off", () => {
    const tight = [91, 60, 115, 140] as const; // misses the column at x 85..89
    const { shape } = coverFor(bubble(), size, tight, white);
    const xs = shape.map(([x]) => x);
    expect(Math.min(...xs)).toBeLessThanOrEqual(85);
    expect(Math.max(...xs)).toBeGreaterThanOrEqual(115);
  });

  it("finds a column far outside a one-column box", () => {
    // The model boxed only the column at x 109..115; the bubble holds columns from x 85 on.
    const { shape } = coverFor(bubble(), size, [109, 60, 115, 140], white);
    expect(Math.min(...shape.map(([x]) => x))).toBeLessThanOrEqual(85);
    expect(shape.every(insideEllipse)).toBe(true);
  });

  it("lays the text out inside the bubble and around the whole text box", () => {
    const box = [85, 60, 115, 140] as const;
    const { text } = coverFor(bubble(), size, box, white);
    expect(text[0]).toBeLessThanOrEqual(85);
    expect(text[2]).toBeGreaterThanOrEqual(115);
    for (const corner of [[text[0], text[1]], [text[2], text[1]], [text[0], text[3]], [text[2], text[3]]] as const)
      expect(insideEllipse(corner)).toBe(true);
  });

  it("cuts a side where the outline has a gap (a spiky burst) back to the padded rectangle", () => {
    const data = bubble();
    // A gap in the outline on the right at y 95..105 opens the bubble onto white artwork beyond it.
    for (let y = 95; y < 106; y++) for (let x = 120; x < 200; x++) data.set([255, 255, 255, 255], (y * 200 + x) * 4);
    const box = [85, 60, 115, 140] as const;
    const { shape } = coverFor(data, size, box, white);
    expect(Math.max(...shape.map(([x]) => x))).toBeLessThanOrEqual(115 + 30 * padFor(box).x + 1);
  });

  it("does not flood the artwork from a box that sticks out of the bubble", () => {
    const data = bubble();
    // White artwork (a road) below the bubble, which the box reaches into.
    for (let y = 160; y < 200; y++) for (let x = 0; x < 200; x++) data.set([255, 255, 255, 255], (y * 200 + x) * 4);
    const { shape } = coverFor(data, size, [85, 60, 115, 175], white);
    // On the road rows only the box itself is covered, not the road around it.
    const road = shape.filter(([, y]) => y >= 166);
    expect(road.length).toBeGreaterThan(0);
    expect(road.every(([x]) => x >= 84 && x <= 116)).toBe(true);
  });

  it("without an outline (text on open white), stays within the padded rectangle", () => {
    const data = new Uint8ClampedArray(200 * 200 * 4).fill(255);
    const box = [85, 60, 115, 140] as const;
    const { shape } = coverFor(data, size, box, white);
    const pad = padFor(box);
    for (const [x, y] of shape) {
      expect(x).toBeGreaterThanOrEqual(85 - 30 * pad.x - 1);
      expect(x).toBeLessThanOrEqual(115 + 30 * pad.x + 1);
      expect(y).toBeGreaterThanOrEqual(60 - 80 * pad.y - 1);
      expect(y).toBeLessThanOrEqual(140 + 80 * pad.y + 1);
    }
  });
});
