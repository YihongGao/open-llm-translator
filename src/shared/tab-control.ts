// Tab-level control shared by the popup and the keyboard-shortcut handler.
// Both run in a user-gesture context, so activeTab grants scripting access.

import type { ContentMessage, Feature, TabState } from "./messages";
import { loadSettings } from "./settings";

export type ToggleResult = { ok: true; active: boolean } | { ok: false; reason: "restricted" };

/** The feature's on/off state in a TabState. */
function featureActive(state: TabState, feature: Feature): boolean {
  return feature === "subtitles" ? state.subtitles === true : state.active;
}

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

export async function toggleTab(tabId: number, feature: Feature = "page"): Promise<ToggleResult> {
  const { targetLang, uiLanguage } = await loadSettings();
  const msg: ContentMessage = { type: "llmt-toggle", targetLang, uiLanguage, feature };
  if (feature === "subtitles") {
    // The page hook reads the player's caption requests; it must run in the
    // page's main world, where the player's XMLHttpRequest lives. Idempotent,
    // and needed even when the content script is already there for page
    // translation.
    try {
      await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", files: ["youtube-hook.js"] });
    } catch {
      return { ok: false, reason: "restricted" };
    }
  }
  const state = await send(tabId, msg);
  if (state) return { ok: true, active: featureActive(state, feature) };

  // No receiver yet: inject on demand, then deliver the first toggle.
  if (!(await ensureContentScript(tabId))) return { ok: false, reason: "restricted" };
  const after = await send(tabId, msg);
  return { ok: true, active: after ? featureActive(after, feature) : true };
}

/**
 * Injects the content script and its CSS into the tab's top frame. The script
 * only registers its listeners; nothing is translated until a message asks.
 * Safe to call again (the script guards against a second load; the CSS is
 * inserted twice, which is harmless). False when the page cannot be scripted.
 *
 * Every content-script injection passes through here, so this is where the
 * API key is shielded from it. Fail closed: if setAccessLevel throws, nothing is injected.
 */
export async function ensureContentScript(tabId: number): Promise<boolean> {
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return true;
  } catch {
    return false;
  }
}

export async function setTabLanguage(tabId: number, targetLang: string): Promise<void> {
  await send(tabId, { type: "llmt-set-lang", targetLang, uiLanguage: (await loadSettings()).uiLanguage });
}
