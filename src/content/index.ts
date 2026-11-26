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
  isHiddenForReader,
  isSameText,
  isSkipped,
  type Layout,
  type SegmentCandidate,
} from "./segmenter";
import { hideToast, showToast } from "./toast";
import { isYouTubeUrl } from "../shared/youtube-bridge";
import { createSubtitleController } from "./youtube/controller";
import { OVERLAY_CLASS } from "./youtube/overlay";

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
 * A container whose text changes after being translated more often than this
 * is treated as volatile (clock, counter, ticker) and left untranslated: each
 * change would otherwise cost an API call and a cache entry. Reset on every
 * activation, so toggling translation off and on recovers it.
 */
const MAX_RETRANSLATIONS = 3;

/** How often segments that are in the viewport but invisible are checked again. */
const HIDDEN_RECHECK_MS = 1000;

/** Longest page title sent with each batch (code points). */
const MAX_TITLE_CHARS = 200;

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
      // Decide for every entry first, then render: interleaving style reads
      // with node insertion would force a layout per segment.
      const visible: SegState[] = [];
      for (const entry of entries) {
        // While toggled off, keep observing so segments are picked up on re-activation.
        if (!entry.isIntersecting || !active) continue;
        const segs = byObserved.get(entry.target) ?? [];
        byObserved.delete(entry.target);
        io.unobserve(entry.target);
        for (const seg of segs) {
          if (seg.status !== "idle") continue;
          if (isHiddenForReader(seg.candidate)) watchHidden(seg);
          else visible.push(seg);
        }
      }
      for (const seg of visible) enqueue(seg);
    },
    { rootMargin: VIEWPORT_MARGIN },
  );

  /** Run's first element (text nodes cannot be observed), else the container. */
  const targetOf = (seg: SegState): Element =>
    seg.candidate.nodes.find((n): n is Element => n.nodeType === Node.ELEMENT_NODE) ?? seg.candidate.container;

  function observe(seg: SegState): void {
    const target = targetOf(seg);
    const list = byObserved.get(target);
    if (list) list.push(seg);
    else {
      byObserved.set(target, [seg]);
      io.observe(target);
    }
  }

  // --- hidden segments ----------------------------------------------------------
  //
  // A segment near the viewport but invisible (opacity 0, visibility hidden,
  // clipped...) is not sent: hidden text is the usual carrier for prompt
  // injection. Pages also reveal content later (scroll-reveal animations once
  // the block is well inside the viewport, dropdowns, accordions), so hidden
  // segments are re-checked for as long as they are actually in the viewport,
  // which keeps the cost proportional to what is on screen.

  /** Hidden segments by observed element. */
  const hiddenByTarget = new Map<Element, Set<SegState>>();
  /** Hidden segments whose element is inside the actual viewport. */
  const hiddenInView = new Set<SegState>();
  let hiddenTimer: number | undefined;

  const viewportIo = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      for (const seg of hiddenByTarget.get(entry.target) ?? []) {
        if (entry.isIntersecting) hiddenInView.add(seg);
        else hiddenInView.delete(seg);
      }
    }
    recheckHidden();
  });

  function watchHidden(seg: SegState): void {
    const target = targetOf(seg);
    const set = hiddenByTarget.get(target);
    if (set) set.add(seg);
    else {
      hiddenByTarget.set(target, new Set([seg]));
      viewportIo.observe(target);
    }
  }

  function unwatchHidden(seg: SegState): void {
    hiddenInView.delete(seg);
    for (const [target, set] of hiddenByTarget) {
      if (!set.delete(seg)) continue;
      if (set.size === 0) {
        hiddenByTarget.delete(target);
        viewportIo.unobserve(target);
      }
      break;
    }
  }

  /** Sends hidden segments that became visible; keeps a timer running while any remain on screen. */
  function recheckHidden(): void {
    if (!active) return;
    const revealed = [...hiddenInView].filter((seg) => seg.status === "idle" && !isHiddenForReader(seg.candidate));
    for (const seg of revealed) {
      unwatchHidden(seg);
      enqueue(seg);
    }
    if (hiddenInView.size > 0 && hiddenTimer === undefined)
      hiddenTimer = window.setTimeout(() => {
        hiddenTimer = undefined;
        recheckHidden();
      }, HIDDEN_RECHECK_MS);
  }

  function stopHiddenTimer(): void {
    window.clearTimeout(hiddenTimer);
    hiddenTimer = undefined;
  }

  // --- scanning ---------------------------------------------------------------

  /** Remove a segment for good: its node, its registrations, and any future send. */
  function retire(seg: SegState): void {
    seg.status = "retired";
    seg.node?.remove();
    byId.delete(seg.id);
    unobserve(seg);
  }

  /** Drops the segment's viewport registrations (both the normal and the hidden one). */
  function unobserve(seg: SegState): void {
    unwatchHidden(seg);
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

  /** Changed-after-translation counts per container, for MAX_RETRANSLATIONS. */
  let churn = new WeakMap<Element, number>();

  /**
   * Reconcile segments under `root` with the DOM: keep segments whose anchor
   * and text are unchanged, carry a segment over to a rebuilt run with the
   * same text (framework re-render), retire every other segment under `root`
   * (text changed in place, run extended), and register new ones.
   */
  function scan(root: Element): void {
    const candidates = collectSegments(root, { targetLang });
    const kept = new Set<SegState>();
    const unmatched = new Set<SegmentCandidate>();
    for (const c of candidates) {
      const existing = byAnchor.get(c.anchor);
      if (existing && existing.status !== "retired" && existing.candidate.text === c.text) kept.add(existing);
      else unmatched.add(c);
    }
    for (const seg of [...byId.values()]) {
      if (kept.has(seg) || !root.contains(seg.candidate.container)) continue;
      // Same text rebuilt with new nodes in the same container: keep the
      // segment (and its translation) instead of translating it again.
      const same = [...unmatched].find((c) => c.container === seg.candidate.container && c.text === seg.candidate.text);
      if (same) {
        unmatched.delete(same);
        adopt(seg, same);
        kept.add(seg);
        continue;
      }
      // Only text that changed after being sent costs anything; idle segments
      // (streamed text, off-screen updates) are free to change.
      const sent = seg.status === "pending" || seg.status === "done" || seg.status === "error";
      retire(seg);
      if (sent) churn.set(seg.candidate.container, (churn.get(seg.candidate.container) ?? 0) + 1);
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

  /** Moves a segment onto a rebuilt run with identical text. */
  function adopt(seg: SegState, candidate: SegmentCandidate): void {
    const wasObserved = seg.status === "idle";
    if (wasObserved) unobserve(seg);
    seg.candidate = candidate;
    byAnchor.set(candidate.anchor, seg);
    if (wasObserved) observe(seg);
    else if (seg.node && !seg.hidden) mountNode(seg);
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
        // Long titles are cut: only the start is visible in a tab, so the rest
        // is effectively hidden text, and it is resent with every batch.
        page: { title: [...document.title].slice(0, MAX_TITLE_CHARS).join(""), url: location.href },
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
    // Volatile-text counts start over, so toggling recovers a blocked container.
    churn = new WeakMap();
    recheckHidden();
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
    stopHiddenTimer();
    // Segments still waiting for the viewport stay registered; re-activation
    // rescans and IntersectionObserver keeps working on them.
  }

  /** Drop every translation and start over in `lang` (popup language change). */
  function retranslateAll(lang: string): void {
    targetLang = translatedLang = lang;
    churn = new WeakMap();
    for (const seg of byId.values()) seg.node?.remove();
    for (const target of byObserved.keys()) io.unobserve(target);
    for (const target of hiddenByTarget.keys()) viewportIo.unobserve(target);
    byId.clear();
    byObserved.clear();
    hiddenByTarget.clear();
    hiddenInView.clear();
    stopHiddenTimer();
    byAnchor = new WeakMap();
    queue.length = 0;
    awaitingModel.clear();
    // Replies to batches already in flight carry ids no longer in byId and are ignored.
    shownPageErrors.clear();
    hideToast();
    scan(document.body);
  }

  // Bilingual subtitles, independent of page translation (on YouTube one may
  // want only the comments translated, or only the video).
  const subtitles = isYouTubeUrl(location.href) ? createSubtitleController() : null;

  // Whoever injected us sends the first toggle right after injection.
  chrome.runtime.onMessage.addListener((msg: ContentMessage, _sender, sendResponse) => {
    switch (msg?.type) {
      case "llmt-toggle":
        if (msg.feature === "subtitles") {
          if (!subtitles) break;
          if (subtitles.isActive()) subtitles.disable();
          else subtitles.enable(msg.targetLang);
        } else if (active) deactivate();
        else activate(msg.targetLang);
        break;
      case "llmt-set-lang":
        // While off, the change is applied by the next activation (which compares
        // against translatedLang and re-translates).
        if (active && msg.targetLang !== translatedLang) retranslateAll(msg.targetLang);
        subtitles?.setLanguage(msg.targetLang);
        break;
      case "llmt-status":
        break;
      default:
        return false;
    }
    sendResponse({ active, subtitles: subtitles ? subtitles.isActive() : null } satisfies TabState);
    return false;
  });
}

function isOurs(el: Element): boolean {
  return (
    el.tagName.toUpperCase() === TRANSLATION_TAG ||
    el.closest(`${TRANSLATION_TAG.toLowerCase()}, .${OVERLAY_CLASS}`) !== null
  );
}

const INLINE_DISPLAY = /^inline/;

function blockAncestor(el: Element): Element {
  let cur: Element | null = el;
  while (cur && cur !== document.body && INLINE_DISPLAY.test(getComputedStyle(cur).display)) cur = cur.parentElement;
  return cur ?? document.body;
}
