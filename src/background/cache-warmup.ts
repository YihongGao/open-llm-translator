// Prompt-cache warm-up gate.
//
// The system prompt is cached server-side, but only once a request that
// writes it has started responding. When a page opens, the first few batches
// go out at the same moment and each would pay its own cache write (1.25x
// input) for the same prefix. The gate lets one request lead per prefix and
// holds the others until the leader's response starts; after that they read
// the cache.
//
// "Warm" is tracked locally from the last response start and expires a bit
// before the API's 5-minute TTL. The server may still evict earlier; that
// only costs one extra write, never correctness.

import type { ProviderEvent, ProviderRequest, TranslationProvider } from "./providers/types";

const TTL_MS = 5 * 60_000;
const SAFETY_MS = 30_000;

export class CacheWarmupGate {
  private readonly warmUntil = new Map<string, number>();
  private readonly leaders = new Map<string, Promise<void>>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Resolves when the caller may send. Returns `started`, to call when the
   * response starts streaming (marks the prefix warm), and `done`, to call
   * when the request ends either way (lets waiters through even on failure).
   */
  async acquire(key: string): Promise<{ started: () => void; done: () => void }> {
    for (;;) {
      if ((this.warmUntil.get(key) ?? 0) > this.now()) return this.follower(key);
      const leader = this.leaders.get(key);
      if (!leader) break;
      await leader; // leader started or failed; re-check
    }

    let release!: () => void;
    this.leaders.set(
      key,
      new Promise<void>((r) => (release = r)),
    );
    let released = false;
    const finish = () => {
      if (released) return;
      released = true;
      this.leaders.delete(key);
      release();
    };
    return {
      started: () => {
        this.markWarm(key);
        finish();
      },
      // On failure before any response, the next waiter becomes the leader.
      done: finish,
    };
  }

  private follower(key: string) {
    return { started: () => this.markWarm(key), done: () => {} };
  }

  /** Every cache read refreshes the server-side TTL, so refresh ours too. */
  private markWarm(key: string): void {
    this.warmUntil.set(key, this.now() + TTL_MS - SAFETY_MS);
  }
}

/** Wraps a provider so its API calls go through the gate under `key` (one key per cached prefix). */
export function withWarmup(inner: TranslationProvider, gate: CacheWarmupGate, key: string): TranslationProvider {
  return {
    async *translate(req: ProviderRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
      const ticket = await gate.acquire(key);
      try {
        yield* inner.translate(
          {
            ...req,
            onResponseStart: () => {
              ticket.started();
              req.onResponseStart?.();
            },
          },
          signal,
        );
      } finally {
        ticket.done();
      }
    },
  };
}
