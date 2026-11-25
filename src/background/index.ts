// MV3 service worker: owns API calls, cache and tab toggling.
// All listeners are registered synchronously at top level so Chrome can wake
// the worker for them.

import {
  PORT_NAME,
  type OpenOptionsMessage,
  type TestConnectionMessage,
  type TestConnectionResult,
  type TranslateEvent,
  type TranslateRequest,
} from "../shared/messages";
import { loadSettings } from "../shared/settings";
import { toggleTab } from "../shared/tab-control";
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
    // Set when the page went into back/forward cache; reading it marks the
    // error as handled (otherwise Chrome logs "Unchecked runtime.lastError").
    void chrome.runtime.lastError;
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
      message: "尚未設定 Anthropic API key",
      scope: "page",
      settings: true,
    });
    emit({ type: "batch-done", batchId: req.batchId });
    return;
  }

  const provider = new AnthropicProvider(settings.anthropicApiKey, settings.model);
  const stats = await withSlot(() =>
    runBatch(
      req,
      {
        provider,
        targetLang: settings.targetLang,
        model: settings.model,
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
  // Visible in chrome://extensions -> Service Worker -> Console.
  if (stats) {
    console.info(
      `[llmt] batch ${req.batchId}: ${stats.segments} segs, ${stats.unique} unique, ` +
        `${stats.cacheHits} cached, ${stats.sent} sent, ${stats.failed} failed, ${stats.ms} ms` +
        (stats.usage ? `, tokens in/out ${stats.usage.inputTokens}/${stats.usage.outputTokens}` : "") +
        ` | requested ${settings.model}` +
        (stats.servedModel ? ` → served ${stats.servedModel}${stats.fallback ? " (fallback)" : ""}` : ""),
    );
  }
}

// ---------------------------------------------------------------------------
// Keyboard shortcut.

// Keep the API key out of content scripts: by default chrome.storage.local is
// readable from them. Runs on every worker start; the call is idempotent.
void chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });

// The toolbar icon opens the popup (manifest default_popup); the keyboard
// shortcut toggles directly.
chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== "toggle-translation" || tab?.id === undefined) return;
  void toggleTab(tab.id).then((res) => {
    // chrome://, the Web Store and similar pages cannot be scripted.
    if (!res.ok) console.info("[llmt] this tab cannot be translated:", tab.url ?? "(unknown url)");
  });
});

// ---------------------------------------------------------------------------
// Options page "測試連線".

chrome.runtime.onMessage.addListener(
  (msg: TestConnectionMessage | OpenOptionsMessage, _sender, sendResponse) => {
    if (msg?.type === "llmt-open-options") {
      void chrome.runtime.openOptionsPage();
      return false;
    }
    if (msg?.type !== "llmt-test-connection") return false;
    void testConnection().then(sendResponse);
    return true; // async response
  },
);

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
    return { ok: false, message: describeAnthropicError(err).message };
  }
}
