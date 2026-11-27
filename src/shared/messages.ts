// Wire protocol between the content script and the background service worker.
// Content script opens one long-lived Port per page (PORT_NAME); translation
// results stream back segment by segment over that port.

import type { UiLanguageSetting } from "./i18n";

export const PORT_NAME = "llmt-translate";

export interface Segment {
  /** Page-unique id assigned by the content script. */
  id: string;
  /** Whitespace-normalised source text (single line). */
  text: string;
}

export interface PageContext {
  title: string;
  url: string;
}

// content -> background (over Port)
export interface TranslateRequest {
  type: "translate";
  batchId: string;
  segments: Segment[];
  /**
   * Language the page is being translated into. Carried per request rather
   * than read from storage, so a change made in another tab cannot switch a
   * page's language halfway through.
   */
  targetLang: string;
  page: PageContext;
}

// background -> content (over Port)
export type TranslateEvent =
  | {
      type: "segment";
      batchId: string;
      id: string;
      text: string;
      source: "cache" | "api";
      /** Set for cache hits; for API results the served model arrives on batch-done. */
      model?: string;
    }
  | {
      type: "segment-error";
      batchId: string;
      ids: string[];
      message: string;
      /**
       * "page": the whole request failed (missing/invalid key, rate limit,
       * network) and every segment will fail the same way, so the page shows
       * one notice. "segment": only these segments failed (refusal, cut off).
       */
      scope: "page" | "segment";
      /** The fix is in the options page (offer an "open settings" action). */
      settings: boolean;
      /**
       * UI language `message` was written in. The content script may have been
       * injected before the user changed the setting, so it adopts this before
       * wrapping the message, keeping the outer text in the message's language.
       */
      uiLanguage: UiLanguageSetting;
    }
  | {
      type: "batch-done";
      batchId: string;
      /** Present when the batch made an API call that completed. */
      servedModel?: string;
      fallback?: boolean;
    };

// extension -> content (chrome.tabs.sendMessage). Content scripts cannot read
// chrome.storage (toggleTab sets TRUSTED_CONTEXTS before injecting), so the settings they need
// travel with these messages. Each one is answered with a TabState.
/** The two things a tab can translate, toggled independently. */
export type Feature = "page" | "subtitles";

export interface ToggleMessage {
  type: "llmt-toggle";
  targetLang: string;
  /** The user's UI language choice, so the content script's strings (toasts, tooltips) match the options page. */
  uiLanguage: UiLanguageSetting;
  /** Defaults to "page". */
  feature?: Feature;
}
export interface StatusMessage {
  type: "llmt-status";
}
/** Target language changed in the popup: re-translate whatever is active. */
export interface SetLanguageMessage {
  type: "llmt-set-lang";
  targetLang: string;
  uiLanguage: UiLanguageSetting;
}
export type ContentMessage = ToggleMessage | StatusMessage | SetLanguageMessage;
export interface TabState {
  /** Page translation is on. */
  active: boolean;
  /** Bilingual subtitles are on; null where they are not offered (not YouTube). */
  subtitles: boolean | null;
}

// content -> background: content scripts cannot call openOptionsPage() themselves.
export interface OpenOptionsMessage {
  type: "llmt-open-options";
}

// any page -> background (chrome.runtime.sendMessage)
export interface TestConnectionMessage {
  type: "llmt-test-connection";
}
export type TestConnectionResult = { ok: true; sample: string } | { ok: false; message: string };

// ---------------------------------------------------------------------------
// Image translation (right-click on an <img>, or on the page for the images on screen). Background -> content over
// chrome.tabs.sendMessage to the top frame; only "llmt-image-locate" is answered.

/** CSS px, relative to the viewport. */
export interface ViewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What to translate: the image a context-menu click carries, or whatever images are on screen. */
export type ImageTarget = { kind: "src"; srcUrl: string } | { kind: "visible" };

/** The image's own pixels, read in the page (JPEG, long edge capped), when the page allows it. */
export interface OriginalImage {
  base64: string;
  width: number;
  height: number;
}

export interface LocatedImage {
  jobId: string;
  /** The element's box and the part of it inside the viewport. */
  image: ViewRect;
  visible: ViewRect;
  /** Absent: crop the screenshot instead. Present only for an image that is fully visible. */
  original?: OriginalImage;
}

export type ImageLocateResult =
  | { ok: true; viewport: { width: number; height: number }; images: LocatedImage[] }
  | { ok: false; reason: "not-found" | "not-visible" | "no-images" };

/** One translated text region; box in fractions (0-1) of the image element's box, already padded. */
export interface ImageRegion {
  /** Where the translation is laid out, in fractions of the image box. */
  box: [x0: number, y0: number, x1: number, y1: number];
  /** Polygon painted over the original text, in fractions of the image box: the bubble's inside. */
  cover: [x: number, y: number][];
  text: string;
  /** CSS colour sampled around the text in the captured image, and a readable text colour on it. */
  fill: string;
  ink: string;
  /** Lay the text out top-to-bottom (target zh/ja and the box is clearly taller than wide, measured in pixels). */
  vertical: boolean;
}

export type ImageMessage =
  /** Content scripts cannot read storage, so the UI language travels with the messages that start or end a job. */
  | { type: "llmt-image-locate"; target: ImageTarget; uiLanguage: UiLanguageSetting }
  /** The screenshot is taken: the overlay may show its status chip now. */
  | { type: "llmt-image-captured"; jobId: string }
  | { type: "llmt-image-region"; jobId: string; region: ImageRegion }
  /**
   * `partial`: only part of the image was visible, so only that part was translated.
   * With an `error` and a jobId the job failed; with an empty jobId there is no
   * job (image not found, iframe) and the content script only shows the notice.
   */
  | {
      type: "llmt-image-end";
      jobId: string;
      count: number;
      partial: boolean;
      error?: { message: string; settings: boolean };
      uiLanguage: UiLanguageSetting;
    };
