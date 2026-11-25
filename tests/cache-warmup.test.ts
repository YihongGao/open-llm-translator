import { describe, expect, it } from "vitest";
import { CacheWarmupGate, withWarmup } from "../src/background/cache-warmup";
import type { ProviderEvent, ProviderRequest, TranslationProvider } from "../src/background/providers/types";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("CacheWarmupGate", () => {
  it("lets one request lead on a cold prefix and holds the rest until it starts", async () => {
    const gate = new CacheWarmupGate();
    const order: string[] = [];
    const leader = await gate.acquire("k");
    order.push("leader sent");
    const follower = gate.acquire("k").then((t) => {
      order.push("follower sent");
      return t;
    });
    await tick();
    expect(order).toEqual(["leader sent"]); // follower still waiting
    leader.started();
    await follower;
    expect(order).toEqual(["leader sent", "follower sent"]);
  });

  it("does not wait once the prefix is warm, and expires before the 5-minute TTL", async () => {
    let now = 0;
    const gate = new CacheWarmupGate(() => now);
    (await gate.acquire("k")).started();

    now = 4 * 60_000;
    const warm = await gate.acquire("k"); // immediate: warm
    warm.started(); // a cache read refreshes the TTL
    now = 8 * 60_000; // 4 min after the refresh: still warm
    await gate.acquire("k");

    now = 20 * 60_000; // long idle: cold again, so this one leads
    const cold = await gate.acquire("k");
    let waited = true;
    void gate.acquire("k").then(() => (waited = false));
    await tick();
    expect(waited).toBe(true);
    cold.done();
  });

  it("hands leadership to the next waiter when the leader fails before responding", async () => {
    const gate = new CacheWarmupGate();
    const leader = await gate.acquire("k");
    const second = gate.acquire("k");
    const third = gate.acquire("k");
    leader.done(); // failed, never started
    const s = await second;
    let thirdSent = false;
    void third.then(() => (thirdSent = true));
    await tick();
    expect(thirdSent).toBe(false); // second is now the leader
    s.started();
    await tick();
    expect(thirdSent).toBe(true);
  });

  it("keeps different prefixes independent", async () => {
    const gate = new CacheWarmupGate();
    await gate.acquire("sonnet|zh-TW");
    let otherSent = false;
    void gate.acquire("haiku|zh-TW").then(() => (otherSent = true));
    await tick();
    expect(otherSent).toBe(true);
  });
});

describe("withWarmup", () => {
  it("marks the prefix warm when the wrapped provider's response starts", async () => {
    const gate = new CacheWarmupGate();
    const inner: TranslationProvider = {
      async *translate(req: ProviderRequest): AsyncGenerator<ProviderEvent> {
        req.onResponseStart?.();
        yield { kind: "end", reason: "complete" };
      },
    };
    const req = { texts: ["a"], targetLang: "zh-TW", page: { title: "", url: "" } };
    for await (const _ of withWarmup(inner, gate, "k").translate(req, new AbortController().signal));
    let sent = false;
    void gate.acquire("k").then(() => (sent = true));
    await tick();
    expect(sent).toBe(true); // warm: no waiting
  });
});
