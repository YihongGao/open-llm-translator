// Simulated Open LLM Translator for the landing page.
// Same DOM and CSS as the real extension (public/content.css): an
// <llmt-translation> node inside the original element, "…" + .llmt-pending while
// waiting, html.llmt-hidden to show the original only. No network, no LLM:
// translations come from each element's data-tr attribute.
//
// A visitor who has the real extension installed owns Alt+A through
// chrome.commands, so the page never sees that keydown and the real extension
// translates the page instead, mock article included. The demo watches for
// that and hands over (see "Extension mode" below).

// Chrome on macOS reports "macOS" in userAgentData.platform and "MacIntel" in
// navigator.platform; check both, case-insensitively.
const mac = /mac/i.test(`${navigator.userAgentData?.platform ?? ""} ${navigator.platform ?? ""}`);
for (const k of document.querySelectorAll("[data-alt]")) {
  if (mac) k.innerHTML = '<span aria-hidden="true">⌥</span><span class="sr-only">Option</span>';
}

// The page's own words, by <html lang>. Counts are filled in by the functions.
const paragraphs = (n) => `${n} paragraph${n === 1 ? "" : "s"}`;
const STRINGS = {
  "zh-Hant-TW": {
    translating: (done, total) => `翻譯中 ${done}/${total}`,
    partial: (n) => `已翻譯 ${n} 段，往下捲會接著翻`,
    translated: (n) => `已翻譯 ${n} 段`,
    failed: (n) => `${n} 段翻譯失敗`,
    chip: { off: "尚未翻譯", hidden: "只顯示原文" },
    button: { off: "翻譯這篇", on: "只看原文", hidden: "顯示譯文" },
    sayTranslating: "翻譯中",
    sayHidden: "已隱藏譯文，只顯示原文",
    sayShown: "已顯示譯文",
    ext: {
      intro: "偵測到你安裝的 Open LLM Translator，現在由它用你的 API key 翻譯這一頁。",
      translating: "你的擴充功能翻譯中",
      done: (n) => `你的擴充功能已翻譯 ${n} 段`,
      failed: (n) => `你的擴充功能有 ${n} 段翻譯失敗`,
      same: "示範文章已經是你的目標語言",
      saySame: "示範文章已經是你的目標語言，擴充功能沒有翻它",
    },
    pause: "暫停示範影片",
    play: "播放示範影片",
    ytButton: { on: "關閉雙語字幕", off: "開啟雙語字幕" },
    ytState: { on: "雙語字幕：開", off: "雙語字幕：關" },
    ytSay: { on: "已開啟雙語字幕", off: "已關閉雙語字幕" },
  },
  en: {
    translating: (done, total) => `Translating ${done}/${total}`,
    partial: (n) => `${paragraphs(n)} translated, scroll for more`,
    translated: (n) => `${paragraphs(n)} translated`,
    failed: (n) => `${paragraphs(n)} failed`,
    chip: { off: "Not translated", hidden: "Original only" },
    button: { off: "Translate", on: "Hide translation", hidden: "Show translation" },
    sayTranslating: "Translating",
    sayHidden: "Translation hidden, showing the original only",
    sayShown: "Translation shown",
    ext: {
      intro: "Open LLM Translator is installed in this browser, so it is now translating this page with your API key. ",
      translating: "Your extension is translating",
      done: (n) => `Your extension translated ${paragraphs(n)}`,
      failed: (n) => `Your extension couldn't translate ${paragraphs(n)}`,
      same: "Already in your language",
      saySame: "The demo article is already in your target language, so the extension left it as is",
    },
    pause: "Pause the demo video",
    play: "Play the demo video",
    ytButton: { on: "Turn off bilingual subtitles", off: "Turn on bilingual subtitles" },
    ytState: { on: "Bilingual subtitles: on", off: "Bilingual subtitles: off" },
    ytSay: { on: "Bilingual subtitles on", off: "Bilingual subtitles off" },
  },
};
const UI = STRINGS[document.documentElement.lang] ?? STRINGS.en;

// Remember a visitor's explicit language choice, so the root page sends them
// back to it instead of guessing from the browser language (see lang.js).
document.addEventListener("click", (e) => {
  const lang = e.target.closest?.("[data-site-lang]")?.dataset.siteLang;
  if (!lang) return;
  try { localStorage.setItem("llmt-site-lang", lang); } catch {}
});

// Screen-reader announcements through the page's polite live region.
function announce(msg) {
  const r = document.querySelector("[data-llmt-status]");
  if (r) r.textContent = msg;
}

// Page translation (Alt+A).
(() => {
  const page = document.querySelector("[data-demo-page]");
  if (!page) return;
  const html = document.documentElement;
  const els = [...page.querySelectorAll("[data-tr]")];
  const DEMO_ATTR = "data-llmt-demo";

  let mode = "demo"; // demo → extension (one way)
  let state = "off"; // demo mode: off → on ⇄ hidden
  let demoHidden = false; // what the demo itself last set on html.llmt-hidden
  let queued = 0; // segments sent and waiting for their line
  let done = 0;

  // Same values as src/content/index.ts.
  const VIEWPORT_MARGIN = "600px 0px";
  const FLUSH_DELAY_MS = 120;

  // Same rule as chooseLayout() in src/content/segmenter.ts.
  function layoutFor(text) {
    const t = text.trim().replace(/\s+/g, " ");
    const cjk = (t.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) ?? []).length;
    if (cjk > t.length / 2) return t.length <= 16 ? "inline" : "block";
    const words = t.split(" ").length;
    return words <= 5 && t.length <= 48 && !/[.!?:;]\s/.test(t) ? "inline" : "block";
  }

  // Counts go in a mono span; the text is ours (digits and fixed words), not page input.
  function setChip(text, look) {
    const markup = text.replace(/\d+(?:\/\d+)?/g, '<span class="num">$&</span>');
    for (const s of document.querySelectorAll("[data-demo-state]")) if (s.innerHTML !== markup) s.innerHTML = markup;
    html.dataset.demo = look;
  }

  function render() {
    if (mode === "extension") return renderExtension();
    let on;
    if (queued > 0) on = UI.translating(done, done + queued);
    else if (done < els.length) on = UI.partial(done);
    else on = UI.translated(done);
    setChip({ ...UI.chip, on }[state], state);
    for (const b of document.querySelectorAll("[data-llmt-label]")) b.textContent = UI.button[state];
  }

  function setHidden(hidden) {
    demoHidden = hidden;
    html.classList.toggle("llmt-hidden", hidden);
  }

  // Like the extension: a segment is queued with a "…" placeholder once it
  // comes within VIEWPORT_MARGIN of the viewport; the queue is flushed as one
  // batch shortly after, and the batch's lines stream back one by one.
  let batch = [];
  let flushTimer;
  const lineTimers = new Set();
  function enqueue(el) {
    const node = document.createElement("llmt-translation");
    node.setAttribute("translate", "no");
    node.setAttribute(DEMO_ATTR, "");
    node.className = `llmt-${layoutFor(el.textContent)} llmt-pending`;
    node.textContent = "…";
    el.appendChild(node);
    batch.push([el, node]);
    queued++;
    flushTimer ??= setTimeout(flush, FLUSH_DELAY_MS);
  }
  function flush() {
    flushTimer = undefined;
    let t = 300; // first-line latency
    for (const [el, node] of batch) {
      t += 70 + Math.random() * 160;
      const id = setTimeout(() => {
        lineTimers.delete(id);
        node.classList.remove("llmt-pending");
        node.textContent = el.dataset.tr;
        queued--;
        done++;
        render();
        if (queued === 0) announce(UI.translated(done));
      }, t);
      lineTimers.add(id);
    }
    batch = [];
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        // While off or hidden, keep observing so segments are picked up later.
        if (!entry.isIntersecting || state !== "on") continue;
        io.unobserve(entry.target);
        enqueue(entry.target);
      }
      render();
    },
    { rootMargin: VIEWPORT_MARGIN },
  );

  // A touch visitor taps the button above the mock page; make sure the mock
  // text is on screen so they see the translations arrive.
  function bringIntoView() {
    const r = els[0].getBoundingClientRect();
    if (r.top >= 0 && r.top < innerHeight * 0.6) return;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.getElementById("demo").scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
  }

  function toggle() {
    if (mode !== "demo") return;
    if (state === "off") {
      state = "on";
      announce(UI.sayTranslating);
      for (const el of els) io.observe(el);
    } else if (state === "on") {
      state = "hidden";
      setHidden(true);
      announce(UI.sayHidden);
    } else {
      state = "on";
      setHidden(false);
      announce(UI.sayShown);
      // Re-observe what is still waiting, so segments scrolled near while
      // hidden get an intersection callback now.
      for (const el of els) {
        if (el.querySelector(`llmt-translation[${DEMO_ATTR}]`)) continue;
        io.unobserve(el);
        io.observe(el);
      }
    }
    render();
  }

  // ---- Extension mode ------------------------------------------------------
  // The real extension's nodes carry no DEMO_ATTR, and it flips
  // html.llmt-hidden on its own. Either sign means the visitor's installed
  // extension is now translating the page with their own key. It translates
  // the whole page; the chip counts the mock article only.
  const foreignNodes = (root) => [...root.querySelectorAll(`llmt-translation:not([${DEMO_ATTR}])`)];
  const isPending = (n) => n.classList.contains("llmt-pending");
  const extensionPresent = () => foreignNodes(document).length > 0 || html.classList.contains("llmt-hidden") !== demoHidden;

  let lastPhase = "";
  let intro = ""; // said once, together with the first phase
  function renderExtension() {
    const nodes = foreignNodes(page);
    const pending = nodes.filter(isPending).length;
    const failed = nodes.filter((n) => n.classList.contains("llmt-error")).length;
    // The extension queues every on-screen segment, article included, in one
    // pass. Nothing in the article once the rest has settled means it had
    // nothing to translate: the article is already in the target language.
    const settled = (all) => all.length > 0 && !all.some(isPending);
    let phase, text;
    if (html.classList.contains("llmt-hidden")) [phase, text] = ["hidden", UI.chip.hidden];
    else if (nodes.length === 0 && settled(foreignNodes(document))) [phase, text] = ["same", UI.ext.same];
    else if (pending > 0 || nodes.length === 0) [phase, text] = ["translating", nodes.length ? UI.translating(nodes.length - pending, nodes.length) : UI.sayTranslating];
    else if (failed > 0) [phase, text] = ["failed", UI.failed(failed)];
    else [phase, text] = ["done", UI.translated(nodes.length)];
    setChip(text, phase === "hidden" ? "hidden" : "on");
    if (phase !== lastPhase) {
      lastPhase = phase;
      announce(
        intro +
        {
          translating: UI.ext.translating,
          done: UI.ext.done(nodes.length),
          failed: UI.ext.failed(failed),
          same: UI.ext.saySame,
          hidden: UI.sayHidden,
        }[phase],
      );
      intro = "";
    }
  }

  function enterExtensionMode() {
    mode = "extension";
    io.disconnect();
    clearTimeout(flushTimer);
    for (const id of lineTimers) clearTimeout(id);
    lineTimers.clear();
    batch = [];
    // Drop the demo's own lines so no paragraph shows two translations.
    for (const n of document.querySelectorAll(`llmt-translation[${DEMO_ATTR}]`)) n.remove();
    html.dataset.ext = "";
    const hadFocus = document.activeElement?.closest?.("[data-llmt-toggle]");
    for (const b of document.querySelectorAll("[data-llmt-toggle]")) b.hidden = true;
    for (const h of document.querySelectorAll("[data-ext-hint]")) h.hidden = false;
    const note = document.querySelector("[data-ext-note]");
    note.hidden = false;
    if (hadFocus) note.focus();
    intro = UI.ext.intro;
    renderExtension();
  }

  const mo = new MutationObserver(() => {
    if (mode === "demo") {
      if (extensionPresent()) enterExtensionMode();
    } else renderExtension();
  });
  mo.observe(html, { attributes: true, attributeFilter: ["class"] });
  // The whole body, since the extension writes anywhere outside translate="no".
  // The callback's own chip and live-region writes come back here once and stop:
  // setChip skips identical markup and announce() runs only on a phase change.
  mo.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class"] });

  addEventListener("keydown", (e) => {
    // e.code, not e.key: ⌥A on macOS types "å".
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === "KeyA") {
      if (mode !== "demo") return;
      e.preventDefault();
      toggle();
    }
  });
  document.addEventListener("click", (e) => {
    if (e.target.closest?.("[data-llmt-toggle]")) {
      if (state === "off") bringIntoView();
      toggle();
    }
    // Links on the mock site go nowhere.
    if (e.target.closest?.("[data-demo-page] a")) e.preventDefault();
  });

  if (extensionPresent()) enterExtensionMode();
  else render();
})();

// Simulated YouTube bilingual subtitles (Alt+S). Uses the extension's overlay
// DOM; html.llmt-yt-on makes content.css hide the player's own captions.
(() => {
  const player = document.getElementById("movie_player");
  if (!player) return;
  // Each cue is a <p> in the page's template: the original as its text, the
  // translation in data-tr.
  const cues = [...player.querySelector("template[data-yt-cues]").content.querySelectorAll("[data-tr]")].map((p) => [p.textContent, p.dataset.tr]);
  const $ = (id) => document.getElementById(id);
  const overlay = player.querySelector(".llmt-yt-overlay");
  let i = 0, on = false, sec = 12, tick = 0;

  function show() {
    const [src, tr] = cues[i];
    $("yt-native").textContent = src;
    $("yt-src").textContent = src;
    $("yt-tr").textContent = tr;
  }
  show();

  // Auto-advancing content needs a pause control (WCAG 2.2.2), and starts
  // paused for people who asked for reduced motion.
  let playing = !matchMedia("(prefers-reduced-motion: reduce)").matches;
  const pp = player.querySelector("[data-yt-play]");
  function setPlaying(p) {
    playing = p;
    pp.textContent = p ? "❚❚" : "▶";
    pp.setAttribute("aria-label", p ? UI.pause : UI.play);
  }
  setPlaying(playing);
  pp.addEventListener("click", () => setPlaying(!playing));
  // Ticks every 0.5 s and a cue lasts 1.5 s: faster than real time, so the
  // mock reads as a playing video rather than a still.
  setInterval(() => {
    if (!playing) return;
    sec++;
    $("yt-time").textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")} / 8:40`;
    $("yt-prog").style.width = `${(sec / 520) * 100}%`;
    if (++tick % 3 === 0) { i = (i + 1) % cues.length; show(); }
  }, 500);

  function render() {
    document.documentElement.classList.toggle("llmt-yt-on", on);
    overlay.hidden = !on;
    const k = on ? "on" : "off";
    for (const b of document.querySelectorAll("[data-yt-label]")) b.textContent = UI.ytButton[k];
    for (const s of document.querySelectorAll("[data-yt-state]")) s.textContent = UI.ytState[k];
  }
  function toggle() {
    on = !on;
    render();
    announce(UI.ytSay[on ? "on" : "off"]);
  }
  // Starts on, so visitors see bilingual captions without pressing anything.
  on = true;
  render();
  addEventListener("keydown", (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === "KeyS") {
      e.preventDefault();
      toggle();
    }
  });
  document.addEventListener("click", (e) => { if (e.target.closest?.("[data-yt-toggle]")) toggle(); });
})();
