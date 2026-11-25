// Content script, injected on demand by the background worker on the first
// toggle. Owns DOM scanning, viewport scheduling and rendering; all network
// work happens in the background worker over a Port.

import {
  PORT_NAME,
  type ContentMessage,
  type Segment,
  type TabState,
  type TranslateEvent,
  type TranslateRequest,
} from "../shared/messages";
import {
  TRANSLATION_TAG,
  chooseLayout,
  collectSegments,
  insertionPoint,
  isExcludedByAncestor,
  isSameText,
  isSkipped,
  type Layout,
  type SegmentCandidate,
} from "./segmenter";
import { hideToast, showToast } from "./toast";

declare global {
  interface Window {
    __llmtLoaded?: boolean;
  }
}

// Batch limits: big enough to give the model context and amortise request
// overhead, small enough that the first translations show up quickly.
const MAX_BATCH_CHARS = 3000;
const MAX_BATCH_SEGMENTS = 40;
const FLUSH_DELAY_MS = 120;
const RESCAN_DELAY_MS = 400;
const VIEWPORT_MARGIN = "600px 0px";
const MAX_RETRIES = 1;

/** "retired": replaced by a rescan; ignored everywhere and never sent. */
type Status = "idle" | "queued" | "pending" | "done" | "error" | "retired";

/**
 * A container whose text is re-translated more often than this is treated as
 * volatile (clock, counter, ticker) and left untranslated: each change would
 * otherwise cost an API call and a cache entry.
 */
const MAX_RETRANSLATIONS = 3;

interface SegState {
  id: string;
  candidate: SegmentCandidate;
  layout: Layout;
  status: Status;
  node: HTMLElement | null;
  translation?: string;
  /** Translation equals the source (proper noun, code): nothing is shown. */
  hidden: boolean;
  retries: number;
  /** Provenance, exposed as data-llmt-* attributes for inspection. */
  source?: "cache" | "api";
  model?: string;
  fallback?: boolean;
}

if (!window.__llmtLoaded) {
  window.__llmtLoaded = true;
  main();
}

function main(): void {
  let active = false;
  let targetLang = "zh-TW";
  let nextId = 0;
  let nextBatch = 0;

  let byAnchor = new WeakMap<Node, SegState>();
  const byId = new Map<string, SegState>();
  const byObserved = new Map<Element, SegState[]>();
  const queue: SegState[] = [];
  let flushTimer: number | undefined;
  let port: chrome.runtime.Port | null = null;

  // --- viewport scheduling --------------------------------------------------

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        // While toggled off, keep observing so segments are picked up on re-activation.
        if (!entry.isIntersecting || !active) continue;
        const segs = byObserved.get(entry.target) ?? [];
        byObserved.delete(entry.target);
        io.unobserve(entry.target);
        for (const seg of segs) if (seg.status === "idle") enqueue(seg);
      }
    },
    { rootMargin: VIEWPORT_MARGIN },
  );

  function observe(seg: SegState): void {
    // Observe the run's first element (text nodes cannot be observed).
    const target =
      seg.candidate.nodes.find((n): n is Element => n.nodeType === Node.ELEMENT_NODE) ?? seg.candidate.container;
    const list = byObserved.get(target);
    if (list) list.push(seg);
    else {
      byObserved.set(target, [seg]);
      io.observe(target);
    }
  }

  // --- scanning ---------------------------------------------------------------

  /** Remove a segment for good: its node, its registrations, and any future send. */
  function retire(seg: SegState): void {
    seg.status = "retired";
    seg.node?.remove();
    byId.delete(seg.id);
    for (const [target, list] of byObserved) {
      const i = list.indexOf(seg);
      if (i === -1) continue;
      list.splice(i, 1);
      if (list.length === 0) {
        byObserved.delete(target);
        io.unobserve(target);
      }
      break;
    }
  }

  /** Re-translations per container, for MAX_RETRANSLATIONS. */
  let churn = new WeakMap<Element, number>();

  /**
   * Reconcile segments under `root` with the DOM: keep segments whose anchor
   * and text are unchanged, retire every other segment under `root` (text
   * changed in place, anchor replaced, run extended), and register new ones.
   */
  function scan(root: Element): void {
    const candidates = collectSegments(root, { targetLang });
    const kept = new Set<SegState>();
    for (const c of candidates) {
      const existing = byAnchor.get(c.anchor);
      if (existing && existing.status !== "retired" && existing.candidate.text === c.text) kept.add(existing);
    }
    for (const seg of [...byId.values()]) {
      if (kept.has(seg) || !root.contains(seg.candidate.container)) continue;
      retire(seg);
      churn.set(seg.candidate.container, (churn.get(seg.candidate.container) ?? 0) + 1);
    }

    for (const candidate of candidates) {
      const existing = byAnchor.get(candidate.anchor);
      if (existing && kept.has(existing)) {
        // The framework re-rendered and dropped our node: put it back.
        if (existing.node && !existing.node.isConnected && !existing.hidden && existing.status !== "idle") {
          existing.candidate = candidate;
          mountNode(existing);
        }
        continue;
      }
      if ((churn.get(candidate.container) ?? 0) > MAX_RETRANSLATIONS) continue; // volatile text
      const seg: SegState = {
        id: String(nextId++),
        candidate,
        layout: chooseLayout(candidate.text),
        status: "idle",
        node: null,
        hidden: false,
        retries: 0,
      };
      byAnchor.set(candidate.anchor, seg);
      byId.set(seg.id, seg);
      observe(seg);
    }
  }

  let pendingRoots = new Set<Element>();
  let rescanTimer: number | undefined;

  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "characterData") {
        const el = m.target.parentElement;
        if (el && !isOurs(el)) pendingRoots.add(blockAncestor(el));
        continue;
      }
      for (const n of m.addedNodes) {
        if (n.nodeType === Node.ELEMENT_NODE && !isOurs(n as Element)) pendingRoots.add(blockAncestor(n as Element));
        else if (n.nodeType === Node.TEXT_NODE && n.parentElement && !isOurs(n.parentElement))
          pendingRoots.add(blockAncestor(n.parentElement));
      }
    }
    if (pendingRoots.size && rescanTimer === undefined) {
      rescanTimer = window.setTimeout(() => {
        rescanTimer = undefined;
        const roots = [...pendingRoots].filter((r) => r.isConnected);
        pendingRoots = new Set();
        // Skip roots nested inside another root being rescanned, and roots
        // inside regions the page excludes (translate=no, buttons, code...).
        for (const r of roots)
          if (!roots.some((o) => o !== r && o.contains(r)) && !isSkipped(r) && !isExcludedByAncestor(r)) scan(r);
      }, RESCAN_DELAY_MS);
    }
  });

  // --- rendering --------------------------------------------------------------

  function mountNode(seg: SegState): void {
    if (!seg.node) {
      const node = document.createElement(TRANSLATION_TAG.toLowerCase());
      node.setAttribute("translate", "no");
      node.classList.add(seg.layout === "inline" ? "llmt-inline" : "llmt-block");
      seg.node = node;
    }
    const { parent, before } = insertionPoint(seg.candidate);
    if (parent.isConnected) parent.insertBefore(seg.node, before);
  }

  function render(seg: SegState): void {
    if (!seg.node || !seg.node.isConnected) mountNode(seg);
    const node = seg.node!;
    node.classList.toggle("llmt-pending", seg.status === "pending" || seg.status === "queued");
    node.classList.toggle("llmt-error", seg.status === "error");
    if (seg.status === "done") {
      node.textContent = seg.translation ?? "";
      node.removeAttribute("title");
      setProvenance(seg);
    } else if (seg.status === "error") {
      node.textContent = "⚠";
    } else {
      node.textContent = "…";
    }
  }

  // --- batching & transport ---------------------------------------------------

  function enqueue(seg: SegState): void {
    seg.status = "queued";
    render(seg);
    queue.push(seg);
    if (flushTimer === undefined) flushTimer = window.setTimeout(flush, FLUSH_DELAY_MS);
  }

  function flush(): void {
    flushTimer = undefined;
    while (queue.length) {
      const batch: Segment[] = [];
      let chars = 0;
      while (queue.length && batch.length < MAX_BATCH_SEGMENTS) {
        const seg = queue[0]!;
        if (batch.length > 0 && chars + seg.candidate.text.length > MAX_BATCH_CHARS) break;
        queue.shift();
        // Retired or removed before we got to it.
        if (seg.status !== "queued" || !seg.candidate.anchor.isConnected) continue;
        seg.status = "pending";
        batch.push({ id: seg.id, text: seg.candidate.text });
        chars += seg.candidate.text.length;
      }
      if (batch.length === 0) continue;
      const req: TranslateRequest = {
        type: "translate",
        batchId: String(nextBatch++),
        segments: batch,
        targetLang,
        page: { title: document.title, url: location.href },
      };
      getPort().postMessage(req);
    }
  }

  function getPort(): chrome.runtime.Port {
    if (port) return port;
    const p = chrome.runtime.connect({ name: PORT_NAME });
    p.onMessage.addListener(onEvent);
    p.onDisconnect.addListener(() => {
      void chrome.runtime.lastError; // see background onDisconnect
      port = null;
      // The worker was suspended or reloaded mid-request: retry what was in flight.
      for (const seg of byId.values()) {
        if (seg.status !== "pending") continue;
        if (seg.retries < MAX_RETRIES && active) {
          seg.retries++;
          enqueue(seg);
        } else {
          seg.status = "error";
          render(seg);
          seg.node?.setAttribute("title", "與背景程式的連線中斷");
        }
      }
    });
    port = p;
    return p;
  }

  /**
   * Which model produced a translation, inspectable with right-click → Inspect:
   * data-llmt-model, data-llmt-source (api | cache), data-llmt-fallback.
   */
  function setProvenance(seg: SegState): void {
    const node = seg.node;
    if (!node) return;
    if (seg.source) node.setAttribute("data-llmt-source", seg.source);
    if (seg.model) node.setAttribute("data-llmt-model", seg.model);
    else node.removeAttribute("data-llmt-model");
    if (seg.fallback) node.setAttribute("data-llmt-fallback", "true");
    else node.removeAttribute("data-llmt-fallback");
  }

  /** API results waiting for batch-done to learn which model served them. */
  const awaitingModel = new Map<string, SegState[]>();

  function onEvent(ev: TranslateEvent): void {
    if (ev.type === "batch-done") {
      const segs = awaitingModel.get(ev.batchId) ?? [];
      awaitingModel.delete(ev.batchId);
      if (!ev.servedModel) return;
      for (const seg of segs) {
        seg.model = ev.servedModel;
        seg.fallback = ev.fallback;
        setProvenance(seg);
      }
      return;
    }
    if (ev.type === "segment") {
      const seg = byId.get(ev.id);
      if (!seg) return;
      seg.status = "done";
      seg.translation = ev.text;
      seg.source = ev.source;
      seg.model = ev.model;
      seg.fallback = false;
      if (ev.source === "api") {
        const list = awaitingModel.get(ev.batchId);
        if (list) list.push(seg);
        else awaitingModel.set(ev.batchId, [seg]);
      }
      if (isSameText(ev.text, seg.candidate.text)) {
        // e.g. "Kubelet" -> "Kubelet": showing it would just duplicate the heading.
        seg.hidden = true;
        seg.node?.remove();
        return;
      }
      render(seg);
    } else if (ev.type === "segment-error") {
      for (const id of ev.ids) {
        const seg = byId.get(id);
        if (!seg) continue;
        seg.status = "error";
        render(seg);
        seg.node?.setAttribute("title", `翻譯失敗：${ev.message}（點一下看說明）`);
        seg.node?.setAttribute("data-llmt-error", ev.message);
      }
      // Every remaining segment will fail the same way, so say it once per
      // page instead of relying on a tooltip on each ⚠.
      if (ev.scope === "page" && !shownPageErrors.has(ev.message)) {
        shownPageErrors.add(ev.message);
        showErrorToast(ev.message, ev.settings, false);
      }
    }
  }

  const shownPageErrors = new Set<string>();

  function showErrorToast(message: string, settings: boolean, autoHide: boolean): void {
    showToast({
      message: `翻譯失敗：${message}`,
      detail: "修正後，關閉再開啟翻譯即可重試失敗的段落。",
      action: settings
        ? { label: "開啟設定", onClick: () => void chrome.runtime.sendMessage({ type: "llmt-open-options" }) }
        : undefined,
      autoHideMs: autoHide ? 8000 : undefined,
    });
  }

  // ⚠ markers are often inside links; a click shows the reason instead of navigating.
  document.addEventListener(
    "click",
    (e) => {
      const marker = (e.target as Element | null)?.closest?.("llmt-translation.llmt-error");
      if (!marker) return;
      e.preventDefault();
      e.stopPropagation();
      showErrorToast(marker.getAttribute("data-llmt-error") ?? "未知錯誤", false, true);
    },
    true,
  );

  // --- activation ---------------------------------------------------------------

  /** Language of the segments currently registered (null before the first activation). */
  let translatedLang: string | null = null;

  function activate(lang: string): void {
    active = true;
    document.documentElement.classList.remove("llmt-hidden");
    if (translatedLang !== null && lang !== translatedLang) {
      // Language changed while translation was off: existing translations are stale.
      retranslateAll(lang);
      mo.observe(document.body, { childList: true, subtree: true, characterData: true });
      return;
    }
    targetLang = translatedLang = lang;
    // Re-observe targets that may have scrolled into view while inactive;
    // observe() always delivers an initial entry.
    for (const target of byObserved.keys()) {
      io.unobserve(target);
      io.observe(target);
    }
    // Retry failures (e.g. the user just fixed the API key).
    shownPageErrors.clear();
    hideToast();
    for (const seg of byId.values()) {
      if (seg.status !== "error") continue;
      seg.status = "idle";
      seg.retries = 0;
      observe(seg);
    }
    scan(document.body);
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function deactivate(): void {
    active = false;
    document.documentElement.classList.add("llmt-hidden");
    mo.disconnect();
    // Segments still waiting for the viewport stay registered; re-activation
    // rescans and IntersectionObserver keeps working on them.
  }

  /** Drop every translation and start over in `lang` (popup language change). */
  function retranslateAll(lang: string): void {
    targetLang = translatedLang = lang;
    churn = new WeakMap();
    for (const seg of byId.values()) seg.node?.remove();
    for (const target of byObserved.keys()) io.unobserve(target);
    byId.clear();
    byObserved.clear();
    byAnchor = new WeakMap();
    queue.length = 0;
    awaitingModel.clear();
    // Replies to batches already in flight carry ids no longer in byId and are ignored.
    shownPageErrors.clear();
    hideToast();
    scan(document.body);
  }

  // Whoever injected us sends the first toggle right after injection.
  chrome.runtime.onMessage.addListener((msg: ContentMessage, _sender, sendResponse) => {
    switch (msg?.type) {
      case "llmt-toggle":
        if (active) deactivate();
        else activate(msg.targetLang);
        break;
      case "llmt-set-lang":
        // While off, the change is applied by the next activation (which compares
        // against translatedLang and re-translates).
        if (active && msg.targetLang !== translatedLang) retranslateAll(msg.targetLang);
        break;
      case "llmt-status":
        break;
      default:
        return false;
    }
    sendResponse({ active } satisfies TabState);
    return false;
  });
}

function isOurs(el: Element): boolean {
  return el.tagName.toUpperCase() === TRANSLATION_TAG || el.closest(TRANSLATION_TAG.toLowerCase()) !== null;
}

const INLINE_DISPLAY = /^inline/;

function blockAncestor(el: Element): Element {
  let cur: Element | null = el;
  while (cur && cur !== document.body && INLINE_DISPLAY.test(getComputedStyle(cur).display)) cur = cur.parentElement;
  return cur ?? document.body;
}
