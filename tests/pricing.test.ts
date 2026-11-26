import { describe, expect, it } from "vitest";
import { estimateCostUsd } from "../src/background/pricing";
import { MODELS } from "../src/shared/settings";

describe("estimateCostUsd", () => {
  it("prices uncached input, cache writes (1.25x), cache reads and output", () => {
    // Sonnet 5.5: $2 in, $10 out, $0.10 cache read per MTok
    const cost = estimateCostUsd("claude-sonnet-5-5", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(2 + 10 + 0.1 + 2.5, 6);
  });

  it("has a price for every selectable model and accepts dated snapshot ids", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    for (const m of MODELS) expect(estimateCostUsd(m.id, usage), m.id).toBeGreaterThan(0);
    expect(estimateCostUsd("gpt-6-luna-2026-10-01", usage)).toBeCloseTo(0.1, 6);
  });

  it("returns undefined for an unknown model", () => {
    expect(estimateCostUsd("some-model", { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeUndefined();
  });
});
