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

  it("does not read entries written before the Japanese prompt fix", async () => {
    // Those can hold Chinese under a "ja" key, and nothing evicts them.
    const bytes = new TextEncoder().encode("https://a.example\u0000claude-haiku-5-5\u0000ja\u0000Basics");
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const before = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
    expect(await cacheKey("https://a.example", "claude-haiku-5-5", "ja", "Basics")).not.toBe(before);
  });
});
