// Wire protocol between the content script and the background service worker.
// Content script opens one long-lived Port per page (PORT_NAME); translation
// results stream back segment by segment over that port.

export const PORT_NAME = "llmt-translate";

export interface Segment {
  /** Page-unique id assigned by the content script. */
  id: string;
  /** Whitespace-normalised source text (single line). */
  text: string;
}

export interface PageContext {
  title: string;
  url: string;
}

// content -> background (over Port)
export interface TranslateRequest {
  type: "translate";
  batchId: string;
  segments: Segment[];
  page: PageContext;
}

// background -> content (over Port)
export type TranslateEvent =
  | { type: "segment"; batchId: string; id: string; text: string }
  | { type: "segment-error"; batchId: string; ids: string[]; message: string }
  | { type: "batch-done"; batchId: string };

// background -> content (chrome.tabs.sendMessage)
// Content scripts cannot read chrome.storage (see background setAccessLevel),
// so the settings they need travel with this message.
export interface ToggleMessage {
  type: "llmt-toggle";
  targetLang: string;
}

// any page -> background (chrome.runtime.sendMessage)
export interface TestConnectionMessage {
  type: "llmt-test-connection";
}
export type TestConnectionResult = { ok: true; sample: string } | { ok: false; message: string };
