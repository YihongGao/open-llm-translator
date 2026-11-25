// Finds translatable text on the page.
//
// A "segment" is a maximal run of inline content (text nodes + inline
// elements) inside one block-level parent. A block with a nested list, e.g.
// <li>Concepts<ul>…</ul></li>, yields the run "Concepts" and then recurses
// into the <ul>. Each segment is identified by its *anchor* — the last node
// of the run — which stays stable across rescans because our own inserted
// nodes are ignored when runs are computed.

export const TRANSLATION_TAG = "LLMT-TRANSLATION";

/** Excluded entirely: neither a segment nor part of a parent's text. */
const EXCLUDED_TAGS = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "INPUT", "SELECT", "OPTION",
  "SVG", "MATH", "CANVAS", "IFRAME", "VIDEO", "AUDIO", "OBJECT", "EMBED", "HEAD",
  "BUTTON", TRANSLATION_TAG,
]);

/** Never a segment and never descended into, e.g. code blocks. */
const OPAQUE_BLOCK_TAGS = new Set(["PRE"]);

/** Inline by default; part of the surrounding sentence. */
const INLINE_TAGS = new Set([
  "A", "ABBR", "B", "BDI", "BDO", "BR", "CITE", "CODE", "DATA", "DEL", "DFN", "EM", "FONT",
  "I", "IMG", "INS", "KBD", "LABEL", "MARK", "Q", "S", "SAMP", "SMALL", "SPAN", "STRONG",
  "SUB", "SUP", "TIME", "U", "VAR", "WBR",
]);

const BLOCK_SELECTOR =
  "address,article,aside,blockquote,dd,details,div,dl,dt,fieldset,figcaption,figure,footer,form,h1,h2,h3,h4,h5,h6,header,hr,li,main,nav,ol,p,pre,section,summary,table,tbody,td,th,thead,tr,ul";

export interface SegmentCandidate {
  /** Block element that contains the run. */
  container: Element;
  /** Nodes forming the run, in document order. */
  nodes: Node[];
  /** Last node of the run; identity key for the segment. */
  anchor: Node;
  text: string;
}

export interface CollectOptions {
  targetLang: string;
  /** Injected for tests; defaults to getComputedStyle. */
  displayOf?: (el: Element) => string;
}

export function collectSegments(root: Element, opts: CollectOptions): SegmentCandidate[] {
  const displayOf = opts.displayOf ?? ((el: Element) => getComputedStyle(el).display);
  const out: SegmentCandidate[] = [];

  const isSkipped = (el: Element): boolean =>
    EXCLUDED_TAGS.has(el.tagName.toUpperCase()) ||
    el.getAttribute("translate") === "no" ||
    el.classList.contains("notranslate") ||
    el.getAttribute("aria-hidden") === "true" ||
    (el as HTMLElement).hidden === true ||
    (el as HTMLElement).isContentEditable === true ||
    el.getAttribute("contenteditable") === "true";

  // An inline-tagged element counts as inline unless CSS makes it a box
  // (e.g. nav links styled display:block) or it wraps block content (card links).
  const isInline = (el: Element): boolean => {
    if (!INLINE_TAGS.has(el.tagName.toUpperCase())) return false;
    const d = displayOf(el);
    if (d && !d.startsWith("inline") && d !== "contents") return false;
    return el.querySelector(BLOCK_SELECTOR) === null;
  };

  const flush = (container: Element, run: Node[]) => {
    if (run.length === 0) return;
    const text = normalizeText(run.map(textOf).join(""));
    if (isTranslatable(text, opts.targetLang)) {
      out.push({ container, nodes: run, anchor: run[run.length - 1]!, text });
    }
  };

  const textOf = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node as Element;
    if (isSkipped(el)) return "";
    if (el.tagName.toUpperCase() === "BR") return " ";
    let s = "";
    for (const child of el.childNodes) s += textOf(child);
    return s;
  };

  const walk = (el: Element) => {
    if (isSkipped(el) || OPAQUE_BLOCK_TAGS.has(el.tagName.toUpperCase())) return;
    let run: Node[] = [];
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        run.push(child);
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const c = child as Element;
        if (isSkipped(c)) continue;
        if (isInline(c)) {
          run.push(c);
        } else {
          flush(el, run);
          run = [];
          walk(c);
        }
      }
    }
    flush(el, run);
  };

  walk(root);
  return out;
}

export function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

const LETTER = /\p{L}/u;

export function isTranslatable(text: string, targetLang: string): boolean {
  if (text.length < 2 || !LETTER.test(text)) return false;
  return !looksLikeTarget(text, targetLang);
}

/** Cheap script-based check so already-translated text isn't sent again. */
export function looksLikeTarget(text: string, targetLang: string): boolean {
  const letters = [...text].filter((ch) => LETTER.test(ch));
  if (letters.length === 0) return true;
  const ratio = (re: RegExp) => letters.filter((ch) => re.test(ch)).length / letters.length;
  const lang = targetLang.toLowerCase();
  if (lang.startsWith("zh")) return ratio(/\p{Script=Han}/u) > 0.5 && ratio(/[\p{Script=Hiragana}\p{Script=Katakana}]/u) < 0.1;
  if (lang.startsWith("ja")) return ratio(/[\p{Script=Hiragana}\p{Script=Katakana}]/u) > 0.2;
  if (lang.startsWith("ko")) return ratio(/\p{Script=Hangul}/u) > 0.5;
  if (lang.startsWith("en")) return ratio(/[A-Za-z]/) > 0.9;
  return false;
}

export type Layout = "inline" | "block";

/**
 * Short labels (nav items, headings, buttons) get the translation on the same
 * line; sentences and paragraphs get it on the line below.
 */
export function chooseLayout(text: string): Layout {
  const cjk = (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) ?? []).length;
  if (cjk > text.length / 2) return text.length <= 16 ? "inline" : "block";
  const words = text.split(" ").length;
  return words <= 5 && text.length <= 48 && !/[.!?:;]\s/.test(text) ? "inline" : "block";
}

/**
 * Where to put the translation node. If the run is a single inline element
 * (typically one <a>), the translation goes *inside* it so it keeps the link
 * colour and stays clickable, as in the reference screenshot.
 */
export function insertionPoint(seg: SegmentCandidate): { parent: Node; before: Node | null } {
  const meaningful = seg.nodes.filter((n) => n.nodeType === Node.ELEMENT_NODE || (n.textContent ?? "").trim() !== "");
  const only = meaningful.length === 1 ? meaningful[0] : undefined;
  if (only && only.nodeType === Node.ELEMENT_NODE) {
    const tag = (only as Element).tagName.toUpperCase();
    if (tag !== "IMG" && tag !== "BR") return { parent: only, before: null };
  }
  return { parent: seg.anchor.parentNode ?? seg.container, before: seg.anchor.nextSibling };
}
