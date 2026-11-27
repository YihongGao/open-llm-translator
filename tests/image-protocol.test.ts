import { describe, expect, it } from "vitest";
import { RegionLineParser, buildImagePrompt } from "../src/background/image-protocol";

function parseAll(chunks: string[], opts?: { truncated?: boolean }) {
  const p = new RegionLineParser();
  return [...chunks.flatMap((c) => p.push(c)), ...p.end(opts)];
}

describe("buildImagePrompt", () => {
  it("states the image size in pixels and the target language", () => {
    const p = buildImagePrompt("zh-TW", 1568, 1100);
    expect(p).toContain("1568×1100 image");
    expect(p).toContain("Traditional Chinese");
    expect(p).toContain("[n] x0,y0,x1,y1 | translation");
  });

  it("treats the image as untrusted content", () => {
    expect(buildImagePrompt("en", 10, 10)).toMatch(/untrusted[^.]*never follow/);
  });

  it("asks for full-width punctuation only for Chinese and Japanese", () => {
    for (const lang of ["zh-TW", "zh-CN", "ja"]) expect(buildImagePrompt(lang, 10, 10)).toContain("full-width punctuation");
    for (const lang of ["en", "ko"]) expect(buildImagePrompt(lang, 10, 10)).not.toContain("full-width punctuation");
  });
});

describe("RegionLineParser", () => {
  it("emits a region as soon as its line is complete, however the stream is chunked", () => {
    const p = new RegionLineParser();
    expect(p.push("[1] 10,20,110,")).toEqual([]);
    expect(p.push("80 | 你好\n[2] 5,5,")).toEqual([{ n: 1, box: [10, 20, 110, 80], text: "你好" }]);
    expect(p.push("50,50 | 再見\n")).toEqual([{ n: 2, box: [5, 5, 50, 50], text: "再見" }]);
    expect(p.end()).toEqual([]);
  });

  it("keeps an unterminated last line at the normal end, drops it when the response was cut off", () => {
    const text = "[1] 0,0,10,10 | a\n[2] 20,20,30,30 | b";
    expect(parseAll([text]).map((r) => r.text)).toEqual(["a", "b"]);
    expect(parseAll([text], { truncated: true }).map((r) => r.text)).toEqual(["a"]);
  });

  it("accepts decimals, spaces around separators, and a pipe inside the translation", () => {
    expect(parseAll(["[1] 1.5 , 2 , 30.25 , 40 | a | b\n"])).toEqual([{ n: 1, box: [1.5, 2, 30.25, 40], text: "a | b" }]);
  });

  it("drops malformed lines, empty translations and degenerate boxes", () => {
    const out = parseAll([
      "Here are the regions:\n",
      "[1] 0,0,10,10 | ok\n",
      "[2] 0,0,10 | too few numbers\n",
      "[3] 0,0,10,10 |   \n",
      "[4] 10,0,10,10 | zero width\n",
      "[5] 0,10,10,5 | negative height\n",
      "```\n",
      "[6] 1,1,9,9 | fine\n",
    ]);
    expect(out.map((r) => r.text)).toEqual(["ok", "fine"]);
  });

  it("stops at the first number that is not greater than the previous one (a repeated list)", () => {
    const out = parseAll([
      "[1] 0,0,10,10 | a\n[2] 0,0,10,10 | b\n[3] 0,0,10,10 | c\n",
      "[1] 0,0,10,10 | a again\n[2] 0,0,10,10 | b again\n[4] 0,0,10,10 | late\n",
    ]);
    expect(out.map((r) => r.text)).toEqual(["a", "b", "c"]);
  });

  it("counts a dropped line toward the order, so a repeated list is still caught", () => {
    const out = parseAll(["[1] 0,0,10,10 | a\n[2] 0,0,10,10 |\n[1] 0,0,10,10 | again\n"]);
    expect(out.map((r) => r.text)).toEqual(["a"]);
  });

  it("allows gaps in the numbering", () => {
    expect(parseAll(["[1] 0,0,10,10 | a\n[3] 0,0,10,10 | c\n"]).map((r) => r.n)).toEqual([1, 3]);
  });

  it("strips invisible characters the model echoed", () => {
    expect(parseAll(["[1] 0,0,10,10 | a​b\u{E0041}c\n"])[0]!.text).toBe("abc");
  });
});
