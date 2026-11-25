// Per-batch pipeline: dedupe -> cache lookup -> provider stream -> cache write.
// Kept free of chrome.* APIs so it can be unit-tested with fakes.

import type { TranslateEvent, TranslateRequest } from "../shared/messages";
import type { TranslationProvider } from "./providers/types";

export interface TranslationCache {
  key(text: string): Promise<string>;
  getMany(keys: readonly string[]): Promise<Array<string | undefined>>;
  put(key: string, text: string): Promise<void>;
}

export interface BatchDeps {
  provider: TranslationProvider;
  cache: TranslationCache;
  targetLang: string;
  emit(event: TranslateEvent): void;
  describeError(err: unknown): string;
  isAbort(err: unknown): boolean;
}

const MISSING_REASON = {
  complete: "模型漏翻了這一段",
  max_tokens: "輸出超過長度上限，這一段被截斷",
  refusal: "模型拒絕翻譯這一段內容",
} as const;

/**
 * Guarantees every segment id in `req` receives exactly one `segment` or
 * `segment-error` event, followed by one `batch-done` — unless `signal` is
 * aborted (the page went away), in which case nothing more is emitted.
 */
export async function runBatch(req: TranslateRequest, deps: BatchDeps, signal: AbortSignal): Promise<void> {
  const { batchId } = req;

  // Navigation menus and footers repeat the same strings; translate each once.
  const idsByText = new Map<string, string[]>();
  for (const s of req.segments) {
    const ids = idsByText.get(s.text);
    if (ids) ids.push(s.id);
    else idsByText.set(s.text, [s.id]);
  }
  const uniqueTexts = [...idsByText.keys()];

  const emitText = (text: string, translated: string) => {
    for (const id of idsByText.get(text) ?? []) deps.emit({ type: "segment", batchId, id, text: translated });
  };
  const emitError = (texts: readonly string[], message: string) => {
    const ids = texts.flatMap((t) => idsByText.get(t) ?? []);
    if (ids.length) deps.emit({ type: "segment-error", batchId, ids, message });
  };

  const keys = await Promise.all(uniqueTexts.map((t) => deps.cache.key(t)));
  let cached: Array<string | undefined>;
  try {
    cached = await deps.cache.getMany(keys);
  } catch {
    cached = uniqueTexts.map(() => undefined); // a broken cache must not block translation
  }

  const misses: number[] = [];
  uniqueTexts.forEach((text, i) => {
    const hit = cached[i];
    if (hit !== undefined) emitText(text, hit);
    else misses.push(i);
  });

  if (misses.length > 0) {
    const missTexts = misses.map((i) => uniqueTexts[i]!);
    const done = new Set<number>();
    let reason: keyof typeof MISSING_REASON = "complete";
    try {
      for await (const ev of deps.provider.translate(
        { texts: missTexts, targetLang: deps.targetLang, page: req.page },
        signal,
      )) {
        if (ev.kind === "end") {
          reason = ev.reason;
          continue;
        }
        done.add(ev.index);
        const source = missTexts[ev.index]!;
        emitText(source, ev.text);
        void deps.cache.put(keys[misses[ev.index]!]!, ev.text).catch(() => {});
      }
    } catch (err) {
      if (signal.aborted || deps.isAbort(err)) return;
      emitError(
        missTexts.filter((_, i) => !done.has(i)),
        deps.describeError(err),
      );
      deps.emit({ type: "batch-done", batchId });
      return;
    }
    if (signal.aborted) return;
    emitError(
      missTexts.filter((_, i) => !done.has(i)),
      MISSING_REASON[reason],
    );
  }

  deps.emit({ type: "batch-done", batchId });
}
