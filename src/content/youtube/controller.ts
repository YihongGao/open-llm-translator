// Bilingual YouTube subtitles: the content-script side.
//
// Flow: the page hook (main world) forwards the caption response the player
// downloads -> chooseSource() picks the track to translate -> cues are merged
// into sentences -> planRefill() decides which sentences to translate as
// playback advances -> batches go to the background worker over their own
// Port (the same protocol and cache as page translation) -> the overlay shows
// the sentence under the playhead with its translation.
//
// Independent from page translation: either can be on without the other.

import { PORT_NAME, type TranslateEvent, type TranslateRequest } from "../../shared/messages";
import { TARGET_LANGUAGES } from "../../shared/settings";
import {
  YT_COMMAND_EVENT,
  YT_HOOK_EVENT,
  parseHookEvent,
  type HookCommand,
  type HookEvent,
  type PlayerInfo,
} from "../../shared/youtube-bridge";
import { isSameText } from "../segmenter";
import { showToast } from "../toast";
import { chooseSource, mergeSentences, parseJson3, type Sentence } from "./captions";
import { SUBTITLES_ON_CLASS, SubtitleOverlay } from "./overlay";
import { DEFAULT_REFILL, planRefill, sentenceAt, type RefillOptions, type SentenceStatus } from "./refill";

// Same batch limits as page translation.
const MAX_BATCH_CHARS = 3000;
const MAX_BATCH_SEGMENTS = 40;
const MAX_TITLE_CHARS = 200;
const MAX_RETRIES = 1;
/** How long to wait for the hook to answer a command. */
const HOOK_TIMEOUT_MS = 5000;
/** How long to wait for the player's caption request before saying so. */
const CAPTION_WAIT_MS = 8000;
/** After navigating to another video, how long the player gets to request captions on its own. */
const NAVIGATION_GRACE_MS = 3000;

interface Line extends Sentence {
  status: SentenceStatus;
  translation?: string;
  retries: number;
}

interface Capture {
  videoId: string;
  url: string;
  body: string;
}

export interface SubtitleController {
  isActive(): boolean;
  enable(targetLang: string): void;
  disable(): void;
  setLanguage(targetLang: string): void;
}

export interface SubtitleOptions {
  refill?: RefillOptions;
}

export function createSubtitleController(opts: SubtitleOptions = {}): SubtitleController {
  const refillOpts = opts.refill ?? DEFAULT_REFILL;
  let active = false;
  let targetLang = "zh-TW";

  /** Sentences of the video on screen; empty while nothing is loaded. */
  let lines: Line[] = [];
  /** Video and language `lines` belong to. */
  let linesVideo: string | null = null;
  let linesLang: string | null = null;
  /** Bumped whenever `lines` is replaced; replies tagged with an older generation are dropped. */
  let gen = 0;
  let nextBatch = 0;

  /** Last caption response from the player, and its identity for de-duplication (the player repeats requests). */
  let lastCapture: Capture | null = null;
  let captureKey: string | null = null;

  let port: chrome.runtime.Port | null = null;
  const overlay = new SubtitleOverlay();
  const shownErrors = new Set<string>();
  let waitTimer: number | undefined;
  let frame = 0;
  let boundVideo: HTMLVideoElement | null = null;

  // --- page hook bridge -------------------------------------------------------

  let nextRequest = 0;
  const waiting = new Map<number, (ev: HookEvent) => void>();

  function command(cmd: HookCommand): void {
    document.dispatchEvent(new CustomEvent(YT_COMMAND_EVENT, { detail: JSON.stringify(cmd) }));
  }

  function request(make: (id: number) => HookCommand): Promise<HookEvent | null> {
    const id = ++nextRequest;
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        waiting.delete(id);
        resolve(null);
      }, HOOK_TIMEOUT_MS);
      waiting.set(id, (ev) => {
        window.clearTimeout(timer);
        resolve(ev);
      });
      command(make(id));
    });
  }

  async function playerInfo(enable = false): Promise<PlayerInfo | null> {
    const ev = await request((id) => ({ cmd: enable ? "enable" : "info", id }));
    return ev?.type === "info" ? ev.info : null;
  }

  document.addEventListener(YT_HOOK_EVENT, (e) => {
    const ev = parseHookEvent((e as CustomEvent).detail);
    if (!ev) return;
    if (ev.type === "captions") {
      onCaptions(ev);
      return;
    }
    const resolve = waiting.get(ev.id);
    if (!resolve) return;
    waiting.delete(ev.id);
    resolve(ev);
  });

  // --- page state -------------------------------------------------------------

  const player = () => document.getElementById("movie_player");
  const video = () =>
    player()?.querySelector<HTMLVideoElement>("video.html5-main-video") ??
    player()?.querySelector<HTMLVideoElement>("video") ??
    null;
  /** During an ad the video element plays the ad, so its time is not the video's. */
  const inAd = () => {
    const p = player();
    return !!p && (p.classList.contains("ad-showing") || p.querySelector(".ytp-ad-player-overlay") !== null);
  };
  const currentVideoId = () => (location.pathname === "/watch" ? new URLSearchParams(location.search).get("v") : null);
  const langLabel = (tag: string) => TARGET_LANGUAGES.find((l) => l.tag === tag)?.label ?? tag;

  function notify(message: string, detail?: string, settings = false): void {
    showToast({
      message,
      detail,
      action: settings
        ? { label: "開啟設定", onClick: () => void chrome.runtime.sendMessage({ type: "llmt-open-options" }) }
        : undefined,
      autoHideMs: settings ? undefined : 8000,
    });
  }

  function clearWait(): void {
    window.clearTimeout(waitTimer);
    waitTimer = undefined;
  }

  // --- loading captions ---------------------------------------------------------

  /** Asks the player for captions and reports if none arrive. */
  async function requestCaptions(): Promise<void> {
    const info = await playerInfo();
    if (!active) return;
    if (!info) {
      notify("無法連接 YouTube 播放器", "重新整理頁面後再開啟雙語字幕。");
      return;
    }
    if (!currentVideoId()) return; // not a video page: wait for navigation
    if (info.isLive) {
      notify("還不支援直播的字幕");
      return;
    }
    if (info.tracks.length === 0) {
      notify("這部影片沒有字幕");
      return;
    }
    command({ cmd: "request-captions" });
    clearWait();
    const expected = currentVideoId();
    waitTimer = window.setTimeout(() => {
      waitTimer = undefined;
      if (active && linesVideo !== expected && lastCapture?.videoId !== expected)
        notify("沒有收到 YouTube 字幕", "試著在播放器按 CC 開啟字幕，或重新整理頁面。");
    }, CAPTION_WAIT_MS);
  }

  function onCaptions(cap: Capture): void {
    if (!active || cap.videoId !== currentVideoId()) return;
    const u = new URL(cap.url);
    const key = [cap.videoId, ...["lang", "kind", "tlang"].map((k) => u.searchParams.get(k) ?? "")].join("|");
    if (key === captureKey) return;
    captureKey = key;
    lastCapture = cap;
    clearWait();
    void loadFrom(cap);
  }

  async function loadFrom(cap: Capture): Promise<void> {
    const info = await playerInfo();
    const decision = chooseSource(cap.url, info?.tracks ?? [], targetLang, location.href);
    if (!active || cap !== lastCapture) return;
    if (decision.kind === "already-target") {
      clearLines();
      notify(
        `字幕已經是${langLabel(targetLang)}，不需要翻譯`,
        "要翻譯其他語言的字幕，請在 YouTube 的字幕選單選擇該語言。",
      );
      return;
    }
    let body = cap.body;
    if (decision.kind === "fetch") {
      const res = await request((id) => ({ cmd: "fetch", id, url: decision.url }));
      if (!active || cap !== lastCapture) return;
      if (res?.type !== "fetched" || res.body === null) {
        const status = res?.type === "fetched" && res.status ? `（HTTP ${res.status}）` : "";
        notify(`無法取得原文字幕${status}`, "可在 YouTube 字幕選單改選原文語言後再試一次。");
        return;
      }
      body = res.body;
    }
    const sentences = mergeSentences(parseJson3(body));
    if (sentences.length === 0) {
      notify("字幕內容是空的");
      return;
    }
    setLines(cap.videoId, sentences);
  }

  function setLines(videoId: string, sentences: Sentence[]): void {
    abortInFlight();
    gen++;
    lines = sentences.map((s) => ({ ...s, status: "idle", retries: 0 }));
    linesVideo = videoId;
    linesLang = targetLang;
    document.documentElement.classList.add(SUBTITLES_ON_CLASS);
    bindVideo();
    update();
  }

  function clearLines(): void {
    abortInFlight();
    gen++;
    lines = [];
    linesVideo = linesLang = null;
    overlay.hide();
    document.documentElement.classList.remove(SUBTITLES_ON_CLASS);
  }

  // --- translation --------------------------------------------------------------

  function refill(): void {
    const v = boundVideo;
    if (!active || !v || lines.length === 0 || inAd()) return;
    const picked = planRefill(lines, v.currentTime * 1000, refillOpts);
    if (picked.length === 0) return;
    for (const i of picked) lines[i]!.status = "queued";
    send(picked);
  }

  function send(indices: number[]): void {
    let i = 0;
    while (i < indices.length) {
      const batch: number[] = [];
      let chars = 0;
      while (i < indices.length && batch.length < MAX_BATCH_SEGMENTS) {
        const len = lines[indices[i]!]!.text.length;
        if (batch.length > 0 && chars + len > MAX_BATCH_CHARS) break;
        batch.push(indices[i]!);
        chars += len;
        i++;
      }
      for (const j of batch) lines[j]!.status = "pending";
      const req: TranslateRequest = {
        type: "translate",
        batchId: `s${nextBatch++}`,
        segments: batch.map((j) => ({ id: `${gen}:${j}`, text: lines[j]!.text })),
        targetLang,
        page: { title: [...document.title].slice(0, MAX_TITLE_CHARS).join(""), url: location.href },
      };
      getPort().postMessage(req);
    }
  }

  function getPort(): chrome.runtime.Port {
    if (port) return port;
    const p = chrome.runtime.connect({ name: PORT_NAME });
    p.onMessage.addListener(onEvent);
    p.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (port === p) port = null;
      // The worker was suspended or reloaded mid-request: retry once.
      for (const line of lines) {
        if (line.status !== "pending") continue;
        if (line.retries < MAX_RETRIES) {
          line.retries++;
          line.status = "idle";
        } else line.status = "error";
      }
      refill();
    });
    port = p;
    return p;
  }

  /** Stops paying for translations nobody will see (new video, subtitles off). */
  function abortInFlight(): void {
    port?.disconnect(); // our own disconnect() does not fire our onDisconnect
    port = null;
    for (const line of lines) if (line.status === "pending" || line.status === "queued") line.status = "idle";
  }

  function lineOf(id: string): Line | undefined {
    const [g, i] = id.split(":");
    return Number(g) === gen ? lines[Number(i)] : undefined;
  }

  function onEvent(ev: TranslateEvent): void {
    if (ev.type === "segment") {
      const line = lineOf(ev.id);
      if (!line) return;
      line.status = "done";
      line.translation = ev.text;
      update();
    } else if (ev.type === "segment-error") {
      for (const id of ev.ids) {
        const line = lineOf(id);
        if (line) line.status = "error";
      }
      if (ev.scope === "page" && !shownErrors.has(ev.message)) {
        shownErrors.add(ev.message);
        notify(`字幕翻譯失敗：${ev.message}`, "修正後，關閉再開啟雙語字幕即可重試。", ev.settings);
      }
    }
  }

  // --- display --------------------------------------------------------------------

  function render(): void {
    const p = player();
    const v = boundVideo;
    if (!active || !p || !v || lines.length === 0 || inAd()) {
      overlay.hide();
      return;
    }
    overlay.attach(p);
    const i = sentenceAt(lines, v.currentTime * 1000);
    if (i === -1) {
      overlay.hide();
      return;
    }
    const line = lines[i]!;
    const translated =
      line.status === "done" && line.translation && !isSameText(line.translation, line.text) ? line.translation : null;
    overlay.show(line.text, translated);
  }

  function update(): void {
    render();
    refill();
  }

  // timeupdate fires about every 250 ms; while playing, a frame loop keeps the
  // subtitles in step with speech.
  function loop(): void {
    render();
    frame = boundVideo && !boundVideo.paused && active ? requestAnimationFrame(loop) : 0;
  }
  const startLoop = () => {
    if (!frame) frame = requestAnimationFrame(loop);
  };
  const stopLoop = () => {
    cancelAnimationFrame(frame);
    frame = 0;
  };

  const videoListeners: Array<[string, () => void]> = [
    ["timeupdate", update],
    ["seeked", update],
    ["play", startLoop],
    ["pause", () => (stopLoop(), render())],
  ];

  function bindVideo(): void {
    const v = video();
    if (v === boundVideo) return;
    unbindVideo();
    if (!v) return;
    boundVideo = v;
    for (const [name, fn] of videoListeners) v.addEventListener(name, fn);
    if (!v.paused) startLoop();
  }

  function unbindVideo(): void {
    stopLoop();
    if (!boundVideo) return;
    for (const [name, fn] of videoListeners) boundVideo.removeEventListener(name, fn);
    boundVideo = null;
  }

  // --- navigation -----------------------------------------------------------------

  // YouTube is a single-page app: moving to another video keeps this document
  // (and the page hook) alive. With CC on, the player requests the new video's
  // captions itself; otherwise ask for them after a short grace period.
  let navTimer: number | undefined;
  document.addEventListener("yt-navigate-finish", () => {
    if (!active) return;
    const id = currentVideoId();
    if (id && id === linesVideo) return;
    clearLines();
    // The new video's captions may already have arrived (and be loading).
    if (!id || lastCapture?.videoId !== id) {
      captureKey = null;
      lastCapture = null;
    }
    clearWait();
    window.clearTimeout(navTimer);
    if (!id) return;
    navTimer = window.setTimeout(() => {
      if (active && currentVideoId() === id && lastCapture?.videoId !== id) void requestCaptions();
    }, NAVIGATION_GRACE_MS);
  });

  // --- public API -------------------------------------------------------------------

  async function enable(lang: string): Promise<void> {
    active = true;
    targetLang = lang;
    shownErrors.clear();
    const info = await playerInfo(true);
    if (!active) return;
    if (!info) {
      notify("無法連接 YouTube 播放器", "重新整理頁面後再開啟雙語字幕。");
      return;
    }
    const id = currentVideoId();
    if (id && id === linesVideo && linesLang === lang) {
      // Turned back on for the same video: keep the translations, retry failures.
      for (const line of lines) if (line.status === "error") (line.status = "idle"), (line.retries = 0);
      document.documentElement.classList.add(SUBTITLES_ON_CLASS);
      bindVideo();
      update();
      return;
    }
    if (id && lastCapture?.videoId === id) {
      void loadFrom(lastCapture);
      return;
    }
    void requestCaptions();
  }

  function disable(): void {
    active = false;
    command({ cmd: "disable" });
    clearWait();
    window.clearTimeout(navTimer);
    abortInFlight();
    unbindVideo();
    overlay.hide();
    document.documentElement.classList.remove(SUBTITLES_ON_CLASS);
  }

  return {
    isActive: () => active,
    enable: (lang) => void enable(lang),
    disable,
    setLanguage(lang) {
      if (lang === targetLang) return;
      targetLang = lang;
      if (!active) return; // enable() compares linesLang and reloads
      shownErrors.clear();
      if (lastCapture) void loadFrom(lastCapture);
    },
  };
}
