import { describe, expect, it } from "vitest";
import { SegmentLineParser, buildUserMessage } from "../src/background/protocol";

function feed(parser: SegmentLineParser, chunks: string[]) {
  const out = chunks.flatMap((c) => parser.push(c));
  return [...out, ...parser.end()];
}

describe("SegmentLineParser", () => {
  it("parses lines split across arbitrary stream chunks", () => {
    const p = new SegmentLineParser(3);
    const out = feed(p, ["[1] 文", "件\n[2", "] 培訓\n[3] 職", "業"]);
    expect(out).toEqual([
      { index: 0, text: "文件" },
      { index: 1, text: "培訓" },
      { index: 2, text: "職業" },
    ]);
  });

  it("emits a segment only once the next marker arrives (streaming granularity)", () => {
    const p = new SegmentLineParser(2);
    expect(p.push("[1] 文件\n")).toEqual([]);
    expect(p.push("[2] 博客\n")).toEqual([{ index: 0, text: "文件" }]);
    expect(p.end()).toEqual([{ index: 1, text: "博客" }]);
  });

  it("joins a translation the model wrapped onto several lines", () => {
    const p = new SegmentLineParser(2);
    expect(feed(p, ["[1] 第一行\n接續\n\n[2] 二\n"])).toEqual([
      { index: 0, text: "第一行 接續" },
      { index: 1, text: "二" },
    ]);
  });

  it("drops out-of-range, duplicate and empty ids, and code fences", () => {
    const p = new SegmentLineParser(2);
    expect(feed(p, ["```\n[0] x\n[1] a\n[1] dup\n[9] y\n[2]\n```\n"])).toEqual([{ index: 0, text: "a" }]);
  });

  it("ignores preamble before the first marker", () => {
    const p = new SegmentLineParser(1);
    expect(feed(p, ["Here you go:\n[1] 好\n"])).toEqual([{ index: 0, text: "好" }]);
  });
});

describe("buildUserMessage", () => {
  it("numbers segments from 1 and forces single lines", () => {
    const msg = buildUserMessage(["a\nb", "c"], { title: "T", url: "https://x" });
    expect(msg).toContain("[1] a b\n[2] c");
    expect(msg).toContain("Page title: T");
  });
});
