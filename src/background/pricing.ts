// Rough per-batch cost for the service worker log. Prices are USD per million
// tokens as of 2026-11 (standard tier, 5-minute cache TTL); check
// https://platform.claude.com/docs/en/about-claude/pricing before relying on
// them. This is an estimate for comparing settings, not a bill.

import type { TokenUsage } from "./providers/types";

interface Price {
  input: number;
  output: number;
  cacheRead: number;
}

const PRICES: Record<string, Price> = {
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  // Possible refusal-fallback targets.
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
};

/** 5-minute cache writes cost 1.25x base input. */
const CACHE_WRITE_MULTIPLIER = 1.25;

export function estimateCostUsd(model: string, usage: TokenUsage): number | undefined {
  const p = PRICES[model];
  if (!p) return undefined;
  return (
    (usage.inputTokens * p.input +
      usage.cacheWriteTokens * p.input * CACHE_WRITE_MULTIPLIER +
      usage.cacheReadTokens * p.cacheRead +
      usage.outputTokens * p.output) /
    1_000_000
  );
}
