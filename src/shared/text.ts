// Text hygiene shared by the content script (segment text) and the background
// worker (page title, model output).

/**
 * Characters that render as nothing but are read by the model, so a page can
 * hide instructions in otherwise normal text:
 * - Unicode tag characters U+E0000–E007F ("ASCII smuggling": each mirrors an
 *   ASCII letter);
 * - variation selectors U+FE00–FE0F and U+E0100–E01EF (used to smuggle bytes
 *   after a visible character);
 * - zero-width and joiner characters, soft hyphen, word joiner, BOM, Mongolian
 *   vowel separator, combining grapheme joiner;
 * - bidirectional controls (can reorder what a reader sees vs what is sent).
 * Removing them loses nothing the model needs: it only reads the text to
 * translate it, and it writes its own output.
 */
const INVISIBLE =
  /[­͏؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]|[\u{E0000}-\u{E007F}]|[\u{E0100}-\u{E01EF}]/gu;

export function stripInvisible(s: string): string {
  return s.replace(INVISIBLE, "");
}

/** Invisible characters removed, whitespace collapsed, trimmed. */
export function normalizeText(s: string): string {
  return stripInvisible(s).replace(/\s+/g, " ").trim();
}
