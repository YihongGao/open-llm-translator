// Wire protocol between the YouTube page hook (page main world, see
// src/page/youtube-hook.ts) and the content script (isolated world).
//
// The two worlds share the DOM but not JavaScript objects, so messages travel
// as CustomEvents on `document` whose detail is a JSON string (primitives
// cross the world boundary; objects do not). The page can read and forge
// these events, so the receiving side validates everything and treats caption
// text as untrusted page content, like any other text on the page.

/** Content script -> hook. */
export const YT_COMMAND_EVENT = "llmt-yt-command";
/** Hook -> content script. */
export const YT_HOOK_EVENT = "llmt-yt-event";

export type HookCommand =
  | { cmd: "enable"; id: number }
  | { cmd: "disable" }
  | { cmd: "info"; id: number }
  /** Make the player request captions again (turns CC on, or off and on when already on). */
  | { cmd: "request-captions" }
  /** Fetch another caption track from the page's context (same origin, same cookies). */
  | { cmd: "fetch"; id: number; url: string };

export interface TrackInfo {
  /** YouTube language code, e.g. "en", "zh-TW". */
  lang: string;
  /** "asr" for automatic captions, null for uploaded ones. */
  kind: string | null;
  /** Signed track URL from the player response (relative or absolute). */
  baseUrl: string;
}

export interface PlayerInfo {
  videoId: string | null;
  isLive: boolean;
  tracks: TrackInfo[];
}

export type HookEvent =
  | { type: "info"; id: number; info: PlayerInfo }
  /** A caption response the main player fetched itself. */
  | { type: "captions"; videoId: string; url: string; body: string }
  | { type: "fetched"; id: number; status: number; body: string | null };

/** Largest caption body accepted (a 3-hour talk is about 1 MB of json3). */
export const MAX_CAPTION_BYTES = 8_000_000;

export function isTimedtextUrl(url: string, base: string): URL | null {
  try {
    const u = new URL(url, base);
    return u.origin === new URL(base).origin && u.pathname === "/api/timedtext" ? u : null;
  } catch {
    return null;
  }
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function parseTrack(v: unknown): TrackInfo | null {
  if (!v || typeof v !== "object") return null;
  const t = v as Record<string, unknown>;
  if (!isStr(t.lang) || !isStr(t.baseUrl) || !(t.kind === null || isStr(t.kind))) return null;
  return { lang: t.lang, kind: t.kind, baseUrl: t.baseUrl };
}

/** Parses and validates an event detail from the hook; null when malformed. */
export function parseHookEvent(detail: unknown): HookEvent | null {
  if (!isStr(detail) || detail.length > MAX_CAPTION_BYTES * 2) return null;
  let v: unknown;
  try {
    v = JSON.parse(detail);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const e = v as Record<string, unknown>;
  switch (e.type) {
    case "captions":
      return isStr(e.videoId) && isStr(e.url) && isStr(e.body) && e.body.length <= MAX_CAPTION_BYTES
        ? { type: "captions", videoId: e.videoId, url: e.url, body: e.body }
        : null;
    case "fetched":
      return isNum(e.id) && isNum(e.status) && (e.body === null || (isStr(e.body) && e.body.length <= MAX_CAPTION_BYTES))
        ? { type: "fetched", id: e.id, status: e.status, body: e.body }
        : null;
    case "info": {
      const info = e.info as Record<string, unknown> | undefined;
      if (!isNum(e.id) || !info || !Array.isArray(info.tracks)) return null;
      const tracks = info.tracks.map(parseTrack);
      if (tracks.some((t) => t === null)) return null;
      return {
        type: "info",
        id: e.id,
        info: {
          videoId: isStr(info.videoId) ? info.videoId : null,
          isLive: info.isLive === true,
          tracks: tracks as TrackInfo[],
        },
      };
    }
    default:
      return null;
  }
}

/** Parses a command from the content script; null when malformed. */
export function parseHookCommand(detail: unknown): HookCommand | null {
  if (!isStr(detail) || detail.length > 10_000) return null;
  let v: unknown;
  try {
    v = JSON.parse(detail);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const c = v as Record<string, unknown>;
  switch (c.cmd) {
    case "enable":
    case "info":
      return isNum(c.id) ? { cmd: c.cmd, id: c.id } : null;
    case "disable":
    case "request-captions":
      return { cmd: c.cmd };
    case "fetch":
      return isNum(c.id) && isStr(c.url) ? { cmd: "fetch", id: c.id, url: c.url } : null;
    default:
      return null;
  }
}

/** True for www.youtube.com/watch pages, the only place subtitles are offered. */
export function isYouTubeWatchUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.hostname === "www.youtube.com" && u.pathname === "/watch";
  } catch {
    return false;
  }
}

export function isYouTubeUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).hostname === "www.youtube.com";
  } catch {
    return false;
  }
}
