// MV3 service worker: owns API calls, cache and tab toggling.
// All listeners are registered synchronously at top level so Chrome can wake
// the worker for them.

import {
  PORT_NAME,
  type TestConnectionMessage,
  type TestConnectionResult,
  type ToggleMessage,
  type TranslateEvent,
  type TranslateRequest,
} from "../shared/messages";
import { loadSettings } from "../shared/settings";
import { cacheGetMany, cacheKey, cachePut } from "./cache";
import { AnthropicProvider, describeAnthropicError, isAbort } from "./providers/anthropic";
import { runBatch } from "./translator";

// ---------------------------------------------------------------------------
// Concurrency: cap simultaneous API requests across all tabs.

const MAX_CONCURRENT_REQUESTS = 3;
let running = 0;
const waiters: Array<() => void> = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT_REQUESTS) await new Promise<void>((r) => waiters.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiters.shift()?.();
  }
}

// ---------------------------------------------------------------------------
// Translation over a long-lived port (one per page).

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  const controller = new AbortController();
  let connected = true;
  port.onDisconnect.addListener(() => {
    connected = false;
    controller.abort();
  });
  const emit = (ev: TranslateEvent) => {
    if (connected) port.postMessage(ev);
  };

  port.onMessage.addListener((msg: TranslateRequest) => {
    if (msg?.type !== "translate") return;
    void handleTranslate(msg, emit, controller.signal);
  });
});

async function handleTranslate(
  req: TranslateRequest,
  emit: (ev: TranslateEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const settings = await loadSettings();
  if (!settings.anthropicApiKey) {
    emit({
      type: "segment-error",
      batchId: req.batchId,
      ids: req.segments.map((s) => s.id),
      message: "尚未設定 Anthropic API key：右鍵點擴充功能圖示 → 選項",
    });
    emit({ type: "batch-done", batchId: req.batchId });
    return;
  }

  const provider = new AnthropicProvider(settings.anthropicApiKey, settings.model);
  await withSlot(() =>
    runBatch(
      req,
      {
        provider,
        targetLang: settings.targetLang,
        cache: {
          key: (text) => cacheKey(settings.model, settings.targetLang, text),
          getMany: cacheGetMany,
          put: cachePut,
        },
        emit,
        describeError: describeAnthropicError,
        isAbort,
      },
      signal,
    ),
  );
}

// ---------------------------------------------------------------------------
// Toggle: toolbar button and keyboard shortcut.

// Keep the API key out of content scripts: by default chrome.storage.local is
// readable from them. Runs on every worker start; the call is idempotent.
void chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });

async function toggleTab(tab: chrome.tabs.Tab | undefined): Promise<void> {
  const tabId = tab?.id;
  if (tabId === undefined) return;
  const msg: ToggleMessage = { type: "llmt-toggle", targetLang: (await loadSettings()).targetLang };
  try {
    await chrome.tabs.sendMessage(tabId, msg);
    return; // content script already present
  } catch {
    // No receiver yet: inject on demand (activeTab grants access after the user gesture).
  }
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    await chrome.tabs.sendMessage(tabId, msg);
  } catch (err) {
    // chrome://, the Web Store and similar pages cannot be scripted.
    console.warn("[llmt] cannot inject into this tab:", err);
  }
}

chrome.action.onClicked.addListener((tab) => void toggleTab(tab));
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "toggle-translation") void toggleTab(tab);
});

// ---------------------------------------------------------------------------
// Options page "測試連線".

chrome.runtime.onMessage.addListener((msg: TestConnectionMessage, _sender, sendResponse) => {
  if (msg?.type !== "llmt-test-connection") return false;
  void testConnection().then(sendResponse);
  return true; // async response
});

async function testConnection(): Promise<TestConnectionResult> {
  const settings = await loadSettings();
  if (!settings.anthropicApiKey) return { ok: false, message: "尚未填入 API key" };
  const provider = new AnthropicProvider(settings.anthropicApiKey, settings.model);
  try {
    for await (const ev of provider.translate(
      {
        texts: ["Kubernetes is an open source container orchestration engine."],
        targetLang: settings.targetLang,
        page: { title: "Connection test", url: "about:blank" },
      },
      new AbortController().signal,
    )) {
      if (ev.kind === "segment") return { ok: true, sample: ev.text };
    }
    return { ok: false, message: "API 有回應，但沒有解析到譯文" };
  } catch (err) {
    return { ok: false, message: describeAnthropicError(err) };
  }
}
