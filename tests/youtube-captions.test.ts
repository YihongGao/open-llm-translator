import { describe, expect, it } from "vitest";
import {
  chooseSource,
  mergeSentences,
  originalTrack,
  parseJson3,
  sameLanguage,
  trackUrl,
  type Cue,
} from "../src/content/youtube/captions";
import type { TrackInfo } from "../src/shared/youtube-bridge";

const BASE = "https://www.youtube.com/watch?v=abc";
const json3 = (events: unknown[]) => JSON.stringify({ wireMagic: "pb3", events });

describe("parseJson3", () => {
  it("reads uploaded captions (shape observed on a live TED video)", () => {
    const cues = parseJson3(
      json3([
        { tStartMs: 12645, dDurationMs: 1370, segs: [{ utf8: "So in college," }] },
        { tStartMs: 16937, dDurationMs: 2462, segs: [{ utf8: "which means I had\nto write papers." }] },
      ]),
    );
    expect(cues).toEqual([
      { start: 12645, end: 14015, text: "So in college," },
      { start: 16937, end: 19399, text: "which means I had to write papers." },
    ]);
  });

  it("joins word segments and drops text-less events (automatic captions)", () => {
    const cues = parseJson3(
      json3([
        { tStartMs: 0, dDurationMs: 5000, wWinId: 1 }, // window setup, no segs
        { tStartMs: 100, dDurationMs: 4000, wWinId: 1, segs: [{ utf8: "hello" }, { utf8: " world", tOffsetMs: 400 }] },
        { tStartMs: 2000, dDurationMs: 3000, wWinId: 1, aAppend: 1, segs: [{ utf8: "\n" }] },
        { tStartMs: 2100, dDurationMs: 4000, wWinId: 1, segs: [{ utf8: "next" }, { utf8: " line" }] },
      ]),
    );
    expect(cues.map((c) => c.text)).toEqual(["hello world", "next line"]);
    // Overlapping automatic captions: the first cue ends when the next starts.
    expect(cues[0]).toMatchObject({ start: 100, end: 2100 });
  });

  it("removes sound and speaker markers", () => {
    const cues = parseJson3(
      json3([
        { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "[Music]" }] },
        { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: ">> Hi there [Applause] everyone" }] },
      ]),
    );
    expect(cues.map((c) => c.text)).toEqual(["Hi there everyone"]);
  });

  it("returns no cues for malformed bodies", () => {
    expect(parseJson3("")).toEqual([]);
    expect(parseJson3("<xml/>")).toEqual([]);
    expect(parseJson3(JSON.stringify({ events: "nope" }))).toEqual([]);
    expect(parseJson3(json3([{ tStartMs: "1", segs: [{ utf8: "x" }] }, null]))).toEqual([]);
  });
});

describe("mergeSentences", () => {
  const cue = (start: number, end: number, text: string): Cue => ({ start, end, text });

  it("merges lines until final punctuation", () => {
    const s = mergeSentences([
      cue(0, 1000, "So in college,"),
      cue(1100, 2000, "I was a government major,"),
      cue(2100, 4000, "which means I wrote papers."),
      cue(4100, 5000, "Now, when a student"),
      cue(5100, 6000, "writes a paper?"),
    ]);
    expect(s).toEqual([
      { start: 0, end: 4000, text: "So in college, I was a government major, which means I wrote papers." },
      { start: 4100, end: 6000, text: "Now, when a student writes a paper?" },
    ]);
  });

  it("breaks at pauses and when a sentence gets too long", () => {
    const opts = { maxGapMs: 1500, maxDurationMs: 12_000, maxWeight: 30 };
    const s = mergeSentences(
      [cue(0, 1000, "no punctuation here"), cue(3000, 4000, "after a pause"), cue(4100, 5000, "and more words that overflow")],
      opts,
    );
    expect(s.map((x) => x.text)).toEqual(["no punctuation here", "after a pause", "and more words that overflow"]);
  });

  it("breaks sentences that stay on screen too long", () => {
    const s = mergeSentences([cue(0, 6000, "one"), cue(6000, 13_000, "two")], {
      maxGapMs: 1500,
      maxDurationMs: 12_000,
      maxWeight: 200,
    });
    expect(s.map((x) => x.text)).toEqual(["one", "two"]);
  });

  it("joins CJK without spaces", () => {
    const s = mergeSentences([cue(0, 1000, "今天我們"), cue(1000, 2000, "來聊 Harvey。")]);
    expect(s.map((x) => x.text)).toEqual(["今天我們來聊 Harvey。"]);
  });
});

describe("sameLanguage", () => {
  it.each([
    ["zh-TW", "zh-TW", true],
    ["zh-Hant", "zh-TW", true],
    ["zh-HK", "zh-TW", true],
    ["zh-CN", "zh-TW", false],
    ["zh-Hans", "zh-CN", true],
    ["zh", "zh-CN", true],
    ["en-GB", "en", true],
    ["en", "ja", false],
  ])("%s vs %s -> %s", (a, b, expected) => {
    expect(sameLanguage(a, b)).toBe(expected);
  });
});

const track = (lang: string, kind: string | null = null): TrackInfo => ({
  lang,
  kind,
  baseUrl: `https://www.youtube.com/api/timedtext?v=abc&lang=${lang}${kind ? `&kind=${kind}` : ""}&signature=sig-${lang}`,
});
// Tracks observed on real videos (spike 2026-11-26).
const TED = [track("tr"), track("zh-TW"), track("en"), track("en", "asr"), track("ja")];
const CHINESE_TALK = [track("zh-TW"), track("en", "asr")];
const playerUrl = (params: string) =>
  `https://www.youtube.com/api/timedtext?v=abc&${params}&pot=TOKEN&potc=1&c=WEB&cver=2.2026&fmt=json3&signature=s`;

describe("originalTrack", () => {
  it("is the uploaded track in the language of the automatic one", () => {
    expect(originalTrack(TED)?.lang).toBe("en");
    expect(originalTrack(TED)?.kind).toBeNull();
  });
  it("is unknown when only the automatic track has that language", () => {
    // YouTube generated English captions for a Chinese talk.
    expect(originalTrack(CHINESE_TALK)).toBeNull();
    expect(originalTrack([track("en"), track("fr")])).toBeNull();
  });
});

describe("trackUrl", () => {
  it("reuses the player's session parameters", () => {
    const url = new URL(trackUrl(track("en"), playerUrl("lang=zh-TW&tlang=ja"), BASE));
    expect(url.searchParams.get("signature")).toBe("sig-en");
    expect(url.searchParams.get("lang")).toBe("en");
    expect(url.searchParams.get("pot")).toBe("TOKEN");
    expect(url.searchParams.get("potc")).toBe("1");
    expect(url.searchParams.get("c")).toBe("WEB");
    expect(url.searchParams.get("cver")).toBe("2.2026");
    expect(url.searchParams.get("fmt")).toBe("json3");
    expect(url.searchParams.has("tlang")).toBe(false);
  });
});

describe("chooseSource", () => {
  it("translates what the player shows when it is not the target language", () => {
    expect(chooseSource(playerUrl("lang=en"), TED, "zh-TW", BASE)).toEqual({ kind: "use" });
  });

  it("switches to the original when the player shows the target language", () => {
    const d = chooseSource(playerUrl("lang=zh-TW"), TED, "zh-TW", BASE);
    expect(d.kind).toBe("fetch");
    const url = new URL((d as { url: string }).url);
    expect(url.searchParams.get("lang")).toBe("en");
    expect(url.searchParams.get("pot")).toBe("TOKEN");
  });

  it("does nothing for a video already spoken in the target language", () => {
    expect(chooseSource(playerUrl("lang=zh-TW"), CHINESE_TALK, "zh-TW", BASE)).toEqual({ kind: "already-target" });
  });

  it("drops YouTube's machine translation and fetches the original", () => {
    const d = chooseSource(playerUrl("lang=en&tlang=zh-Hant"), TED, "zh-TW", BASE);
    expect(d.kind).toBe("fetch");
    const url = new URL((d as { url: string }).url);
    expect(url.searchParams.get("lang")).toBe("en");
    expect(url.searchParams.has("tlang")).toBe(false);
  });

  it("treats a machine translation from the target language like the target", () => {
    // Chinese captions machine-translated to English, viewer reads Chinese.
    expect(chooseSource(playerUrl("lang=zh-TW&tlang=en"), CHINESE_TALK, "zh-TW", BASE)).toEqual({
      kind: "already-target",
    });
  });
});
