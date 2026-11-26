// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://www.youtube.com/watch?v=vid1" }
// Drives the subtitle controller against a fake page hook (the main-world
// script) and a fake background Port: enable -> captions -> translate -> show.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TranslateEvent, TranslateRequest } from "../src/shared/messages";
import { YT_COMMAND_EVENT, YT_HOOK_EVENT, type HookCommand, type TrackInfo } from "../src/shared/youtube-bridge";

// --- fake background ---------------------------------------------------------
const posted: TranslateRequest[] = [];
let toPage: ((ev: TranslateEvent) => void) | null = null;
let disconnects = 0;
(globalThis as unknown as { chrome: unknown }).chrome = {
  runtime: {
    connect: () => ({
      postMessage: (m: TranslateRequest) => posted.push(m),
      onMessage: { addListener: (fn: (ev: TranslateEvent) => void) => (toPage = fn) },
      onDisconnect: { addListener: () => {} },
      disconnect: () => disconnects++,
    }),
    sendMessage: () => {},
    lastError: undefined,
  },
};

// --- fake page hook ----------------------------------------------------------
const track = (lang: string, kind: string | null = null): TrackInfo => ({
  lang,
  kind,
  baseUrl: `/api/timedtext?v=${currentVideo()}&lang=${lang}${kind ? `&kind=${kind}` : ""}`,
});
let tracks: TrackInfo[] = [];
/** Language the fake player picks when asked for captions. */
let playerLang = "en";
const bodies = new Map<string, string>();
const commands: HookCommand[] = [];
const currentVideo = () => new URLSearchParams(location.search).get("v") ?? "";

const emit = (ev: unknown) => document.dispatchEvent(new CustomEvent(YT_HOOK_EVENT, { detail: JSON.stringify(ev) }));
document.addEventListener(YT_COMMAND_EVENT, (e) => {
  const cmd = JSON.parse((e as CustomEvent).detail) as HookCommand;
  commands.push(cmd);
  const v = currentVideo();
  switch (cmd.cmd) {
    case "enable":
    case "info":
      emit({ type: "info", id: cmd.id, info: { videoId: v, isLive: false, tracks } });
      break;
    case "request-captions": {
      const url = `https://www.youtube.com/api/timedtext?v=${v}&lang=${playerLang}&pot=P&c=WEB&fmt=json3`;
      setTimeout(() => emit({ type: "captions", videoId: v, url, body: bodies.get(`${v}|${playerLang}`) ?? "" }), 0);
      break;
    }
    case "fetch": {
      const lang = new URL(cmd.url, location.href).searchParams.get("lang");
      emit({ type: "fetched", id: cmd.id, status: 200, body: bodies.get(`${v}|${lang}`) ?? null });
      break;
    }
  }
});

const json3 = (lines: Array<[number, number, string]>) =>
  JSON.stringify({ events: lines.map(([s, d, t]) => ({ tStartMs: s, dDurationMs: d, segs: [{ utf8: t }] })) });

const EN = json3([
  [0, 2000, "Hello there,"],
  [2000, 2000, "how are you?"],
  [5000, 2000, "Fine."],
]);

// --- page --------------------------------------------------------------------
let videoEl: HTMLVideoElement;
function buildPlayer() {
  document.body.innerHTML = `
    <div id="movie_player" class="html5-video-player">
      <video class="html5-main-video"></video>
      <button class="ytp-subtitles-button" aria-pressed="false"></button>
      <div class="caption-window">native</div>
    </div>`;
  videoEl = document.querySelector("video")!;
}
function seek(ms: number) {
  Object.defineProperty(videoEl, "currentTime", { value: ms / 1000, configurable: true, writable: true });
  videoEl.dispatchEvent(new Event("timeupdate"));
}
const overlayText = () => {
  const o = document.querySelector<HTMLElement>(".llmt-yt-overlay");
  if (!o || o.hidden) return null;
  const tr = o.querySelector<HTMLElement>(".llmt-yt-tr")!;
  return { src: o.querySelector(".llmt-yt-src")!.textContent, tr: (tr.parentElement as HTMLElement).hidden ? null : tr.textContent };
};
const reply = (req: TranslateRequest, translate: (t: string) => string) => {
  for (const s of req.segments) toPage?.({ type: "segment", batchId: req.batchId, id: s.id, text: translate(s.text), source: "api" });
  toPage?.({ type: "batch-done", batchId: req.batchId });
};

const { createSubtitleController } = await import("../src/content/youtube/controller");

describe("subtitle controller", () => {
  let ctrl: ReturnType<typeof createSubtitleController>;

  beforeEach(() => {
    history.replaceState(null, "", "/watch?v=vid1");
    buildPlayer();
    posted.length = 0;
    commands.length = 0;
    playerLang = "en";
    tracks = [track("en"), track("en", "asr"), track("zh-TW")];
    bodies.clear();
    bodies.set("vid1|en", EN);
    ctrl = createSubtitleController();
  });
  afterEach(() => ctrl.disable());

  it("translates the player's captions and shows them bilingually", async () => {
    ctrl.enable("zh-TW");
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(commands.map((c) => c.cmd)).toContain("request-captions");
    expect(posted[0]!.targetLang).toBe("zh-TW");
    // Cues merged into sentences; short video, so everything at once.
    expect(posted[0]!.segments.map((s) => s.text)).toEqual(["Hello there, how are you?", "Fine."]);
    expect(document.documentElement.classList.contains("llmt-yt-on")).toBe(true);

    // Before the translation arrives: source only.
    expect(overlayText()).toEqual({ src: "Hello there, how are you?", tr: null });
    reply(posted[0]!, (t) => `ZH(${t})`);
    expect(overlayText()).toEqual({ src: "Hello there, how are you?", tr: "ZH(Hello there, how are you?)" });

    seek(4500); // between sentences
    expect(overlayText()).toBeNull();
    seek(5500);
    expect(overlayText()).toEqual({ src: "Fine.", tr: "ZH(Fine.)" });
  });

  it("switches to the original track when the player shows the target language", async () => {
    playerLang = "zh-TW";
    bodies.set("vid1|zh-TW", json3([[0, 1000, "你好。"]]));
    ctrl.enable("zh-TW");
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    const fetch = commands.find((c) => c.cmd === "fetch") as { url: string } | undefined;
    expect(new URL(fetch!.url, location.href).searchParams.get("lang")).toBe("en");
    expect(new URL(fetch!.url, location.href).searchParams.get("pot")).toBe("P");
    expect(posted[0]!.segments[0]!.text).toBe("Hello there, how are you?");
  });

  it("leaves videos already in the target language alone", async () => {
    playerLang = "zh-TW";
    tracks = [track("zh-TW"), track("en", "asr")];
    bodies.set("vid1|zh-TW", json3([[0, 1000, "你好。"]]));
    ctrl.enable("zh-TW");
    await vi.waitFor(() => expect(document.querySelector("llmt-toast")).not.toBeNull());
    expect(posted).toHaveLength(0);
    expect(document.documentElement.classList.contains("llmt-yt-on")).toBe(false);
  });

  it("ignores captions of other videos (hover previews)", async () => {
    ctrl.enable("zh-TW");
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    emit({ type: "captions", videoId: "preview", url: "https://www.youtube.com/api/timedtext?v=preview&lang=en", body: EN });
    emit({ type: "captions", videoId: "vid1", url: "https://www.youtube.com/api/timedtext?v=vid1&lang=en", body: EN });
    await new Promise((r) => setTimeout(r, 20));
    expect(posted).toHaveLength(1); // the duplicate request is ignored too
  });

  it("starts over on navigation to another video", async () => {
    ctrl.enable("zh-TW");
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    const before = disconnects;
    history.pushState(null, "", "/watch?v=vid2");
    document.dispatchEvent(new Event("yt-navigate-finish"));
    expect(overlayText()).toBeNull();
    expect(disconnects).toBe(before + 1); // in-flight translations of vid1 are cancelled
    // The player requests vid2's captions by itself (CC stays on).
    emit({
      type: "captions",
      videoId: "vid2",
      url: "https://www.youtube.com/api/timedtext?v=vid2&lang=en",
      body: json3([[0, 1000, "Second video."]]),
    });
    await vi.waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]!.segments[0]!.text).toBe("Second video.");
    // Late replies for vid1 are dropped.
    reply(posted[0]!, () => "stale");
    expect(overlayText()?.tr ?? null).toBeNull();
  });

  it("turns off cleanly and keeps translations for turning back on", async () => {
    ctrl.enable("zh-TW");
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    reply(posted[0]!, (t) => `ZH(${t})`);
    ctrl.disable();
    expect(ctrl.isActive()).toBe(false);
    expect(overlayText()).toBeNull();
    expect(document.documentElement.classList.contains("llmt-yt-on")).toBe(false);
    expect(commands.at(-1)).toEqual({ cmd: "disable" });

    ctrl.enable("zh-TW");
    await vi.waitFor(() => expect(overlayText()?.tr).toBe("ZH(Hello there, how are you?)"));
    expect(posted).toHaveLength(1); // nothing translated twice
  });

  it("re-translates on a language change", async () => {
    ctrl.enable("zh-TW");
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    ctrl.setLanguage("ja");
    await vi.waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]!.targetLang).toBe("ja");
  });
});
