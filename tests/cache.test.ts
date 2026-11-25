import { describe, expect, it } from "vitest";
import { cacheKey } from "../src/background/cache";

describe("cacheKey", () => {
  it("S1: partitions entries by origin", async () => {
    const a = await cacheKey("https://a.example", "claude-haiku-5-5", "zh-TW", "Hello");
    const b = await cacheKey("https://b.example", "claude-haiku-5-5", "zh-TW", "Hello");
    expect(a).not.toBe(b);
  });

  it("separates model, language and text, and is stable", async () => {
    const base = await cacheKey("https://a.example", "claude-haiku-5-5", "zh-TW", "Hello");
    expect(await cacheKey("https://a.example", "claude-haiku-5-5", "zh-TW", "Hello")).toBe(base);
    expect(await cacheKey("https://a.example", "claude-sonnet-5-5", "zh-TW", "Hello")).not.toBe(base);
    expect(await cacheKey("https://a.example", "claude-haiku-5-5", "ja", "Hello")).not.toBe(base);
    expect(await cacheKey("https://a.example", "claude-haiku-5-5", "zh-TW", "Hello!")).not.toBe(base);
  });
});
