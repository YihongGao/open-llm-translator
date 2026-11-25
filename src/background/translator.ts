// Per-batch pipeline: dedupe -> cache lookup -> provider stream -> cache write.
// Kept free of chrome.* APIs so it can be unit-tested with fakes.

import type { TranslateEvent, TranslateRequest } from "../shared/messages";
import type { TokenUsage, TranslationProvider } from "./providers/types";

/** Per-batch numbers for the service worker console. */
export interface BatchStats {
  segments: number;
  /** Distinct source texts after dedupe. */
  unique: number;
  cacheHits: number;
  /** Distinct texts sent to the provider (0 = no API call). */
  sent: number;
  failed: number;
  usage?: TokenUsage;
  /** Model that actually produced the API translations (may differ on refusal fallback). */
  servedModel?: string;
  fallback?: boolean;
  ms: number;
}

export interface CacheEntry {
  text: string;
  /** Model that produced `text`; absent on entries written before it was recorded. */
  model?: string;
}

export interface TranslationCache {
  key(text: string): Promise<string>;
  getMany(keys: readonly string[]): Promise<Array<CacheEntry | undefined>>;
  put(key: string, entry: CacheEntry): Promise<void>;
}

export interface BatchDeps {
  provider: TranslationProvider;
  cache: TranslationCache;
  targetLang: string;
  /** Model the request asks for (part of the cache key). */
  model: string;
  emit(event: TranslateEvent): void;
  describeError(err: unknown): { message: string; settings: boolean };
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
 *
 * API translations stream to the page as they arrive, but the model that
 * served them is only known once the response ends (a refusal fallback can
 * take over mid-request), so it travels on `batch-done`, and cache writes
 * wait until then to record it.
 */
export async function runBatch(
  req: TranslateRequest,
  deps: BatchDeps,
  signal: AbortSignal,
): Promise<BatchStats | null> {
  const { batchId } = req;
  const started = Date.now();

  // Navigation menus and footers repeat the same strings; translate each once.
  const idsByText = new Map<string, string[]>();
  for (const s of req.segments) {
    const ids = idsByText.get(s.text);
    if (ids) ids.push(s.id);
    else idsByText.set(s.text, [s.id]);
  }
  const uniqueTexts = [...idsByText.keys()];

  const stats: BatchStats = {
    segments: req.segments.length,
    unique: uniqueTexts.length,
    cacheHits: 0,
    sent: 0,
    failed: 0,
    ms: 0,
  };
  const emitText = (text: string, translated: string, source: "cache" | "api", model?: string) => {
    for (const id of idsByText.get(text) ?? [])
      deps.emit({ type: "segment", batchId, id, text: translated, source, ...(model ? { model } : {}) });
  };
  const emitError = (texts: readonly string[], message: string, scope: "page" | "segment", settings = false) => {
    const ids = texts.flatMap((t) => idsByText.get(t) ?? []);
    stats.failed += texts.length;
    if (ids.length) deps.emit({ type: "segment-error", batchId, ids, message, scope, settings });
  };
  const finish = (): BatchStats => {
    deps.emit({
      type: "batch-done",
      batchId,
      ...(stats.servedModel ? { servedModel: stats.servedModel, fallback: stats.fallback ?? false } : {}),
    });
    stats.ms = Date.now() - started;
    return stats;
  };

  const keys = await Promise.all(uniqueTexts.map((t) => deps.cache.key(t)));
  let cached: Array<CacheEntry | undefined>;
  try {
    cached = await deps.cache.getMany(keys);
  } catch {
    cached = uniqueTexts.map(() => undefined); // a broken cache must not block translation
  }

  const misses: number[] = [];
  uniqueTexts.forEach((text, i) => {
    const hit = cached[i];
    if (hit !== undefined) {
      stats.cacheHits++;
      // The key includes the requested model, so old entries without a recorded model came from it.
      emitText(text, hit.text, "cache", hit.model ?? deps.model);
    } else misses.push(i);
  });

  if (misses.length > 0) {
    const missTexts = misses.map((i) => uniqueTexts[i]!);
    stats.sent = missTexts.length;
    const results = new Map<number, string>();
    const writeCache = (model: string) => {
      for (const [index, text] of results)
        void deps.cache.put(keys[misses[index]!]!, { text, model }).catch(() => {});
    };
    let reason: keyof typeof MISSING_REASON = "complete";
    try {
      for await (const ev of deps.provider.translate(
        { texts: missTexts, targetLang: deps.targetLang, page: req.page },
        signal,
      )) {
        if (ev.kind === "end") {
          reason = ev.reason;
          stats.usage = ev.usage;
          stats.servedModel = ev.servedModel;
          stats.fallback = ev.fallback;
          continue;
        }
        results.set(ev.index, ev.text);
        emitText(missTexts[ev.index]!, ev.text, "api");
      }
    } catch (err) {
      if (signal.aborted || deps.isAbort(err)) return null;
      // Partial results are still valid; a fallback mid-stream is unlikely enough
      // to attribute them to the requested model.
      writeCache(deps.model);
      const info = deps.describeError(err);
      emitError(
        missTexts.filter((_, i) => !results.has(i)),
        info.message,
        "page",
        info.settings,
      );
      return finish();
    }
    if (signal.aborted) return null;
    writeCache(stats.servedModel ?? deps.model);
    emitError(
      missTexts.filter((_, i) => !results.has(i)),
      MISSING_REASON[reason],
      "segment",
    );
  }

  return finish();
}
