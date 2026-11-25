import { describe, expect, it } from "vitest";
import type { TranslateEvent, TranslateRequest } from "../src/shared/messages";
import type { ProviderEvent, ProviderRequest, TranslationProvider } from "../src/background/providers/types";
import { runBatch, type CacheEntry, type TranslationCache } from "../src/background/translator";

class FakeProvider implements TranslationProvider {
  calls: ProviderRequest[] = [];
  constructor(private readonly script: (req: ProviderRequest) => ProviderEvent[] | Error) {}
  async *translate(req: ProviderRequest): AsyncGenerator<ProviderEvent> {
    this.calls.push(req);
    const result = this.script(req);
    if (result instanceof Error) throw result;
    for (const ev of result) yield ev;
  }
}

function memoryCache(initial: Record<string, CacheEntry> = {}): TranslationCache & { store: Map<string, CacheEntry> } {
  const store = new Map(Object.entries(initial));
  return {
    store,
    key: async (t) => `k:${t}`,
    getMany: async (keys) => keys.map((k) => store.get(k)),
    put: async (k, v) => void store.set(k, v),
  };
}

const MODEL = "claude-sonnet-5-5";
const page = { title: "t", url: "https://example.com" };
const req = (texts: string[]): TranslateRequest => ({
  type: "translate",
  batchId: "b1",
  page,
  segments: texts.map((text, i) => ({ id: `s${i}`, text })),
});

async function run(r: TranslateRequest, provider: TranslationProvider, cache = memoryCache()) {
  const events: TranslateEvent[] = [];
  const stats = await runBatch(
    r,
    {
      provider,
      cache,
      targetLang: "zh-TW",
      model: MODEL,
      emit: (e) => events.push(e),
      describeError: (e) => ({ message: e instanceof Error ? e.message : "?", settings: false }),
      isAbort: () => false,
    },
    new AbortController().signal,
  );
  return { events, cache, stats };
}

const upper = (r: ProviderRequest): ProviderEvent[] => [
  ...r.texts.map((t, index) => ({ kind: "segment" as const, index, text: t.toUpperCase() })),
  { kind: "end", reason: "complete", servedModel: MODEL, fallback: false },
];

describe("runBatch", () => {
  it("translates each distinct text once and fans out to duplicate ids", async () => {
    const provider = new FakeProvider(upper);
    const { events } = await run(req(["docs", "blog", "docs"]), provider);
    expect(provider.calls[0]!.texts).toEqual(["docs", "blog"]);
    expect(events).toEqual([
      { type: "segment", batchId: "b1", id: "s0", text: "DOCS", source: "api" },
      { type: "segment", batchId: "b1", id: "s2", text: "DOCS", source: "api" },
      { type: "segment", batchId: "b1", id: "s1", text: "BLOG", source: "api" },
      { type: "batch-done", batchId: "b1", servedModel: MODEL, fallback: false },
    ]);
  });

  it("serves cache hits with their recorded model and writes misses back with the served model", async () => {
    const provider = new FakeProvider((r) => [
      ...r.texts.map((t, index) => ({ kind: "segment" as const, index, text: t.toUpperCase() })),
      { kind: "end", reason: "complete", servedModel: "claude-sonnet-5", fallback: true },
    ]);
    const { events, cache } = await run(
      req(["docs", "blog"]),
      provider,
      memoryCache({ "k:docs": { text: "文件", model: "claude-haiku-5-5" } }),
    );
    expect(provider.calls[0]!.texts).toEqual(["blog"]);
    expect(events[0]).toEqual({ type: "segment", batchId: "b1", id: "s0", text: "文件", source: "cache", model: "claude-haiku-5-5" });
    expect(events.at(-1)).toEqual({ type: "batch-done", batchId: "b1", servedModel: "claude-sonnet-5", fallback: true });
    expect(cache.store.get("k:blog")).toEqual({ text: "BLOG", model: "claude-sonnet-5" });
  });

  it("attributes legacy cache entries without a model to the requested model", async () => {
    const { events } = await run(req(["docs"]), new FakeProvider(upper), memoryCache({ "k:docs": { text: "文件" } }));
    expect(events[0]).toMatchObject({ source: "cache", model: MODEL });
    expect(events.at(-1)).toEqual({ type: "batch-done", batchId: "b1" }); // no API call, no servedModel
  });

  it("reports batch stats including token usage and served model", async () => {
    const provider = new FakeProvider((r) => [
      ...r.texts.map((t, index) => ({ kind: "segment" as const, index, text: t })),
      {
        kind: "end",
        reason: "complete",
        usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 },
        servedModel: MODEL,
        fallback: false,
      },
    ]);
    const { stats } = await run(
      req(["docs", "blog", "docs", "faq"]),
      provider,
      memoryCache({ "k:faq": { text: "常見問題", model: MODEL } }),
    );
    expect(stats).toMatchObject({
      segments: 4,
      unique: 3,
      cacheHits: 1,
      sent: 2,
      failed: 0,
      usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 },
      servedModel: MODEL,
      fallback: false,
    });
  });

  it("skips the provider entirely when everything is cached", async () => {
    const provider = new FakeProvider(upper);
    await run(req(["docs"]), provider, memoryCache({ "k:docs": { text: "文件", model: MODEL } }));
    expect(provider.calls).toHaveLength(0);
  });

  it("reports segments the model skipped, with the stop reason", async () => {
    const provider = new FakeProvider(() => [
      { kind: "segment", index: 0, text: "A" },
      { kind: "end", reason: "max_tokens", servedModel: MODEL, fallback: false },
    ]);
    const { events } = await run(req(["a", "b"]), provider);
    expect(events).toContainEqual({
      type: "segment-error",
      batchId: "b1",
      ids: ["s1"],
      message: "輸出超過長度上限，這一段被截斷",
      scope: "segment",
      settings: false,
    });
    expect(events.at(-1)).toMatchObject({ type: "batch-done", batchId: "b1" });
  });

  it("errors the remainder as a page-scope error when the provider throws, keeping partial results cached", async () => {
    const provider: TranslationProvider = {
      async *translate() {
        yield { kind: "segment", index: 0, text: "A" };
        throw new Error("boom");
      },
    };
    const { events, cache } = await run(req(["a", "b"]), provider);
    expect(events).toEqual([
      { type: "segment", batchId: "b1", id: "s0", text: "A", source: "api" },
      { type: "segment-error", batchId: "b1", ids: ["s1"], message: "boom", scope: "page", settings: false },
      { type: "batch-done", batchId: "b1" },
    ]);
    expect(cache.store.get("k:a")).toEqual({ text: "A", model: MODEL });
  });

  it("emits nothing further once aborted", async () => {
    const controller = new AbortController();
    const events: TranslateEvent[] = [];
    const provider: TranslationProvider = {
      async *translate() {
        controller.abort();
        throw new Error("aborted");
      },
    };
    await runBatch(
      req(["a"]),
      {
        provider,
        cache: memoryCache(),
        targetLang: "zh-TW",
        model: MODEL,
        emit: (e) => events.push(e),
        describeError: () => ({ message: "x", settings: false }),
        isAbort: () => false,
      },
      controller.signal,
    );
    expect(events).toEqual([]);
  });
});
