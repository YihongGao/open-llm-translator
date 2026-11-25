// End-to-end harness: loads dist-e2e/ into Playwright's Chromium with a fresh
// profile (empty translation cache) and drives the extension through its
// service worker. Build first: `npm run build:e2e`.
//
// Usage:
//   node scripts/e2e.mjs no-key  [url]   # missing-key notice; no API calls, free
//   node scripts/e2e.mjs measure         # system prompt tokens per language; free (count_tokens)
//   node scripts/e2e.mjs translate <url> # translate the whole page and report cost; SPENDS MONEY
//
// Options (env): LLMT_MODEL (default claude-haiku-5-5, same as the extension), LLMT_LANG (default zh-TW),
// LLMT_EXT_DIR (default dist-e2e), HEADED=1 to watch, LLMT_SCREENSHOT=<file.png>
// to save the viewport at the end, LLMT_DUMP=<file.json> to save every
// source/translation pair (for comparing models).
//
// API key for the model's provider, first found: ANTHROPIC_API_KEY /
// OPENAI_API_KEY / GEMINI_API_KEY from the environment or .env.local
// (gitignored; the environment wins), then, for Anthropic only, the first line
// of LLMT_KEY_FILE (default ~/.config/llmt/anthropic-key). The key is only
// passed to the extension's storage inside the throwaway profile; it is never
// printed.

import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const [scenario = "", urlArg] = process.argv.slice(2);
const MODEL = process.env.LLMT_MODEL ?? "claude-haiku-5-5";
const LANG = process.env.LLMT_LANG ?? "zh-TW";
const EXT_DIR = path.resolve(process.env.LLMT_EXT_DIR ?? "dist-e2e");
const DEFAULT_URL = "https://kubernetes.io/docs/concepts/scheduling-eviction/kube-scheduler/";

// Does not override variables already set in the environment.
if (existsSync(".env.local")) process.loadEnvFile(".env.local");

/** Provider by model id prefix: [env var, extension setting]. */
function keySource() {
  if (MODEL.startsWith("gpt-")) return ["OPENAI_API_KEY", "openaiApiKey"];
  if (MODEL.startsWith("gemini-")) return ["GEMINI_API_KEY", "geminiApiKey"];
  return ["ANTHROPIC_API_KEY", "anthropicApiKey"];
}

async function loadKey() {
  const [envVar] = keySource();
  if (process.env[envVar]) return process.env[envVar].trim();
  if (envVar !== "ANTHROPIC_API_KEY") throw new Error(`No API key: put ${envVar}=... in .env.local or export it.`);
  const file = process.env.LLMT_KEY_FILE ?? path.join(homedir(), ".config/llmt/anthropic-key");
  try {
    return (await readFile(file, "utf8")).split("\n")[0].trim();
  } catch {
    throw new Error(`No API key: put ANTHROPIC_API_KEY=... in .env.local, export it, or create ${file}.`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch() {
  const profile = await mkdtemp(path.join(tmpdir(), "llmt-e2e-"));
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: !process.env.HEADED,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
  });
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  // Capture the batch log lines the worker prints.
  await sw.evaluate(() => {
    globalThis.__llmtLogs = [];
    const info = console.info.bind(console);
    console.info = (...args) => {
      globalThis.__llmtLogs.push(args.join(" "));
      info(...args);
    };
  });
  const close = async () => {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  };
  return { context, sw, close };
}

async function configure(sw, apiKey) {
  await sw.evaluate(
    (s) => chrome.storage.local.set(s),
    { [keySource()[1]]: apiKey, model: MODEL, targetLang: LANG },
  );
}

/** Same steps as the popup's toggle (inject + toggle message), done from the worker. */
async function startTranslation(sw, url) {
  return sw.evaluate(async ({ url, lang }) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url) ?? tabs.find((t) => t.url?.startsWith(url));
    if (!tab?.id) throw new Error(`tab not found for ${url}`);
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    return chrome.tabs.sendMessage(tab.id, { type: "llmt-toggle", targetLang: lang });
  }, { url, lang: LANG });
}

async function domStats(page) {
  return page.evaluate(() => {
    const nodes = [...document.querySelectorAll("llmt-translation")];
    const count = (sel) => nodes.filter((n) => n.matches(sel)).length;
    const by = (attr) =>
      nodes.reduce((acc, n) => {
        const v = n.getAttribute(attr);
        if (v) acc[v] = (acc[v] ?? 0) + 1;
        return acc;
      }, {});
    const toast = document.querySelector("llmt-toast")?.shadowRoot?.querySelector(".msg")?.textContent ?? null;
    return {
      translations: count(":not(.llmt-pending):not(.llmt-error)"),
      pending: count(".llmt-pending"),
      errors: count(".llmt-error"),
      model: by("data-llmt-model"),
      source: by("data-llmt-source"),
      toast,
    };
  });
}

/**
 * Source/translation pairs in document order. The source is reconstructed
 * from the nodes before each translation node, up to the previous block or
 * translation — the same run the segmenter sent.
 */
async function dumpPairs(page) {
  return page.evaluate(() => {
    const isBlock = (n) =>
      n.nodeType === Node.ELEMENT_NODE &&
      (n.tagName === "LLMT-TRANSLATION" || !getComputedStyle(n).display.startsWith("inline"));
    const textOf = (n) => {
      if (n.nodeType === Node.TEXT_NODE) return n.textContent;
      if (n.nodeType !== Node.ELEMENT_NODE || n.tagName === "LLMT-TRANSLATION") return "";
      return [...n.childNodes].map(textOf).join("");
    };
    return [...document.querySelectorAll("llmt-translation:not(.llmt-pending):not(.llmt-error)")].map((node) => {
      const parts = [];
      for (let n = node.previousSibling; n && !isBlock(n); n = n.previousSibling) parts.unshift(textOf(n));
      return {
        source: parts.join("").replace(/\s+/g, " ").trim(),
        translation: node.textContent,
        tag: node.parentElement?.closest("h1,h2,h3,h4,h5,h6,p,li,td,th,a,nav")?.tagName.toLowerCase() ?? "",
      };
    });
  });
}

/** Scroll to the bottom in viewport steps, then wait until nothing is pending. */
async function scrollThrough(page) {
  for (let i = 0; i < 200; i++) {
    const done = await page.evaluate(() => {
      window.scrollBy(0, window.innerHeight * 0.8);
      return window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
    });
    await sleep(700);
    if (done) break;
  }
  for (let i = 0; i < 60; i++) {
    const { pending } = await domStats(page);
    if (pending === 0) break;
    await sleep(1000);
  }
}

function summarize(logs) {
  const cost = logs.reduce((sum, l) => sum + Number(/≈ \$([\d.]+)/.exec(l)?.[1] ?? 0), 0);
  const field = (re) => logs.reduce((sum, l) => sum + Number(re.exec(l)?.[1] ?? 0), 0);
  return {
    batches: logs.length,
    apiRequests: logs.filter((l) => /tokens in\/out/.test(l)).length,
    inputTokens: field(/tokens in\/out (\d+)\//),
    outputTokens: field(/tokens in\/out \d+\/(\d+)/),
    cacheRead: field(/cache r\/w (\d+)\//),
    cacheWrite: field(/cache r\/w \d+\/(\d+)/),
    estimatedUsd: Number(cost.toFixed(4)),
  };
}

async function main() {
  if (!["no-key", "measure", "translate"].includes(scenario)) {
    console.error("usage: node scripts/e2e.mjs <no-key|measure|translate> [url]");
    process.exit(2);
  }
  const { context, sw, close } = await launch();
  try {
    if (scenario === "measure") {
      await configure(sw, await loadKey());
      const rows = await sw.evaluate(async () => {
        let captured = null;
        const table = console.table;
        console.table = (rows) => (captured = rows);
        try {
          await globalThis.llmtMeasurePrompts();
        } finally {
          console.table = table;
        }
        return captured;
      });
      console.table(rows);
      return;
    }

    const url = urlArg ?? DEFAULT_URL;
    await configure(sw, scenario === "no-key" ? "" : await loadKey());
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await sleep(500);
    const state = await startTranslation(sw, page.url());
    console.log("toggle →", state);

    if (scenario === "no-key") {
      await sleep(1500);
      console.log(await domStats(page));
      if (process.env.LLMT_SCREENSHOT) await page.screenshot({ path: process.env.LLMT_SCREENSHOT });
      return;
    }

    await scrollThrough(page);
    if (process.env.LLMT_SCREENSHOT) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await sleep(500);
      await page.screenshot({ path: process.env.LLMT_SCREENSHOT });
    }
    const logs = await sw.evaluate(() => globalThis.__llmtLogs);
    for (const l of logs) console.log(l);
    console.log("\nDOM:", await domStats(page));
    console.log("Summary:", summarize(logs));
    if (process.env.LLMT_DUMP) {
      const pairs = await dumpPairs(page);
      await writeFile(process.env.LLMT_DUMP, JSON.stringify({ model: MODEL, url, summary: summarize(logs), pairs }, null, 2));
      console.log(`wrote ${pairs.length} pairs to ${process.env.LLMT_DUMP}`);
    }
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
