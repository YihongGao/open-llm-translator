import { describe, expect, it } from "vitest";
import { planRefill, sentenceAt, type Plannable, type SentenceStatus } from "../src/content/youtube/refill";

const MIN = 60_000;
const OPTS = { lookaheadMs: 5 * MIN, lowWaterMs: MIN };

/** One 5-second sentence every 10 seconds for `minutes`. */
function video(minutes: number): Plannable[] {
  const out: Plannable[] = [];
  for (let t = 0; t < minutes * MIN; t += 10_000) out.push({ start: t, end: t + 5_000, status: "idle" });
  return out;
}

function mark(items: Plannable[], idx: number[], status: SentenceStatus): void {
  for (const i of idx) items[i]!.status = status;
}

describe("planRefill", () => {
  it("translates a short video in one go", () => {
    const items = video(5);
    expect(planRefill(items, 0, OPTS)).toHaveLength(items.length);
  });

  it("fills N minutes ahead of the playhead on a long video", () => {
    const items = video(30);
    const picked = planRefill(items, 0, OPTS);
    expect(picked[0]).toBe(0);
    expect(items[picked.at(-1)!]!.start).toBeLessThan(5 * MIN);
    expect(picked).toHaveLength(30); // 5 minutes, one sentence per 10 s
  });

  it("does not ask again while the refill is in flight", () => {
    const items = video(30);
    mark(items, planRefill(items, 0, OPTS), "pending");
    expect(planRefill(items, 1_000, OPTS)).toEqual([]);
  });

  it("waits until the stock drops below X, then refills from where it ends", () => {
    const items = video(30);
    mark(items, planRefill(items, 0, OPTS), "done");
    // Translated through 4:55; at 3:00 there are ~2 minutes left.
    expect(planRefill(items, 3 * MIN, OPTS)).toEqual([]);
    // At 4:00 less than a minute is left.
    const next = planRefill(items, 4 * MIN, OPTS);
    expect(items[next[0]!]!.start).toBe(5 * MIN);
    expect(next).toHaveLength(30);
  });

  it("refills at a seek target even while another refill is in flight", () => {
    const items = video(30);
    mark(items, planRefill(items, 0, OPTS), "pending");
    const picked = planRefill(items, 20 * MIN, OPTS);
    expect(items[picked[0]!]!.start).toBe(20 * MIN);
  });

  it("does not retry failed sentences on its own", () => {
    const items = video(30);
    mark(items, planRefill(items, 0, OPTS), "error");
    expect(planRefill(items, 1_000, OPTS)).toEqual([]);
  });

  it("includes the sentence on screen", () => {
    const items = video(30);
    expect(planRefill(items, 10 * MIN + 2_000, OPTS)[0]).toBe(60);
  });

  it("stops at the end of the video", () => {
    const items = video(30);
    mark(
      items,
      items.map((_, i) => i).filter((i) => items[i]!.start >= 27 * MIN),
      "done",
    );
    expect(planRefill(items, 28 * MIN, OPTS)).toEqual([]);
    expect(planRefill(items, 31 * MIN, OPTS)).toEqual([]);
  });
});

describe("sentenceAt", () => {
  const items = [
    { start: 0, end: 1000 },
    { start: 2000, end: 3000 },
    { start: 3000, end: 4000 },
  ];
  it.each([
    [0, 0],
    [999, 0],
    [1500, -1],
    [2000, 1],
    [3000, 2],
    [4000, -1],
    [-5, -1],
  ])("at %i -> %i", (t, expected) => {
    expect(sentenceAt(items, t)).toBe(expected);
  });
});
