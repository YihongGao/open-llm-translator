// Tab-level control shared by the popup and the keyboard-shortcut handler.
// Both run in a user-gesture context, so activeTab grants scripting access.

import type { ContentMessage, TabState } from "./messages";
import { loadSettings } from "./settings";

export type ToggleResult = { ok: true; active: boolean } | { ok: false; reason: "restricted" };

/** Pages Chrome never lets extensions script. */
export function isRestrictedUrl(url: string | undefined): boolean {
  if (!url) return false; // unknown: let injection decide
  return (
    /^(chrome|chrome-extension|chrome-untrusted|devtools|edge|about|view-source):/.test(url) ||
    url.startsWith("https://chromewebstore.google.com/") ||
    url.startsWith("https://chrome.google.com/webstore")
  );
}

async function send(tabId: number, msg: ContentMessage): Promise<TabState | null> {
  try {
    return ((await chrome.tabs.sendMessage(tabId, msg)) as TabState | undefined) ?? null;
  } catch {
    return null; // no content script in this tab yet
  }
}

/** null = translation never started in this tab. */
export function getTabState(tabId: number): Promise<TabState | null> {
  return send(tabId, { type: "llmt-status" });
}

export async function toggleTab(tabId: number): Promise<ToggleResult> {
  const msg: ContentMessage = { type: "llmt-toggle", targetLang: (await loadSettings()).targetLang };
  const state = await send(tabId, msg);
  if (state) return { ok: true, active: state.active };

  // No receiver yet: inject on demand, then deliver the first toggle.
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch {
    return { ok: false, reason: "restricted" };
  }
  const after = await send(tabId, msg);
  return { ok: true, active: after?.active ?? true };
}

export async function setTabLanguage(tabId: number, targetLang: string): Promise<void> {
  await send(tabId, { type: "llmt-set-lang", targetLang });
}
