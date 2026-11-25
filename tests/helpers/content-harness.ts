// Loads a fresh copy of the real content script into happy-dom with fake
// IntersectionObserver / chrome.* (adapted from the review's reproduction harness).
import { vi } from "vitest";
import type { TranslateEvent, TranslateRequest } from "../../src/shared/messages";

export const h = {
  ioCallback: null as unknown as (entries: Array<{ target: Element; isIntersecting: boolean }>) => void,
  observed: [] as Element[],
  posted: [] as TranslateRequest[],
  toPage: null as unknown as (ev: TranslateEvent) => void,
  onContentMessage: null as unknown as (msg: unknown, sender: unknown, reply: (r: unknown) => void) => void,
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sends a message to the content script and returns its synchronous reply. */
export function tell(msg: unknown): unknown {
  let reply: unknown;
  h.onContentMessage(msg, {}, (r) => (reply = r));
  return reply;
}

/** Reports everything observed so far as visible, then waits past the batch flush delay. */
export async function scrollAllIntoView(): Promise<void> {
  const targets = h.observed;
  h.observed = [];
  h.ioCallback(targets.map((target) => ({ target, isIntersecting: true })));
  await sleep(200);
}

/** Waits past the MutationObserver rescan delay. */
export const afterRescan = () => sleep(500);

class FakeIO {
  constructor(cb: typeof h.ioCallback) {
    h.ioCallback = cb;
  }
  observe(t: Element) {
    h.observed.push(t);
  }
  unobserve() {}
  disconnect() {}
}

/** Replies to every segment of a batch with "譯:<source>" and closes the batch. */
export function answer(batch: TranslateRequest, translate = (s: string) => `譯:${s}`): void {
  for (const s of batch.segments)
    h.toPage({ type: "segment", batchId: batch.batchId, id: s.id, text: translate(s.text), source: "api" });
  h.toPage({ type: "batch-done", batchId: batch.batchId, servedModel: "claude-haiku-5-5", fallback: false });
}

/** Fresh content script instance on `html`, toggled on in `lang`. */
export async function loadContent(html: string, lang = "zh-TW"): Promise<void> {
  // Switch off the previous instance so its MutationObserver stops reacting.
  if ((h.onContentMessage as unknown) && (tell({ type: "llmt-status" }) as { active?: boolean })?.active)
    tell({ type: "llmt-toggle", targetLang: lang });
  h.observed = [];
  h.posted.length = 0;
  (globalThis as any).IntersectionObserver = FakeIO;
  (globalThis as any).chrome = {
    runtime: {
      connect: () => ({
        postMessage: (m: TranslateRequest) => h.posted.push(m),
        onMessage: { addListener: (f: typeof h.toPage) => (h.toPage = f) },
        onDisconnect: { addListener() {} },
      }),
      onMessage: { addListener: (f: typeof h.onContentMessage) => (h.onContentMessage = f) },
      sendMessage: async () => {},
    },
  };
  document.body.innerHTML = html;
  delete (window as { __llmtLoaded?: boolean }).__llmtLoaded;
  vi.resetModules();
  await import("../../src/content/index");
  tell({ type: "llmt-toggle", targetLang: lang });
}
