// Decides when to translate more subtitles and which ones. Pure, for tests.
//
// Stock-based rather than a sliding window: a window of "the next two
// minutes" grows by a sentence or two every few seconds, which means a stream
// of tiny requests that each repeat the prompt overhead and give the model
// little context. Instead, translate `lookaheadMs` of speech at once, and only
// when what is left ahead of the playhead drops below `lowWaterMs`.

export type SentenceStatus = "idle" | "queued" | "pending" | "done" | "error";

export interface Plannable {
  start: number;
  end: number;
  status: SentenceStatus;
}

export interface RefillOptions {
  /** How much speech one refill covers (ms of video time). */
  lookaheadMs: number;
  /** Refill when less than this is translated ahead of the playhead (ms). */
  lowWaterMs: number;
}

/** N = 5 minutes, X = 60 seconds (agreed in the design review). */
export const DEFAULT_REFILL: RefillOptions = { lookaheadMs: 5 * 60_000, lowWaterMs: 60_000 };

/**
 * Indices of the sentences to translate now, in order; empty when the stock
 * ahead of `nowMs` is sufficient.
 *
 * Stock is the run of consecutive non-idle sentences starting at the
 * playhead. Queued and pending sentences count as stock, so a refill in
 * flight is not requested again on every timeupdate. Failed sentences count
 * too, so a persistent error (missing API key) does not retry in a loop; the
 * user retries by turning subtitles off and on. After a seek into an
 * untranslated region the stock is zero and a refill starts there at once,
 * while an earlier refill elsewhere keeps running.
 */
export function planRefill(items: readonly Plannable[], nowMs: number, opts: RefillOptions = DEFAULT_REFILL): number[] {
  if (items.length === 0) return [];

  // Short video: translate everything in one go.
  const span = items[items.length - 1]!.end - items[0]!.start;
  if (span <= opts.lookaheadMs + opts.lowWaterMs) {
    const idle: number[] = [];
    items.forEach((it, i) => it.status === "idle" && idle.push(i));
    return idle;
  }

  // First sentence still to be shown: the current one or the next one.
  const first = items.findIndex((it) => it.end > nowMs);
  if (first === -1) return [];

  let k = first;
  while (k < items.length && items[k]!.status !== "idle") k++;
  if (k === items.length) return []; // translated to the end

  // Time until playback runs out of translated sentences.
  const stock = k === first ? 0 : items[k - 1]!.end - nowMs;
  if (stock >= opts.lowWaterMs) return [];

  const until = items[k]!.start + opts.lookaheadMs;
  const picked: number[] = [];
  for (let i = k; i < items.length && items[i]!.start < until; i++) if (items[i]!.status === "idle") picked.push(i);
  return picked;
}

/** Index of the sentence on screen at `nowMs`, or -1 between sentences. Binary search over start times. */
export function sentenceAt(items: readonly { start: number; end: number }[], nowMs: number): number {
  let lo = 0;
  let hi = items.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid]!.start <= nowMs) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found !== -1 && items[found]!.end > nowMs ? found : -1;
}
