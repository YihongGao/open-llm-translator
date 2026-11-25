// @vitest-environment happy-dom
// Drives the real content script with fake IntersectionObserver / chrome.*,
// covering the toggle -> viewport -> batch -> render path.
import { beforeAll, describe, expect, it } from "vitest";
import type { TranslateEvent, TranslateRequest } from "../src/shared/messages";

let ioCallback: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void;
const observed: Element[] = [];
const posted: TranslateRequest[] = [];
let toPage: (ev: TranslateEvent) => void;
let toggle: (msg: unknown) => void;

class FakeIO {
  constructor(cb: typeof ioCallback) {
    ioCallback = cb;
  }
  observe(t: Element) {
    observed.push(t);
  }
  unobserve() {}
  disconnect() {}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  (globalThis as any).IntersectionObserver = FakeIO;
  (globalThis as any).chrome = {
    runtime: {
      connect: () => ({
        postMessage: (m: TranslateRequest) => posted.push(m),
        onMessage: { addListener: (f: typeof toPage) => (toPage = f) },
        onDisconnect: { addListener() {} },
      }),
      onMessage: { addListener: (f: typeof toggle) => (toggle = f) },
    },
  };
  document.body.innerHTML = `<p>Hello world, this is the first paragraph.</p><p>Second paragraph goes here.</p>`;
  await import("../src/content/index");
  toggle({ type: "llmt-toggle", targetLang: "zh-TW" });
  ioCallback(observed.map((target) => ({ target, isIntersecting: true })));
  await sleep(200); // FLUSH_DELAY_MS
});

describe("content controller", () => {
  it("batches visible segments into one request", () => {
    expect(posted).toHaveLength(1);
    expect(posted[0]!.segments.map((s) => s.text)).toEqual([
      "Hello world, this is the first paragraph.",
      "Second paragraph goes here.",
    ]);
  });

  it("renders a translation, and an error marker with the reason as tooltip", () => {
    const [ok, bad] = posted[0]!.segments;
    toPage({ type: "segment", batchId: posted[0]!.batchId, id: ok!.id, text: "你好世界，這是第一段。" });
    toPage({ type: "segment-error", batchId: posted[0]!.batchId, ids: [bad!.id], message: "尚未設定 Anthropic API key" });

    const nodes = document.querySelectorAll("llmt-translation");
    expect(nodes[0]!.textContent).toBe("你好世界，這是第一段。");
    expect(nodes[1]!.textContent).toBe("⚠");
    expect(nodes[1]!.getAttribute("title")).toBe("翻譯失敗：尚未設定 Anthropic API key");
  });
});
