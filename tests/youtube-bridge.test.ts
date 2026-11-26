import { describe, expect, it } from "vitest";
import {
  isTimedtextUrl,
  isYouTubeUrl,
  isYouTubeWatchUrl,
  parseHookCommand,
  parseHookEvent,
} from "../src/shared/youtube-bridge";

const BASE = "https://www.youtube.com/watch?v=abc";

describe("isTimedtextUrl", () => {
  it("accepts same-origin caption URLs only", () => {
    expect(isTimedtextUrl("/api/timedtext?v=abc&lang=en", BASE)?.searchParams.get("lang")).toBe("en");
    expect(isTimedtextUrl("https://www.youtube.com/api/timedtext?v=1", BASE)).not.toBeNull();
    expect(isTimedtextUrl("https://evil.example/api/timedtext?v=1", BASE)).toBeNull();
    expect(isTimedtextUrl("/api/stats?v=1", BASE)).toBeNull();
    expect(isTimedtextUrl("http://[bad", BASE)).toBeNull();
  });
});

describe("parseHookEvent", () => {
  const str = (v: unknown) => JSON.stringify(v);

  it("accepts well-formed events", () => {
    expect(parseHookEvent(str({ type: "captions", videoId: "a", url: "u", body: "{}" }))).toEqual({
      type: "captions",
      videoId: "a",
      url: "u",
      body: "{}",
    });
    expect(parseHookEvent(str({ type: "fetched", id: 1, status: 429, body: null }))?.type).toBe("fetched");
    expect(
      parseHookEvent(
        str({ type: "info", id: 2, info: { videoId: "a", isLive: false, tracks: [{ lang: "en", kind: null, baseUrl: "/x" }] } }),
      ),
    ).toEqual({ type: "info", id: 2, info: { videoId: "a", isLive: false, tracks: [{ lang: "en", kind: null, baseUrl: "/x" }] } });
  });

  it("rejects forged or malformed events", () => {
    expect(parseHookEvent({ type: "captions" })).toBeNull(); // not a string
    expect(parseHookEvent("not json")).toBeNull();
    expect(parseHookEvent(str({ type: "captions", videoId: 1, url: "u", body: "" }))).toBeNull();
    expect(parseHookEvent(str({ type: "info", id: 1, info: { tracks: [{ lang: 5 }] } }))).toBeNull();
    expect(parseHookEvent(str({ type: "other" }))).toBeNull();
  });
});

describe("parseHookCommand", () => {
  it("accepts known commands", () => {
    expect(parseHookCommand(JSON.stringify({ cmd: "enable", id: 1 }))).toEqual({ cmd: "enable", id: 1 });
    expect(parseHookCommand(JSON.stringify({ cmd: "request-captions" }))).toEqual({ cmd: "request-captions" });
    expect(parseHookCommand(JSON.stringify({ cmd: "fetch", id: 3, url: "/api/timedtext" }))?.cmd).toBe("fetch");
  });
  it("rejects anything else", () => {
    expect(parseHookCommand(JSON.stringify({ cmd: "eval", code: "x" }))).toBeNull();
    expect(parseHookCommand(JSON.stringify({ cmd: "enable" }))).toBeNull();
    expect(parseHookCommand(42)).toBeNull();
  });
});

describe("YouTube URLs", () => {
  it.each([
    ["https://www.youtube.com/watch?v=abc", true, true],
    ["https://www.youtube.com/", false, true],
    ["https://www.youtube.com/shorts/abc", false, true],
    ["https://m.youtube.com/watch?v=abc", false, false],
    ["https://example.com/watch?v=abc", false, false],
    [undefined, false, false],
  ])("%s", (url, watch, yt) => {
    expect(isYouTubeWatchUrl(url)).toBe(watch);
    expect(isYouTubeUrl(url)).toBe(yt);
  });
});
