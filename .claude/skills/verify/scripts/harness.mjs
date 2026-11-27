// Verification harness for the Open LLM Translator extension.
// Import it from a drive script that lives in this directory (Node resolves
// `playwright` from the repo's node_modules):
//
//   import { launch } from "./harness.mjs";
//   const run = await launch({ name: "page-translation" });
//   try { ... } finally { await run.close(); }
//
// One launch = one isolated Chromium: fresh temp profile (empty settings and
// translation cache), its own copy of dist-e2e/, its own fixture server port.
// Concurrent runs do not share state. Evidence goes to
// .verify-artifacts/<stamp>-<name>/ at the repo root and survives close().

import { chromium } from "playwright";
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "../../../..");
export const FIXTURES = path.resolve(HERE, "../fixtures");
export const BUILD_DIR = path.join(REPO, "dist-e2e");
export const ARTIFACT_ROOT = path.join(REPO, ".verify-artifacts");
/** Every temp dir a run creates starts with this; cleanup.mjs matches on it. */
export const PROFILE_PREFIX = "llmt-verify-";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function newestMtime(dir) {
  let newest = 0;
  for (const f of readdirSync(dir, { recursive: true })) {
    const s = statSync(path.join(dir, f));
    if (s.isFile()) newest = Math.max(newest, s.mtimeMs);
  }
  return newest;
}

/** Problems that make dist-e2e/ unfit to drive; [] when it is fine. Read-only. */
export function buildProblems() {
  const manifestPath = path.join(BUILD_DIR, "manifest.json");
  if (!existsSync(manifestPath)) return ["dist-e2e/ is missing: run `npm run build:e2e`"];
  const problems = [];
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!manifest.name.includes("(E2E)")) problems.push("dist-e2e/manifest.json is not the E2E build");
  const built = statSync(manifestPath).mtimeMs;
  const src = Math.max(newestMtime(path.join(REPO, "src")), newestMtime(path.join(REPO, "public")));
  if (src > built) problems.push("dist-e2e/ is older than src/ or public/: run `npm run build:e2e`");
  return problems;
}

// ---------------------------------------------------------------------------
// Mock LLM API. The provider APIs are the extension's external boundary, so
// the run fulfils them here; everything inside the extension runs for real.

const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

/** Deterministic translation: every source segment comes back prefixed. */
export const MOCK_PREFIX = "〔譯〕";

/** Text of the last user message in an Anthropic request body. */
export function userText(body) {
  const content = body?.messages?.at(-1)?.content;
  return typeof content === "string" ? content : (content ?? []).map((c) => c.text ?? "").join("");
}

/** Source segments ("[n] text" lines) a request sent for translation. */
export const segmentsOf = (body) => [...userText(body).matchAll(/^\[\d+\] (.*)$/gm)].map((m) => m[1]);

function anthropicStream(body) {
  const text = userText(body);
  const lines = [...text.matchAll(/^\[(\d+)\] (.*)$/gm)].map((m) => `[${m[1]}] ${MOCK_PREFIX}${m[2]}\n`);
  return (
    sse("message_start", {
      message: {
        id: "msg_verify", type: "message", role: "assistant", model: body.model, content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 },
      },
    }) +
    sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
    lines.map((t) => sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: t } })).join("") +
    sse("content_block_stop", { index: 0 }) +
    sse("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: lines.length * 10 } }) +
    sse("message_stop", {})
  );
}

/**
 * mock: "ok"   — Anthropic answers with MOCK_PREFIX + source (default).
 *       "401"  — Anthropic rejects the key (authentication_error).
 *       "429"  — Anthropic rate-limits.
 *       false  — no mock: real API calls, SPENDS MONEY, needs a real key.
 * OpenAI and Gemini are never mocked: their requests are aborted and logged,
 * so select an Anthropic model unless you run with mock: false.
 */
async function installMock(ctx, mode, calls) {
  if (mode === false) return;
  await ctx.route(/^https:\/\/api\.anthropic\.com\//, async (route) => {
    const req = route.request();
    const body = JSON.parse(req.postData() ?? "{}");
    calls.push({ provider: "anthropic", url: req.url(), body });
    if (mode === "401" || mode === "429") {
      const type = mode === "401" ? "authentication_error" : "rate_limit_error";
      await route.fulfill({
        status: Number(mode),
        headers: { "content-type": "application/json", "request-id": "req_verify" },
        body: JSON.stringify({ type: "error", error: { type, message: `verify mock ${mode}` } }),
      });
      return;
    }
    await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: anthropicStream(body) });
  });
  await ctx.route(/^https:\/\/(api\.openai\.com|generativelanguage\.googleapis\.com)\//, async (route) => {
    calls.push({ provider: "unmocked", url: route.request().url() });
    await route.abort("blockedbyclient");
  });
}

// ---------------------------------------------------------------------------
// Fixture server, popup and page drivers, launch().

function serveFixtures() {
  const server = createServer(async (req, res) => {
    const name = path.basename(new URL(req.url, "http://x").pathname) || "article.html";
    const file = path.join(FIXTURES, name);
    if (!existsSync(file)) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(await readFile(file));
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}/` })),
  );
}

/**
 * The real toolbar popup, opened by chrome.action.openPopup() so it is
 * attached to the active tab exactly as when the user clicks the icon.
 * Playwright cannot hand out a Page for it, so it is driven through
 * chrome.extension.getViews() from a helper extension tab.
 */
function popupHandle(helper) {
  const inPopup = (fn, arg) =>
    helper.evaluate(
      ([src, a]) => {
        const [w] = chrome.extension.getViews({ type: "popup" });
        if (!w) throw new Error("popup is not open");
        return new Function("w", "doc", "arg", `return (${src})(w, doc, arg)`)(w, w.document, a);
      },
      [fn.toString(), arg],
    );
  return {
    /** Runs fn(window, document, arg) inside the popup. */
    eval: inPopup,
    text: (sel) => inPopup((w, doc, s) => doc.querySelector(s)?.textContent ?? null, sel),
    click: (sel) => inPopup((w, doc, s) => doc.querySelector(s).click(), sel),
    /** Sets a <select> and fires change, as a user pick does. */
    select: (sel, value) =>
      inPopup((w, doc, [s, v]) => {
        const el = doc.querySelector(s);
        el.value = v;
        el.dispatchEvent(new w.Event("change"));
      }, [sel, value]),
    /** Visible state the user sees. */
    state: () =>
      inPopup((w, doc) => ({
        toggle: doc.querySelector("#toggle").textContent,
        toggleDisabled: doc.querySelector("#toggle").disabled,
        subs: doc.querySelector("#subs").classList.contains("show") ? doc.querySelector("#subs").textContent : null,
        warn: doc.querySelector("#warn").classList.contains("show") ? doc.querySelector("#warnText").textContent : null,
        note: doc.querySelector("#note").textContent,
        targetLang: doc.querySelector("#targetLang").value,
        model: doc.querySelector("#model").value,
      })),
    isOpen: () => helper.evaluate(() => chrome.extension.getViews({ type: "popup" }).length > 0),
  };
}

/** What the page shows: translation nodes and the error toast. */
export function pageState(page) {
  return page.evaluate(() => {
    const nodes = [...document.querySelectorAll("llmt-translation")];
    const toastRoot = document.querySelector("llmt-toast")?.shadowRoot;
    return {
      hidden: document.documentElement.classList.contains("llmt-hidden"),
      done: nodes.filter((n) => !n.matches(".llmt-pending, .llmt-error")).length,
      pending: nodes.filter((n) => n.matches(".llmt-pending")).length,
      errors: nodes.filter((n) => n.matches(".llmt-error")).length,
      byHost: nodes.map((n) => ({
        host: n.parentElement?.closest("[id]")?.id ?? n.parentElement?.tagName.toLowerCase(),
        layout: n.classList.contains("llmt-inline") ? "inline" : "block",
        state: n.matches(".llmt-error") ? "error" : n.matches(".llmt-pending") ? "pending" : "done",
        source: n.getAttribute("data-llmt-source"),
        model: n.getAttribute("data-llmt-model"),
        error: n.getAttribute("data-llmt-error"),
        text: n.textContent,
      })),
      toast: toastRoot
        ? {
            message: toastRoot.querySelector(".msg")?.textContent ?? null,
            detail: toastRoot.querySelector(".detail")?.textContent ?? null,
            action: toastRoot.querySelector(".action")?.textContent ?? null,
          }
        : null,
    };
  });
}

/** Polls until predicate(pageState) holds; returns the last state. Throws on timeout. */
export async function waitForPage(page, predicate, { timeout = 15000, label = "page state" } = {}) {
  const until = Date.now() + timeout;
  let state;
  while (Date.now() < until) {
    state = await pageState(page);
    if (predicate(state)) return state;
    await sleep(250);
  }
  throw new Error(`timeout waiting for ${label}; last state: ${JSON.stringify(state)}`);
}

/**
 * @param {{ name: string, mock?: "ok"|"401"|"429"|false, settings?: object, headed?: boolean, locale?: string }} opts
 *   locale: the browser UI language (chrome.i18n), default "zh-TW" so the Chinese assertions hold on any OS.
 *     Set through --lang: Chromium on Windows ignores Playwright's `locale` option for chrome.i18n (it only
 *     changes navigator.language and Accept-Language), and otherwise follows the OS language. Any tag works, e.g. "ja", "fr".
 *   settings: written to chrome.storage.local before any page loads.
 *   Default: mock key + claude-haiku-5-5 + zh-TW. Pass { anthropicApiKey: "" } for the no-key path.
 */
export async function launch({ name, mock = "ok", settings = {}, headed = !!process.env.HEADED, locale = "zh-TW" } = {}) {
  if (!name) throw new Error("launch({ name }) is required: it names the artifact dir");
  const problems = buildProblems();
  if (problems.length) throw new Error(`refusing to launch:\n  - ${problems.join("\n  - ")}`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const artifacts = path.join(ARTIFACT_ROOT, `${stamp}-${name}`);
  await mkdir(artifacts, { recursive: true });

  const temp = await mkdtemp(path.join(tmpdir(), PROFILE_PREFIX));
  const extDir = path.join(temp, "ext");
  await cp(BUILD_DIR, extDir, { recursive: true }); // a rebuild mid-run cannot change what this run drives
  const { server, base } = await serveFixtures();

  const ctx = await chromium.launchPersistentContext(path.join(temp, "profile"), {
    channel: "chromium",
    headless: !headed,
    viewport: { width: 1280, height: 900 },
    locale,
    // Linux picks its UI language from LANGUAGE rather than --lang; both are set so the run does not depend on the OS.
    env: { ...process.env, LANGUAGE: locale.replace("-", "_") },
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, `--lang=${locale}`],
  });
  const close = async () => {
    await ctx.close().catch(() => {});
    server.close();
    await rm(temp, { recursive: true, force: true });
  };

  try {
    const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
    const extId = new URL(sw.url()).host;
    // Keep the worker's batch log lines ("[llmt] ...") as evidence.
    await sw.evaluate(() => {
      globalThis.__verifyLogs = [];
      for (const level of ["info", "warn", "error"]) {
        const orig = console[level].bind(console);
        console[level] = (...a) => {
          globalThis.__verifyLogs.push(`${level}: ${a.map(String).join(" ")}`);
          orig(...a);
        };
      }
    });

    const calls = [];
    await installMock(ctx, mock, calls);
    const stored = { anthropicApiKey: mock === false ? "" : "sk-ant-verify-mock", model: "claude-haiku-5-5", targetLang: "zh-TW", ...settings };
    await sw.evaluate((s) => chrome.storage.local.set(s), stored);

    // Helper tab for driving the popup (see popupHandle): any extension page
    // can call chrome.extension.getViews. popup.html loaded as a tab, not
    // options.html: openOptionsPage() would focus an existing options tab
    // instead of opening one, hiding the behavior under test.
    const helper = await ctx.newPage();
    await helper.goto(`chrome-extension://${extId}/popup.html#verify-helper`);

    const run = {
      ctx, sw, extId, artifacts, fixtureBase: base, calls, mock, helper,
      fixture: (file = "article.html") => base + file,
      /** Opens url in a new tab and makes it the active tab. */
      async newPage(url) {
        const page = await ctx.newPage();
        await page.goto(url, { waitUntil: "domcontentloaded" });
        await page.bringToFront();
        return page;
      },
      /** Opens the real toolbar popup for the active tab (call page.bringToFront() first). */
      async openPopup() {
        const h = popupHandle(helper);
        // openPopup() rejects while a popup is already showing (e.g. after a
        // <select> change, which does not close it). Close it, as a user would.
        if (await h.isOpen()) {
          await helper.evaluate(() => chrome.extension.getViews({ type: "popup" }).forEach((w) => w.close()));
          for (let i = 0; i < 20 && (await h.isOpen()); i++) await sleep(100);
        }
        await sw.evaluate(() => chrome.action.openPopup());
        for (let i = 0; i < 40 && !(await h.isOpen()); i++) await sleep(100);
        if (!(await h.isOpen())) throw new Error("popup did not open (is the target tab active? call page.bringToFront())");
        // init() is async and rewrites the toggle label once it knows the tab
        // state. The label stays the bare default (in the UI language) only
        // when no shortcut is bound, so give up waiting after 1.5s.
        const bare = await helper.evaluate(() => chrome.i18n.getMessage("popupTranslatePage"));
        for (let i = 0; i < 15; i++) {
          if ((await h.state().catch(() => null))?.toggle !== bare) break;
          await sleep(100);
        }
        return h;
      },
      /** chrome.storage.local as the extension sees it (API keys masked). */
      storage: () =>
        sw.evaluate(async () => {
          const all = await chrome.storage.local.get(null);
          for (const k of Object.keys(all)) if (/ApiKey$/.test(k) && all[k]) all[k] = `<${all[k].length} chars>`;
          return all;
        }),
      logs: () => sw.evaluate(() => globalThis.__verifyLogs),
      async screenshot(page, file, opts = {}) {
        const p = path.join(artifacts, file);
        await page.screenshot({ path: p, ...opts });
        return p;
      },
      async writeJson(file, data) {
        const p = path.join(artifacts, file);
        await writeFile(p, JSON.stringify(data, null, 2));
        return p;
      },
      /** Saves worker logs and mocked API calls, then tears everything down. Artifacts stay. */
      async close() {
        try {
          await writeFile(path.join(artifacts, "worker-logs.txt"), ((await run.logs().catch(() => null)) ?? []).join("\n"));
          await writeFile(path.join(artifacts, "api-calls.json"), JSON.stringify(calls, null, 2));
        } finally {
          await close();
        }
        console.log(`artifacts: ${artifacts}`);
      },
    };
    return run;
  } catch (err) {
    await close();
    throw err;
  }
}
