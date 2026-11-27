// Finds translatable text on the page.
//
// A "segment" is a maximal run of inline content (text nodes + inline
// elements) inside one block-level parent. A block with a nested list, e.g.
// <li>Concepts<ul>…</ul></li>, yields the run "Concepts" and then recurses
// into the <ul>. Two <br>s in a row also end a run (paragraphs written
// without <p>, as on many forums). Each segment is identified by its *anchor* — the last node
// of the run — which stays stable across rescans because our own inserted
// nodes are ignored when runs are computed.

import { normalizeText } from "../shared/text";

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

const isBr = (n: Node) => n.nodeType === Node.ELEMENT_NODE && (n as Element).tagName.toUpperCase() === "BR";
const isBlank = (n: Node) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() === "";

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

/** Elements whose subtree is never translated (and never part of a parent's text). */
/**
 * Video players: their caption windows change every few seconds, so each line
 * would be sent as a new segment (subtitles have their own feature). Covers
 * YouTube's player, which also holds our subtitle overlay.
 */
const PLAYER_CLASS = "html5-video-player";

export function isSkipped(el: Element): boolean {
  return (
    EXCLUDED_TAGS.has(el.tagName.toUpperCase()) ||
    el.classList.contains(PLAYER_CLASS) ||
    el.getAttribute("translate") === "no" ||
    el.classList.contains("notranslate") ||
    el.getAttribute("aria-hidden") === "true" ||
    (el as HTMLElement).hidden === true ||
    (el as HTMLElement).isContentEditable === true ||
    el.getAttribute("contenteditable") === "true"
  );
}

/**
 * True when an ancestor of `el` excludes it from translation. collectSegments()
 * only checks the root and its descendants, so a rescan rooted inside an
 * excluded region (content added to a code viewer, a button, translate="no")
 * must be rejected up front.
 */
export function isExcludedByAncestor(el: Element): boolean {
  for (let cur = el.parentElement; cur && cur !== document.body; cur = cur.parentElement) {
    if (isSkipped(cur) || OPAQUE_BLOCK_TAGS.has(cur.tagName.toUpperCase())) return true;
  }
  return false;
}

/** The computed-style properties the visibility checks read. */
export type StyleLike = Pick<
  CSSStyleDeclaration,
  "display" | "visibility" | "opacity" | "fontSize" | "color" | "clip" | "clipPath" | "overflow" | "overflowX" | "overflowY"
> & {
  backgroundClip?: string;
  webkitBackgroundClip?: string;
  backgroundImage?: string;
  webkitTextFillColor?: string;
  webkitTextStrokeWidth?: string;
};

const ZERO_CLIP = /^rect\(\s*0(px)?\s*,?\s*0(px)?\s*,?\s*0(px)?\s*,?\s*0(px)?\s*\)$/;
const ZERO_CLIP_PATH = /^(inset\(\s*(50|100)%\s*\)|circle\(\s*0(px|%)?\s*.*\))$/;
const CLIPPING_OVERFLOW = /^(hidden|clip)$/;

/** Alpha of a computed colour; "transparent" and rgba(…, 0) are 0, unparsable colours count as opaque. */
export function colorAlpha(color: string): number {
  const c = color.trim();
  if (c === "transparent") return 0;
  const m = /^rgba?\(([^)]*)\)$/.exec(c);
  if (!m) return 1;
  const parts = m[1]!.split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 4) return 1;
  const a = parts[3]!;
  return a.endsWith("%") ? Number.parseFloat(a) / 100 : Number.parseFloat(a);
}

/** The colour glyphs are filled with: -webkit-text-fill-color wins over color. */
const fillAlpha = (s: StyleLike) => colorAlpha(s.webkitTextFillColor || s.color);

/**
 * Hides the element's whole box, whatever its children do: display none,
 * near-zero opacity, zero clipping, or a box clipped to at most 1px in either
 * direction (sr-only, height:0 + overflow:hidden). `rect` is only read when the
 * overflow is clipping, since it forces layout.
 */
export function boxHidden(s: StyleLike, rect: () => { width: number; height: number }, withVisibility = true): boolean {
  if (s.display === "none") return true;
  if (withVisibility && (s.visibility === "hidden" || s.visibility === "collapse")) return true;
  if (s.opacity !== "" && Number.parseFloat(s.opacity) < 0.05) return true;
  if (ZERO_CLIP.test(s.clip.trim()) || ZERO_CLIP_PATH.test(s.clipPath.trim())) return true;
  // overflow does not apply to inline boxes, and display:contents has no box.
  if (s.display === "inline" || s.display === "contents") return false;
  if (![s.overflow, s.overflowX, s.overflowY].some((o) => CLIPPING_OVERFLOW.test(o ?? ""))) return false;
  // Border box, so the aspect-ratio trick (height:0 + padding-bottom) still counts as visible.
  const r = rect();
  return r.width <= 1 || r.height <= 1;
}

/**
 * Glyphs painted by something other than the fill colour: gradient text
 * (background-clip:text with a background image, on the element or an
 * ancestor) or outlined text (-webkit-text-stroke).
 */
function textPaintedOtherwise(el: Element, s: StyleLike): boolean {
  if (Number.parseFloat(s.webkitTextStrokeWidth ?? "") > 0) return true;
  for (let cur: Element | null = el; cur && cur !== document.documentElement; cur = cur.parentElement) {
    const cs: StyleLike = cur === el ? s : getComputedStyle(cur);
    const clip = cs.backgroundClip === "text" || cs.webkitBackgroundClip === "text";
    if (clip && cs.backgroundImage && cs.backgroundImage !== "none") return true;
  }
  return false;
}

/** The element's own text cannot be read: sub-2px font, or transparent glyphs nothing else paints. */
export function textInvisible(el: Element, s: StyleLike = getComputedStyle(el)): boolean {
  if (s.fontSize !== "" && Number.parseFloat(s.fontSize) < 2) return true;
  return fillAlpha(s) < 0.1 && !textPaintedOtherwise(el, s);
}

const rectOf = (el: Element) => () => el.getBoundingClientRect();

/**
 * The element hides itself, as opposed to inheriting its parent's state:
 * visibility, font size and colour are inherited, so they only count when they
 * differ from the parent's (otherwise every <a> in a paragraph that is still
 * fading in would be dropped). Used to drop hidden pieces from a visible run.
 */
export function isSelfHidden(el: Element): boolean {
  const s = getComputedStyle(el);
  if (boxHidden(s, rectOf(el), false)) return true;
  const parent = el.parentElement;
  const ps = parent ? getComputedStyle(parent) : undefined;
  const invisible = (v: string | undefined) => v === "hidden" || v === "collapse";
  if (invisible(s.visibility) && !invisible(ps?.visibility)) return true;
  if (s.fontSize !== "" && Number.parseFloat(s.fontSize) < 2 && !(ps && Number.parseFloat(ps.fontSize) < 2)) return true;
  if (fillAlpha(s) < 0.1 && !(ps && fillAlpha(ps) < 0.1) && !textPaintedOtherwise(el, s)) return true;
  return false;
}

/**
 * Whether a segment is hidden from the reader at the moment it would be sent.
 * The container's box and its ancestors' boxes must be visible, and at least
 * one element carrying the run's text must have readable glyphs. Colour and
 * font size are judged on those text-bearing elements, not on the container
 * (a font-size:0 wrapper around sized links, a gradient wrapper around <p>).
 */
export function isHiddenForReader(seg: Pick<SegmentCandidate, "container" | "nodes">): boolean {
  const { container } = seg;
  const cs = getComputedStyle(container);
  if (boxHidden(cs, rectOf(container))) return true;
  for (let cur = container.parentElement; cur && cur !== document.body; cur = cur.parentElement) {
    // Visibility is inherited and can be overridden below, so the container's
    // computed visibility already answers it.
    if (boxHidden(getComputedStyle(cur), rectOf(cur), false)) return true;
  }
  let readable = false;
  for (const n of seg.nodes) {
    if (n.nodeType === Node.TEXT_NODE) {
      if ((n.textContent ?? "").trim() !== "" && !textInvisible(container, cs)) readable = true;
    } else if (n.nodeType === Node.ELEMENT_NODE) {
      const el = n as Element;
      if ((el.textContent ?? "").trim() === "") continue;
      const s = getComputedStyle(el);
      if (!boxHidden(s, rectOf(el)) && !textInvisible(el, s)) readable = true;
    }
    if (readable) return false;
  }
  return true;
}

export interface CollectOptions {
  targetLang: string;
  /** Injected for tests; defaults to getComputedStyle. */
  displayOf?: (el: Element) => string;
  /** Injected for tests; defaults to isSelfHidden. */
  hiddenOf?: (el: Element) => boolean;
  /** Filled in by the scan: how many runs were skipped only because they already look like `targetLang`. */
  stats?: { alreadyTarget: number };
}

export function collectSegments(root: Element, opts: CollectOptions): SegmentCandidate[] {
  const displayOf = opts.displayOf ?? ((el: Element) => getComputedStyle(el).display);
  const hiddenOf = opts.hiddenOf ?? isSelfHidden;
  const out: SegmentCandidate[] = [];

  // Text an element hides inside an otherwise visible run (an opacity:0 or
  // display:none span in a paragraph, any element type) is dropped from the
  // run, so it is never sent. Hidden *blocks* — including inline tags styled
  // as boxes, such as card links — are left to the content script's send-time
  // check, because pages often fade blocks in or reveal collapsed sections later.

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
    } else if (opts.stats && isWorthTranslating(text) && looksLikeTarget(text, opts.targetLang)) {
      opts.stats.alreadyTarget++;
    }
  };

  const textOf = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node as Element;
    if (isSkipped(el) || hiddenOf(el)) return "";
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
        // display:none is not inherited, so it is always the element's own choice;
        // an inline-tagged one is dropped without splitting the sentence around it.
        if (INLINE_TAGS.has(c.tagName.toUpperCase()) && displayOf(c) === "none") continue;
        // <br><br> is a paragraph break on pages without <p> (forum posts). The
        // run keeps the first <br> as its anchor, so the translation lands
        // between the two breaks and the paragraph gap stays the same.
        let last = run.length - 1;
        while (last >= 0 && isBlank(run[last]!)) last--;
        if (isBr(c) && last >= 0 && isBr(run[last]!)) {
          flush(el, run.slice(0, last + 1));
          run = [];
          continue;
        }
        if (isInline(c)) {
          if (!hiddenOf(c)) run.push(c);
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

// Invisible characters are stripped here so hidden instructions never reach the model.
export { normalizeText };

const LETTER = /\p{L}/u;

export function isTranslatable(text: string, targetLang: string): boolean {
  return isWorthTranslating(text) && !looksLikeTarget(text, targetLang);
}

/** Real text, not a stray character, number or code-like token. */
function isWorthTranslating(text: string): boolean {
  return text.length >= 2 && LETTER.test(text) && !looksLikeIdentifier(text);
}

/**
 * Single ASCII tokens that read as code or a name rather than a word:
 * camelCase (cAdvisor), digits (v1.31, k8s), or code punctuation
 * (kube-proxy, kubectl.exe, --flag). Plain words such as "Documentation"
 * or "kubelet" are not caught here; the model returns those unchanged and
 * isSameText() hides the duplicate.
 */
export function looksLikeIdentifier(text: string): boolean {
  if (!/^[\x21-\x7e]+$/.test(text)) return false;
  return /[a-z][A-Z]/.test(text) || /\d/.test(text) || /[-_./:@#=<>{}()[\]\\|~$%^&*+]/.test(text);
}

/** True when a "translation" is just the source text again (case/whitespace-insensitive). */
export function isSameText(a: string, b: string): boolean {
  return normalizeText(a).toLowerCase() === normalizeText(b).toLowerCase();
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
