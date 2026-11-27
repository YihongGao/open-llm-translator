// @vitest-environment happy-dom
// Drives the real content script with fake IntersectionObserver / chrome.*,
// covering the toggle -> viewport -> batch -> render path.
import { beforeAll, describe, expect, it } from "vitest";
import type { TranslateEvent, TranslateRequest } from "../src/shared/messages";
import { i18nStub } from "./helpers/i18n";

let ioCallback: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void;
let observed: Element[] = [];
const posted: TranslateRequest[] = [];
const sentToBackground: unknown[] = [];
let toPage: (ev: TranslateEvent) => void;
let onContentMessage: (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => void;
/** Sends a message to the content script and returns its synchronous reply. */
function tell(msg: unknown): unknown {
  let reply: unknown;
  onContentMessage(msg, {}, (r) => (reply = r));
  return reply;
}

class FakeIO {
  private readonly scheduling: boolean;
  constructor(cb: typeof ioCallback, opts?: { rootMargin?: string }) {
    // Only the scheduling observer (with a margin) matters here; the
    // exact-viewport one tracks hidden segments, which these tests do not use.
    this.scheduling = Boolean(opts?.rootMargin);
    if (this.scheduling) ioCallback = cb;
  }
  observe(t: Element) {
    if (this.scheduling) observed.push(t);
  }
  unobserve() {}
  disconnect() {}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Report everything observed so far as visible, then wait for the batch flush. */
async function scrollAllIntoView() {
  const targets = observed;
  observed = [];
  ioCallback(targets.map((target) => ({ target, isIntersecting: true })));
  await sleep(200); // > FLUSH_DELAY_MS
}

const toast = () => document.querySelector("llmt-toast")?.shadowRoot ?? null;

beforeAll(async () => {
  (globalThis as any).IntersectionObserver = FakeIO;
  (globalThis as any).chrome = {
    i18n: i18nStub(),
    runtime: {
      connect: () => ({
        postMessage: (m: TranslateRequest) => posted.push(m),
        onMessage: { addListener: (f: typeof toPage) => (toPage = f) },
        onDisconnect: { addListener() {} },
      }),
      onMessage: { addListener: (f: typeof onContentMessage) => (onContentMessage = f) },
      sendMessage: async (m: unknown) => void sentToBackground.push(m),
    },
  };
  document.body.innerHTML = `
    <p>Hello world, this is the first paragraph.</p>
    <p>Second paragraph goes here.</p>
    <h4>Kubelet</h4>
    <p><a href="#nav">A paragraph that is entirely a link.</a></p>`;
  await import("../src/content/index");
  expect(tell({ type: "llmt-toggle", targetLang: "zh-TW" })).toEqual({ active: true, subtitles: null });
  await scrollAllIntoView();
});

describe("content controller", () => {
  it("batches visible segments into one request", () => {
    expect(posted).toHaveLength(1);
    expect(posted[0]!.segments.map((s) => s.text)).toEqual([
      "Hello world, this is the first paragraph.",
      "Second paragraph goes here.",
      "Kubelet",
      "A paragraph that is entirely a link.",
    ]);
  });

  it("renders a translation", () => {
    const seg = posted[0]!.segments[0]!;
    toPage({ type: "segment", batchId: posted[0]!.batchId, id: seg.id, text: "你好世界，這是第一段。", source: "api" });
    expect(document.querySelector("p llmt-translation")!.textContent).toBe("你好世界，這是第一段。");
  });

  it("labels API translations with the served model once the batch completes", () => {
    const node = document.querySelector("p llmt-translation")!;
    expect(node.getAttribute("data-llmt-source")).toBe("api");
    expect(node.hasAttribute("data-llmt-model")).toBe(false); // not known until batch-done
    toPage({ type: "batch-done", batchId: posted[0]!.batchId, servedModel: "claude-sonnet-5", fallback: true });
    expect(node.getAttribute("data-llmt-model")).toBe("claude-sonnet-5");
    expect(node.getAttribute("data-llmt-fallback")).toBe("true");
  });

  it("shows nothing when the model returns the source unchanged (proper nouns)", () => {
    const seg = posted[0]!.segments[2]!;
    toPage({ type: "segment", batchId: posted[0]!.batchId, id: seg.id, text: "Kubelet", source: "api" });
    expect(document.querySelector("h4")!.innerHTML).toBe("Kubelet");
  });

  it("shows one page-level notice with a settings action for page-scope errors", () => {
    const [, second, , linked] = posted[0]!.segments;
    toPage({
      type: "segment-error",
      batchId: posted[0]!.batchId,
      ids: [second!.id, linked!.id],
      message: "尚未設定 Anthropic API key",
      scope: "page",
      settings: true,
      uiLanguage: "auto",
    });

    const markers = document.querySelectorAll("llmt-translation.llmt-error");
    expect(markers).toHaveLength(2);
    expect(markers[0]!.textContent).toBe("⚠");
    expect(document.querySelectorAll("llmt-toast")).toHaveLength(1);
    expect(toast()!.querySelector(".msg")!.textContent).toBe("翻譯失敗：尚未設定 Anthropic API key");

    (toast()!.querySelector(".action") as HTMLButtonElement).click();
    expect(sentToBackground).toContainEqual({ type: "llmt-open-options" });
    expect(toast()).toBeNull();
  });

  it("clicking a ⚠ inside a link shows the reason instead of navigating", () => {
    const marker = document.querySelector("a llmt-translation.llmt-error") as HTMLElement;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    marker.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(toast()!.querySelector(".msg")!.textContent).toBe("翻譯失敗：尚未設定 Anthropic API key");
    expect(toast()!.querySelector(".action")).toBeNull();
  });

  it("retries failed segments when translation is switched off and on again", async () => {
    expect(tell({ type: "llmt-toggle", targetLang: "zh-TW" })).toEqual({ active: false, subtitles: null });
    expect(tell({ type: "llmt-status" })).toEqual({ active: false, subtitles: null });
    expect(tell({ type: "llmt-toggle", targetLang: "zh-TW" })).toEqual({ active: true, subtitles: null });
    expect(toast()).toBeNull();
    await scrollAllIntoView();
    expect(posted).toHaveLength(2);
    expect(posted[1]!.segments.map((s) => s.text)).toEqual([
      "Second paragraph goes here.",
      "A paragraph that is entirely a link.",
    ]);
  });

  it("re-translates everything when the popup changes the target language", async () => {
    expect(tell({ type: "llmt-set-lang", targetLang: "ja" })).toEqual({ active: true, subtitles: null });
    expect(document.querySelectorAll("llmt-translation")).toHaveLength(0);
    await scrollAllIntoView();
    const last = posted.at(-1)!;
    expect(last.segments.map((s) => s.text)).toEqual([
      "Hello world, this is the first paragraph.",
      "Second paragraph goes here.",
      "Kubelet",
      "A paragraph that is entirely a link.",
    ]);
  });
});
