import { describe, expect, it } from "vitest";
import type { TranslateEvent, TranslateRequest } from "../src/shared/messages";
import type { ProviderEvent, ProviderRequest, TranslationProvider } from "../src/background/providers/types";
import { runBatch, type TranslationCache } from "../src/background/translator";

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

function memoryCache(initial: Record<string, string> = {}): TranslationCache & { store: Map<string, string> } {
  const store = new Map(Object.entries(initial));
  return {
    store,
    key: async (t) => `k:${t}`,
    getMany: async (keys) => keys.map((k) => store.get(k)),
    put: async (k, v) => void store.set(k, v),
  };
}

const page = { title: "t", url: "https://example.com" };
const req = (texts: string[]): TranslateRequest => ({
  type: "translate",
  batchId: "b1",
  page,
  segments: texts.map((text, i) => ({ id: `s${i}`, text })),
});

async function run(r: TranslateRequest, provider: TranslationProvider, cache = memoryCache()) {
  const events: TranslateEvent[] = [];
  await runBatch(
    r,
    {
      provider,
      cache,
      targetLang: "zh-TW",
      emit: (e) => events.push(e),
      describeError: (e) => (e instanceof Error ? e.message : "?"),
      isAbort: () => false,
    },
    new AbortController().signal,
  );
  return { events, cache };
}

const upper = (r: ProviderRequest): ProviderEvent[] => [
  ...r.texts.map((t, index) => ({ kind: "segment" as const, index, text: t.toUpperCase() })),
  { kind: "end", reason: "complete" },
];

describe("runBatch", () => {
  it("translates each distinct text once and fans out to duplicate ids", async () => {
    const provider = new FakeProvider(upper);
    const { events } = await run(req(["docs", "blog", "docs"]), provider);
    expect(provider.calls[0]!.texts).toEqual(["docs", "blog"]);
    expect(events).toEqual([
      { type: "segment", batchId: "b1", id: "s0", text: "DOCS" },
      { type: "segment", batchId: "b1", id: "s2", text: "DOCS" },
      { type: "segment", batchId: "b1", id: "s1", text: "BLOG" },
      { type: "batch-done", batchId: "b1" },
    ]);
  });

  it("serves cache hits without calling the provider and writes misses back", async () => {
    const provider = new FakeProvider(upper);
    const { events, cache } = await run(req(["docs", "blog"]), provider, memoryCache({ "k:docs": "文件" }));
    expect(provider.calls[0]!.texts).toEqual(["blog"]);
    expect(events[0]).toMatchObject({ id: "s0", text: "文件" });
    expect(cache.store.get("k:blog")).toBe("BLOG");
  });

  it("skips the provider entirely when everything is cached", async () => {
    const provider = new FakeProvider(upper);
    await run(req(["docs"]), provider, memoryCache({ "k:docs": "文件" }));
    expect(provider.calls).toHaveLength(0);
  });

  it("reports segments the model skipped, with the stop reason", async () => {
    const provider = new FakeProvider(() => [
      { kind: "segment", index: 0, text: "A" },
      { kind: "end", reason: "max_tokens" },
    ]);
    const { events } = await run(req(["a", "b"]), provider);
    expect(events).toContainEqual({
      type: "segment-error",
      batchId: "b1",
      ids: ["s1"],
      message: "輸出超過長度上限，這一段被截斷",
    });
    expect(events.at(-1)).toEqual({ type: "batch-done", batchId: "b1" });
  });

  it("keeps partial results and errors only the remainder when the provider throws", async () => {
    const provider = new FakeProvider(() => new Error("boom"));
    const { events } = await run(req(["a", "b"]), provider);
    expect(events).toEqual([
      { type: "segment-error", batchId: "b1", ids: ["s0", "s1"], message: "boom" },
      { type: "batch-done", batchId: "b1" },
    ]);
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
        emit: (e) => events.push(e),
        describeError: () => "x",
        isAbort: () => false,
      },
      controller.signal,
    );
    expect(events).toEqual([]);
  });
});
