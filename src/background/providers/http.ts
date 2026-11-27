// Shared plumbing for the providers called over plain fetch (OpenAI, Gemini):
// HTTP errors with a user-facing description, and a server-sent events reader.

import { t } from "../../shared/i18n";
import type { ErrorInfo } from "./types";

/** Non-2xx response, or an error event inside a 200 stream (status 0). */
export class ProviderHttpError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

/** Throws ProviderHttpError for a non-2xx response, with the API's own message when it has one. */
export async function ensureOk(provider: string, res: Response): Promise<void> {
  if (res.ok) return;
  let message = res.statusText || `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { error?: { message?: string } | string };
    const m = typeof body.error === "string" ? body.error : body.error?.message;
    if (m) message = m;
  } catch {
    // Not JSON; keep the status text.
  }
  throw new ProviderHttpError(provider, res.status, message);
}

/** Maps fetch-based provider errors to a short user-facing message. */
export function describeHttpError(provider: string, err: unknown): ErrorInfo {
  if (err instanceof ProviderHttpError) {
    const s = err.status;
    if (s === 401) return { message: t("errKeyInvalid", provider), settings: true };
    if (s === 403) return { message: t("errForbidden", provider, err.message), settings: true };
    if (s === 404) return { message: t("errModelNotFound", provider), settings: true };
    if (s === 429) return { message: t("errRateLimit", provider), settings: false };
    if (s === 400) return { message: t("errBadRequest", provider, err.message), settings: false };
    if (s === 0) return { message: t("errStreamInterrupted", provider, err.message), settings: false };
    return { message: t("errApi", provider, String(s), err.message), settings: false };
  }
  if (err instanceof TypeError) return { message: t("errConnect", provider), settings: false };
  return { message: err instanceof Error ? err.message : String(err), settings: false };
}

export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Parses a text/event-stream body into events (WHATWG SSE framing: fields
 * `event:` and `data:`, events terminated by a blank line, CR, LF or CRLF).
 */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let event = "";
  let data: string[] = [];
  let finished = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        finished = true;
        break;
      }
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.search(/\r\n|\n|\r/)) !== -1) {
        const line = buf.slice(0, nl);
        // A lone \r at the end of the buffer may be the first half of \r\n.
        if (buf[nl] === "\r" && nl === buf.length - 1) break;
        buf = buf.slice(nl + (buf.startsWith("\r\n", nl) ? 2 : 1));
        if (line === "") {
          if (data.length) yield { event: event || "message", data: data.join("\n") };
          event = "";
          data = [];
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":");
          const field = colon === -1 ? line : line.slice(0, colon);
          let val = colon === -1 ? "" : line.slice(colon + 1);
          if (val.startsWith(" ")) val = val.slice(1);
          if (field === "event") event = val;
          else if (field === "data") data.push(val);
        }
      }
    }
    // Per the SSE spec, an event not terminated by a blank line is discarded.
  } finally {
    // The consumer stopped early (or the read failed): close the connection
    // instead of leaving the response streaming into nowhere.
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
