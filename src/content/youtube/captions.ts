// Caption processing, free of DOM and chrome.* so it can be unit-tested:
// json3 -> cues -> sentences, and choosing which track to translate.

import { normalizeText } from "../../shared/text";
import type { TrackInfo } from "../../shared/youtube-bridge";

/** One timed caption line, times in ms. */
export interface Cue {
  start: number;
  end: number;
  text: string;
}

/** Sound and speaker markers ("[Music]", "[Applause]", ">>"), as Immersive Translate filters them. */
const AMBIENT = /\s*\[[^\]]*\]\s*|\s*>>\s*/g;

/** Hard caps against hostile or broken responses. */
const MAX_CUES = 20_000;
const MAX_CUE_CHARS = 1_000;

interface Json3Event {
  tStartMs?: unknown;
  dDurationMs?: unknown;
  segs?: Array<{ utf8?: unknown }>;
}

/**
 * Parses YouTube's json3 caption format. Each event with `segs` is one cue;
 * its text is the concatenation of the segments (automatic captions split it
 * into words). Events without text (window setup, the "\n" append events of
 * automatic captions) are dropped. Automatic captions keep a cue on screen
 * while the next one starts, so a cue's end is clipped to the next start.
 */
export function parseJson3(body: string): Cue[] {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return [];
  }
  const events = (data as { events?: unknown })?.events;
  if (!Array.isArray(events)) return [];
  const cues: Cue[] = [];
  for (const raw of events as Json3Event[]) {
    if (cues.length >= MAX_CUES) break;
    if (!raw || !Array.isArray(raw.segs)) continue;
    const start = typeof raw.tStartMs === "number" ? raw.tStartMs : NaN;
    const duration = typeof raw.dDurationMs === "number" ? raw.dDurationMs : 0;
    if (!Number.isFinite(start) || start < 0) continue;
    const joined = raw.segs.map((s) => (typeof s?.utf8 === "string" ? s.utf8 : "")).join("");
    const text = [...normalizeText(joined.replace(AMBIENT, " "))].slice(0, MAX_CUE_CHARS).join("");
    if (!text) continue;
    cues.push({ start, end: start + Math.max(0, duration), text });
  }
  cues.sort((a, b) => a.start - b.start);
  for (let i = 0; i + 1 < cues.length; i++) {
    const next = cues[i + 1]!;
    if (next.start > cues[i]!.start && cues[i]!.end > next.start) cues[i]!.end = next.start;
  }
  return cues;
}

/** A unit of translation and display: one or more cues forming a sentence. */
export interface Sentence {
  start: number;
  end: number;
  text: string;
}

export interface MergeOptions {
  /** A pause longer than this ends the sentence (ms). */
  maxGapMs: number;
  /** Longest sentence on screen (ms). */
  maxDurationMs: number;
  /** Longest sentence, counting CJK characters double (they are about twice as wide). */
  maxWeight: number;
}

export const DEFAULT_MERGE: MergeOptions = { maxGapMs: 1500, maxDurationMs: 12_000, maxWeight: 200 };

/** Sentence-final punctuation, optionally followed by closing quotes or brackets. */
const TERMINAL = /[.!?。！？…‼⁇⁈⁉][\s"'”’)\]」』）]*$/u;
const CJK = /[぀-ヿ㐀-鿿豈-﫿가-힯＀-￯]/u;

function weight(s: string): number {
  let w = 0;
  for (const ch of s) w += CJK.test(ch) ? 2 : 1;
  return w;
}

function join(a: string, b: string): string {
  const last = [...a].at(-1) ?? "";
  const first = [...b][0] ?? "";
  return CJK.test(last) || CJK.test(first) ? a + b : `${a} ${b}`;
}

/**
 * Merges cues into sentences, so the model translates whole sentences rather
 * than fragments (automatic captions break lines mid-sentence, and word order
 * differs between languages, so a translation cannot be split back over the
 * original lines). A sentence ends at final punctuation, at a pause, or when
 * it gets too long to read on screen.
 */
export function mergeSentences(cues: readonly Cue[], opts: MergeOptions = DEFAULT_MERGE): Sentence[] {
  const out: Sentence[] = [];
  let cur: Sentence | null = null;
  for (const cue of cues) {
    if (cur && cue.start - cur.end > opts.maxGapMs) {
      out.push(cur);
      cur = null;
    }
    // Starting a cue would make the sentence too long: close it first.
    if (cur && (weight(join(cur.text, cue.text)) > opts.maxWeight || cue.end - cur.start > opts.maxDurationMs)) {
      out.push(cur);
      cur = null;
    }
    cur = cur ? { start: cur.start, end: Math.max(cur.end, cue.end), text: join(cur.text, cue.text) } : { ...cue };
    if (TERMINAL.test(cur.text)) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Compares language tags the way a reader would: Chinese by script (zh-TW and
 * zh-Hant are the same, zh-TW and zh-CN are not), other languages by their
 * primary subtag (en-GB matches en).
 */
export function sameLanguage(a: string, b: string): boolean {
  return languageKey(a) === languageKey(b);
}

function languageKey(tag: string): string {
  const t = tag.toLowerCase().replace(/_/g, "-");
  if (t === "zh" || t.startsWith("zh-")) {
    return /^zh-(tw|hk|mo|hant)\b/.test(t) ? "zh-hant" : "zh-hans";
  }
  return t.split("-")[0] ?? t;
}

/**
 * The track whose language the video is spoken in, when it can be told
 * reliably: an uploaded (manual) track in the same language as the automatic
 * one. The automatic track alone is not enough: YouTube sometimes generates it
 * in the wrong language (a Chinese talk with only "en (auto-generated)").
 */
export function originalTrack(tracks: readonly TrackInfo[]): TrackInfo | null {
  const asr = tracks.find((t) => t.kind === "asr");
  if (!asr) return null;
  return tracks.find((t) => t.kind !== "asr" && sameLanguage(t.lang, asr.lang)) ?? null;
}

/** URL to download `track` as json3, reusing the player's session parameters (the `pot` token among them). */
export function trackUrl(track: TrackInfo, playerUrl: string, base: string): string {
  const url = new URL(track.baseUrl, base);
  const from = new URL(playerUrl, base).searchParams;
  for (const key of ["pot", "potc", "c", "cver"]) {
    const v = from.get(key);
    if (v !== null) url.searchParams.set(key, v);
  }
  url.searchParams.delete("tlang");
  url.searchParams.set("fmt", "json3");
  return url.href;
}

/** The same request without YouTube's machine translation (`tlang`): the original-language track. */
export function withoutTranslation(playerUrl: string, base: string): string | null {
  const url = new URL(playerUrl, base);
  if (!url.searchParams.has("tlang")) return null;
  url.searchParams.delete("tlang");
  return url.href;
}

export type SourceDecision =
  /** Translate what the player downloaded. */
  | { kind: "use" }
  /** Download this URL instead and translate it. */
  | { kind: "fetch"; url: string }
  /** Nothing to translate: the captions are already in the target language. */
  | { kind: "already-target" };

/**
 * Decides which captions to translate, given the request the player made.
 * The player picks a track from the viewer's YouTube language preference, so
 * it may already show the target language (a TED talk with uploaded Chinese
 * subtitles) or YouTube's own machine translation of the original.
 */
export function chooseSource(
  playerUrl: string,
  tracks: readonly TrackInfo[],
  targetLang: string,
  base: string,
): SourceDecision {
  const original = withoutTranslation(playerUrl, base);
  if (original) {
    const lang = new URL(original).searchParams.get("lang") ?? "";
    if (!sameLanguage(lang, targetLang)) return { kind: "fetch", url: original };
  }
  const lang = new URL(playerUrl, base).searchParams.get("lang") ?? "";
  if (!original && !sameLanguage(lang, targetLang)) return { kind: "use" };
  const orig = originalTrack(tracks);
  if (orig && !sameLanguage(orig.lang, targetLang)) return { kind: "fetch", url: trackUrl(orig, playerUrl, base) };
  return { kind: "already-target" };
}
