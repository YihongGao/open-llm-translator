// Rough per-batch cost for the service worker log. Prices are USD per million
// tokens as of 2026-11 (standard tier, 5-minute cache TTL for Claude, prompts
// under 200K tokens for Gemini). Sources, to check before relying on them:
//   https://platform.claude.com/docs/en/about-claude/pricing
//   https://developers.openai.com/api/docs/pricing
//   https://ai.google.dev/gemini-api/docs/pricing
// This is an estimate for comparing settings, not a bill.

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
  // OpenAI: output includes reasoning tokens.
  "gpt-6-luna": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "gpt-6.2-sol": { input: 2, output: 10, cacheRead: 0.1 },
  "gpt-6.2-astra": { input: 8, output: 40, cacheRead: 0.4 },
  // Gemini: output includes thinking tokens. Carbon at the rate in force from
  // 2026-12-01 (introductory $2/$10 until then).
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5, cacheRead: 0.03 },
  "gemini-4-hydrogen": { input: 1.5, output: 7.5, cacheRead: 0.075 },
  "gemini-4-carbon": { input: 4, output: 20, cacheRead: 0.2 },
};

/** Cache writes cost 1.25x base input (Claude 5-minute TTL, OpenAI 30-minute retention). */
const CACHE_WRITE_MULTIPLIER = 1.25;

export function estimateCostUsd(model: string, usage: TokenUsage): number | undefined {
  // Served model ids may carry a snapshot date (e.g. "gpt-6-luna-2026-10-01").
  const p = PRICES[model] ?? PRICES[model.replace(/-\d{4}-\d{2}-\d{2}$/, "")];
  if (!p) return undefined;
  return (
    (usage.inputTokens * p.input +
      usage.cacheWriteTokens * p.input * CACHE_WRITE_MULTIPLIER +
      usage.cacheReadTokens * p.cacheRead +
      usage.outputTokens * p.output) /
    1_000_000
  );
}
