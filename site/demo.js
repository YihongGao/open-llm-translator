// Simulated Open LLM Translator for the landing page.
// Same DOM and CSS as the real extension (public/content.css): an
// <llmt-translation> node inside the original element, "…" + .llmt-pending while
// waiting, html.llmt-hidden to show the original only. No network, no LLM:
// translations come from each element's data-zh attribute.
//
// A visitor who has the real extension installed owns Alt+A through
// chrome.commands, so the page never sees that keydown and the real extension
// translates the mock article instead. The demo watches for that and hands over
// (see "Extension mode" below).

// Chrome on macOS reports "macOS" in userAgentData.platform and "MacIntel" in
// navigator.platform; check both, case-insensitively.
const mac = /mac/i.test(`${navigator.userAgentData?.platform ?? ""} ${navigator.platform ?? ""}`);
for (const k of document.querySelectorAll("[data-alt]")) {
  if (mac) k.innerHTML = '<span aria-hidden="true">⌥</span><span class="sr-only">Option</span>';
}

// Screen-reader announcements through the page's polite live region.
function announce(msg) {
  const r = document.querySelector("[data-llmt-status]");
  if (r) r.textContent = msg;
}

// Until the Chrome Web Store listing is live, the install buttons point at
// #chrome-web-store and say so instead of going nowhere. Setting their href to
// the listing URL turns this off.
(() => {
  const toast = document.querySelector("[data-store-toast]");
  let timer;
  document.addEventListener("click", (e) => {
    if (!e.target.closest?.('a[href="#chrome-web-store"]')) return;
    e.preventDefault();
    toast.hidden = false;
    toast.textContent = "Chrome 線上應用程式商店上架中，上架後這個按鈕就能直接安裝。";
    clearTimeout(timer);
    timer = setTimeout(() => { toast.hidden = true; }, 5000);
  });
})();

// Page translation (Alt+A).
(() => {
  const page = document.querySelector("[data-demo-page]");
  if (!page) return;
  const html = document.documentElement;
  const els = [...page.querySelectorAll("[data-zh]")];
  const DEMO_ATTR = "data-llmt-demo";

  let mode = "demo"; // demo → extension (one way)
  let state = "off"; // demo mode: off → on ⇄ hidden
  let demoHidden = false; // what the demo itself last set on html.llmt-hidden
  let queued = 0; // segments sent and waiting for their line
  let done = 0;

  // Same values as src/content/index.ts.
  const VIEWPORT_MARGIN = "600px 0px";
  const FLUSH_DELAY_MS = 120;

  // Same rule as layoutFor() in src/content/segmenter.ts.
  function layoutFor(text) {
    const t = text.trim().replace(/\s+/g, " ");
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
    if (queued > 0) on = `翻譯中 ${done}/${done + queued}`;
    else if (done < els.length) on = `已翻譯 ${done} 段，往下捲會接著翻`;
    else on = `已翻譯 ${done} 段`;
    setChip({ off: "尚未翻譯", on, hidden: "只顯示原文" }[state], state);
    for (const b of document.querySelectorAll("[data-llmt-label]"))
      b.textContent = { off: "翻譯這篇", on: "只看原文", hidden: "顯示譯文" }[state];
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
        node.textContent = el.dataset.zh;
        queued--;
        done++;
        render();
        if (queued === 0) announce(`已翻譯 ${done} 段`);
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
      announce("翻譯中");
      for (const el of els) io.observe(el);
    } else if (state === "on") {
      state = "hidden";
      setHidden(true);
      announce("已隱藏譯文，只顯示原文");
    } else {
      state = "on";
      setHidden(false);
      announce("已顯示譯文");
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
  // extension is now translating the mock article with their own key.
  const foreignNodes = () => document.querySelectorAll(`llmt-translation:not([${DEMO_ATTR}])`);
  const extensionPresent = () => foreignNodes().length > 0 || html.classList.contains("llmt-hidden") !== demoHidden;

  let lastPhase = "";
  let intro = ""; // said once, together with the first phase
  function renderExtension() {
    const nodes = [...foreignNodes()];
    const pending = nodes.filter((n) => n.classList.contains("llmt-pending")).length;
    const failed = nodes.filter((n) => n.classList.contains("llmt-error")).length;
    let phase, text;
    if (html.classList.contains("llmt-hidden")) [phase, text] = ["hidden", "只顯示原文"];
    else if (pending > 0 || nodes.length === 0) [phase, text] = ["translating", nodes.length ? `翻譯中 ${nodes.length - pending}/${nodes.length}` : "翻譯中"];
    else if (failed > 0) [phase, text] = ["failed", `${failed} 段翻譯失敗`];
    else [phase, text] = ["done", `已翻譯 ${nodes.length} 段`];
    setChip(text, phase === "hidden" ? "hidden" : "on");
    if (phase !== lastPhase) {
      lastPhase = phase;
      announce(
        intro +
        {
          translating: "你的擴充功能翻譯中",
          done: `你的擴充功能已翻譯 ${nodes.length} 段`,
          failed: `你的擴充功能有 ${failed} 段翻譯失敗`,
          hidden: "已隱藏譯文，只顯示原文",
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
    intro = "偵測到你安裝的 Open LLM Translator，現在由它用你的 API key 翻譯這篇示範文章。";
    renderExtension();
  }

  const mo = new MutationObserver(() => {
    if (mode === "demo") {
      if (extensionPresent()) enterExtensionMode();
    } else renderExtension();
  });
  mo.observe(html, { attributes: true, attributeFilter: ["class"] });
  // Only the mock article: everything else is translate="no", so the real
  // extension never writes there, and the chip and live region (which this
  // observer's own callback updates) stay out of the loop.
  mo.observe(page, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class"] });

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
  const cues = [
    ["Twice a year, the keeper climbs all 214 steps to clean the lens by hand.", "每年兩次，看守人爬完全部 214 級階梯，親手擦亮透鏡。"],
    ["A single fingerprint can scatter the beam and cut its range by a mile.", "一枚指紋就可能讓光束散開，照射距離少掉一英里。"],
    ["So the cloth is cotton, the water is distilled, and nobody rushes.", "所以布用棉布，水用蒸餾水，而且沒有人趕時間。"],
    ["By dusk, the light reaches ships nineteen miles out at sea.", "到了黃昏，燈光能照到十九英里外海上的船。"],
  ];
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
    pp.setAttribute("aria-label", p ? "暫停示範影片" : "播放示範影片");
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
    for (const b of document.querySelectorAll("[data-yt-label]")) b.textContent = on ? "關閉雙語字幕" : "開啟雙語字幕";
    for (const s of document.querySelectorAll("[data-yt-state]")) s.textContent = on ? "雙語字幕：開" : "雙語字幕：關";
  }
  function toggle() {
    on = !on;
    render();
    announce(on ? "已開啟雙語字幕" : "已關閉雙語字幕");
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
