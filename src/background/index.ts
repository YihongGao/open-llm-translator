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
import { TARGET_LANGUAGES, loadSettings } from "../shared/settings";
import { toggleTab } from "../shared/tab-control";
import { isYouTubeUrl } from "../shared/youtube-bridge";
import { cacheGetMany, cacheKey, cachePut } from "./cache";
import { countSystemPromptTokens } from "./providers/anthropic";
import { createProvider, isAbort, missingKeyMessage } from "./providers/registry";
import { CacheWarmupGate, withWarmup } from "./cache-warmup";
import { estimateCostUsd } from "./pricing";

const warmupGate = new CacheWarmupGate();
import { runBatch, type BatchStats } from "./translator";

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

  // Cache entries are partitioned by the page's origin, taken from Chrome's
  // view of the sender rather than anything the page reports, so a hostile
  // page cannot replay (or read back via timing) translations cached on
  // another site.
  const origin = senderOrigin(port.sender);

  port.onMessage.addListener((msg: TranslateRequest) => {
    if (msg?.type !== "translate") return;
    void handleTranslate(msg, origin, emit, controller.signal);
  });
});

function senderOrigin(sender: chrome.runtime.MessageSender | undefined): string {
  try {
    return new URL(sender?.url ?? sender?.tab?.url ?? "").origin;
  } catch {
    return "unknown";
  }
}

async function handleTranslate(
  req: TranslateRequest,
  origin: string,
  emit: (ev: TranslateEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const settings = await loadSettings();
  // The language travels with the request; only accept known tags, since the
  // name ends up in the system prompt.
  const targetLang = TARGET_LANGUAGES.some((l) => l.tag === req.targetLang) ? req.targetLang : settings.targetLang;
  const setup = createProvider(settings);
  if (!setup) {
    emit({
      type: "segment-error",
      batchId: req.batchId,
      ids: req.segments.map((s) => s.id),
      message: missingKeyMessage(settings),
      scope: "page",
      settings: true,
    });
    emit({ type: "batch-done", batchId: req.batchId });
    return;
  }

  // The cached prefix (system prompt) depends on model and target language.
  // OpenAI and Gemini cache prompts implicitly, with nothing to warm up.
  const provider = setup.explicitPromptCache
    ? withWarmup(setup.provider, warmupGate, `${settings.model}\u0000${targetLang}`)
    : setup.provider;
  const stats = await withSlot(() =>
    runBatch(
      req,
      {
        provider,
        targetLang,
        model: settings.model,
        cache: {
          key: (text) => cacheKey(origin, settings.model, targetLang, text),
          getMany: cacheGetMany,
          put: cachePut,
        },
        emit,
        describeError: setup.describeError,
        isAbort,
      },
      signal,
    ),
  );
  // Visible in chrome://extensions -> Service Worker -> Console.
  if (stats) console.info(formatBatchLog(req.batchId, settings.model, stats));
}

function formatBatchLog(batchId: string, requested: string, s: BatchStats): string {
  let line =
    `[llmt] batch ${batchId}: ${s.segments} segs, ${s.unique} unique, ` +
    `${s.cacheHits} cached, ${s.sent} sent, ${s.failed} failed, ${s.ms} ms`;
  if (s.usage) {
    const u = s.usage;
    line += `, tokens in/out ${u.inputTokens}/${u.outputTokens}, cache r/w ${u.cacheReadTokens}/${u.cacheWriteTokens}`;
    const cost = estimateCostUsd(s.servedModel ?? requested, u);
    if (cost !== undefined) line += `, ≈ $${cost.toFixed(4)}`;
  }
  line += ` | requested ${requested}`;
  if (s.servedModel) line += ` → served ${s.servedModel}${s.fallback ? " (fallback)" : ""}`;
  return line;
}

// ---------------------------------------------------------------------------
// Debug helper, run from chrome://extensions -> Service Worker -> Console:
//   await llmtMeasurePrompts()
// Prints the system prompt's token count per target language (free API call),
// to check it stays above the model's minimum cacheable prefix.

(globalThis as { llmtMeasurePrompts?: () => Promise<void> }).llmtMeasurePrompts = async () => {
  const settings = await loadSettings();
  if (!settings.anthropicApiKey || !settings.model.startsWith("claude-")) {
    console.warn("[llmt] 只支援 Claude model，且需要 Anthropic API key");
    return;
  }
  const rows = await countSystemPromptTokens(
    settings.anthropicApiKey,
    settings.model,
    TARGET_LANGUAGES.map((l) => l.tag),
  );
  console.table(rows.map((r) => ({ ...r, model: settings.model, cacheable: r.tokens >= 512 })));
};

// ---------------------------------------------------------------------------
// Keyboard shortcut.

// The toolbar icon opens the popup (manifest default_popup); the keyboard
// shortcut toggles directly.
chrome.commands.onCommand.addListener((command, tab) => {
  if (tab?.id === undefined) return;
  if (command === "toggle-translation") {
    void toggleTab(tab.id).then((res) => {
      // chrome://, the Web Store and similar pages cannot be scripted.
      if (!res.ok) console.info("[llmt] this tab cannot be translated:", tab.url ?? "(unknown url)");
    });
  } else if (command === "toggle-subtitles") {
    // Only offered on YouTube; elsewhere the shortcut does nothing. The URL is
    // read after the shortcut granted activeTab, rather than trusting the
    // event's tab object to carry it.
    const tabId = tab.id;
    void chrome.tabs.get(tabId).then((t) => {
      if (isYouTubeUrl(t.url)) void toggleTab(tabId, "subtitles");
    });
  }
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
  const setup = createProvider(settings);
  if (!setup) return { ok: false, message: missingKeyMessage(settings) };
  try {
    for await (const ev of setup.provider.translate(
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
    return { ok: false, message: setup.describeError(err).message };
  }
}
