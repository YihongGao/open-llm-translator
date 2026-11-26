// Text hygiene shared by the content script (segment text) and the background
// worker (page title, model output).

/**
 * Characters that render as nothing but are read by the model, so a page can
 * hide instructions in otherwise normal text:
 * - Unicode tag characters U+E0000–E007F ("ASCII smuggling": each mirrors an
 *   ASCII letter);
 * - variation selectors U+FE00–FE0D and U+E0100–E01EF (used to smuggle bytes
 *   after a visible character);
 * - zero-width space, word joiner, BOM, soft hyphen, Mongolian vowel
 *   separator, combining grapheme joiner, Hangul fillers;
 * - bidirectional controls (can reorder what a reader sees vs what is sent).
 * Kept on purpose, because ordinary text needs them: ZWNJ/ZWJ (U+200C/200D:
 * Persian and Indic spelling, emoji sequences such as 👩‍💻) and the
 * text/emoji presentation selectors VS15/VS16 (U+FE0E/FE0F: ❤️). They carry
 * too little to smuggle instructions.
 */
const INVISIBLE =
  /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0D\uFEFF\uFFA0]|[\u{E0000}-\u{E007F}]|[\u{E0100}-\u{E01EF}]/gu;

export function stripInvisible(s: string): string {
  return s.replace(INVISIBLE, "");
}

/** Invisible characters removed, whitespace collapsed, trimmed. */
export function normalizeText(s: string): string {
  return stripInvisible(s).replace(/\s+/g, " ").trim();
}
