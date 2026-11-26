// OpenAI and Gemini providers against a local mock SSE server: request shape,
// streaming -> parser path, end reasons and usage mapping, without API keys.
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GeminiProvider, THINKING_LEVEL } from "../src/background/providers/gemini";
import { ProviderHttpError, describeHttpError, readSse } from "../src/background/providers/http";
import { OpenAIProvider, REASONING_EFFORT } from "../src/background/providers/openai";
import type { ProviderEvent, TranslationProvider } from "../src/background/providers/types";
import { MODELS } from "../src/shared/settings";

let server: Server;
let base = "";
let last: { url: string; headers: IncomingHttpHeaders; body: any };
/** What the next request gets back: HTTP status and raw SSE chunks. */
let status = 200;
let chunks: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      last = { url: req.url ?? "", headers: req.headers, body: JSON.parse(raw) };
      if (status !== 200) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Incorrect API key provided" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const c of chunks) res.write(c);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());
beforeEach(() => {
  status = 200;
  chunks = [];
});

async function collect(provider: TranslationProvider, texts: string[]): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const ev of provider.translate(
    { texts, targetLang: "zh-TW", page: { title: "K8s", url: "https://kubernetes.io/docs/" } },
    new AbortController().signal,
  ))
    events.push(ev);
  return events;
}

const segments = (events: ProviderEvent[]) => events.filter((e) => e.kind === "segment");

describe("readSse", () => {
  async function parse(parts: string[]) {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of parts) c.enqueue(new TextEncoder().encode(p));
        c.close();
      },
    });
    const out = [];
    for await (const ev of readSse(body)) out.push(ev);
    return out;
  }

  it("handles events split across chunks, CRLF, comments and multi-line data; drops an unterminated tail", async () => {
    expect(
      await parse([": keep-alive\r\nevent: a\r", "\ndata: {\"x\":", "1}\r\n\r\n", "data: line1\ndata: line2\n\n", "data: tail"]),
    ).toEqual([
      { event: "a", data: '{"x":1}' },
      { event: "message", data: "line1\nline2" },
    ]);
  });

  it("decodes UTF-8 split inside a multi-byte character", async () => {
    const bytes = new TextEncoder().encode("data: 繁體\n\n");
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, 8)); // cuts "繁" in half
        c.enqueue(bytes.slice(8));
        c.close();
      },
    });
    const out = [];
    for await (const ev of readSse(body)) out.push(ev);
    expect(out).toEqual([{ event: "message", data: "繁體" }]);
  });
});

describe("OpenAIProvider", () => {
  const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const done = (status: string, extra: object = {}) =>
    ev(`response.${status === "completed" ? "completed" : status}`, {
      response: {
        status,
        model: "gpt-6-luna-2026-10-01",
        usage: { input_tokens: 700, input_tokens_details: { cached_tokens: 500, cache_write_tokens: 100 }, output_tokens: 40 },
        ...extra,
      },
    });

  it("sends a stateless Responses request and streams parsed segments", async () => {
    chunks = [
      ev("response.created", { response: { status: "in_progress" } }),
      ev("response.output_text.delta", { delta: "[1] 文" }),
      ev("response.output_text.delta", { delta: "件\n[2] Kubernetes 部落格\n" }),
      done("completed"),
    ];
    const events = await collect(new OpenAIProvider("sk-test", "gpt-6-luna", base), ["Documentation", "Kubernetes Blog"]);

    expect(events).toEqual([
      { kind: "segment", index: 0, text: "文件" },
      { kind: "segment", index: 1, text: "Kubernetes 部落格" },
      {
        kind: "end",
        reason: "complete",
        usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 500, cacheWriteTokens: 100 },
        servedModel: "gpt-6-luna-2026-10-01",
      },
    ]);
    expect(last.url).toBe("/responses");
    expect(last.headers.authorization).toBe("Bearer sk-test");
    expect(last.body).toMatchObject({
      model: "gpt-6-luna",
      stream: true,
      store: false,
      reasoning: { effort: "none" },
      instructions: expect.stringContaining("Traditional Chinese as used in Taiwan"),
    });
    expect(last.body.input).toContain("[1] Documentation\n[2] Kubernetes Blog");
  });

  it("uses low effort on models that reject none", async () => {
    chunks = [done("completed")];
    await collect(new OpenAIProvider("sk-test", "gpt-6.2-sol", base), ["x"]);
    expect(last.body.reasoning).toEqual({ effort: "low" });
  });

  it("drops the cut-off last segment when the response is incomplete", async () => {
    chunks = [
      ev("response.output_text.delta", { delta: "[1] 完整\n[2] 只翻了一" }),
      done("incomplete", { incomplete_details: { reason: "max_output_tokens" } }),
    ];
    const events = await collect(new OpenAIProvider("k", "gpt-6-luna", base), ["a", "b"]);
    expect(segments(events)).toEqual([{ kind: "segment", index: 0, text: "完整" }]);
    expect(events.at(-1)).toMatchObject({ kind: "end", reason: "max_tokens" });
  });

  it("reports a refusal", async () => {
    chunks = [
      ev("response.output_text.delta", { delta: "[1] 好\n" }),
      ev("response.refusal.delta", { delta: "I can't help with that." }),
      done("completed"),
    ];
    const events = await collect(new OpenAIProvider("k", "gpt-6-luna", base), ["ok", "bad"]);
    expect(segments(events)).toEqual([{ kind: "segment", index: 0, text: "好" }]);
    expect(events.at(-1)).toMatchObject({ kind: "end", reason: "refusal" });
  });

  it("throws on an error event and on a stream that ends without a final response", async () => {
    chunks = [ev("error", { message: "server overloaded" })];
    await expect(collect(new OpenAIProvider("k", "gpt-6-luna", base), ["a"])).rejects.toThrow("server overloaded");
    chunks = [ev("response.output_text.delta", { delta: "[1] 半" })];
    await expect(collect(new OpenAIProvider("k", "gpt-6-luna", base), ["a"])).rejects.toBeInstanceOf(ProviderHttpError);
  });

  it("maps a 401 to a settings error with the provider's name", async () => {
    status = 401;
    const err = await collect(new OpenAIProvider("bad", "gpt-6-luna", base), ["a"]).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect(describeHttpError("OpenAI", err)).toEqual({ message: "OpenAI API key 無效（401），請到設定頁確認", settings: true });
  });
});

describe("GeminiProvider", () => {
  const ev = (event_type: string, data: object) =>
    `event: ${event_type}\ndata: ${JSON.stringify({ ...data, event_type })}\n\n`;
  const completed = (status: string) =>
    ev("interaction.completed", {
      interaction: {
        id: "v1_x",
        status,
        usage: { total_input_tokens: 800, total_cached_tokens: 500, total_output_tokens: 30, total_thought_tokens: 12 },
      },
    });

  it("sends a stateless interaction and streams only model text (not thoughts)", async () => {
    chunks = [
      ev("interaction.created", { interaction: { id: "v1_x", status: "in_progress", model: "gemini-4-hydrogen" } }),
      ev("step.start", { index: 0, step: { type: "thought" } }),
      ev("step.delta", { index: 0, delta: { type: "thought_signature", signature: "abc" } }),
      ev("step.stop", { index: 0 }),
      ev("step.start", { index: 1, step: { type: "model_output" } }),
      ev("step.delta", { index: 1, delta: { type: "text", text: "[1] 文件\n[2] Kubernetes " } }),
      ev("step.delta", { index: 1, delta: { type: "text", text: "部落格\n" } }),
      ev("step.stop", { index: 1 }),
      completed("completed"),
      // Sent by the live API after interaction.completed.
      "data: [DONE]\n\n",
    ];
    const events = await collect(new GeminiProvider("AIza-test", "gemini-4-hydrogen", base), ["Documentation", "Kubernetes Blog"]);

    expect(events).toEqual([
      { kind: "segment", index: 0, text: "文件" },
      { kind: "segment", index: 1, text: "Kubernetes 部落格" },
      {
        kind: "end",
        reason: "complete",
        usage: { inputTokens: 300, outputTokens: 42, cacheReadTokens: 500, cacheWriteTokens: 0 },
        servedModel: "gemini-4-hydrogen",
      },
    ]);
    expect(last.url).toBe("/interactions?alt=sse");
    expect(last.headers["x-goog-api-key"]).toBe("AIza-test");
    expect(last.headers["api-revision"]).toBe("2026-05-20");
    expect(last.body).toMatchObject({
      model: "gemini-4-hydrogen",
      stream: true,
      store: false,
      generation_config: { thinking_level: "low" },
      system_instruction: expect.stringContaining("Traditional Chinese as used in Taiwan"),
    });
    expect(last.body.input).toContain("[1] Documentation\n[2] Kubernetes Blog");
  });

  it("uses minimal thinking on Flash-Lite", async () => {
    chunks = [completed("completed")];
    await collect(new GeminiProvider("k", "gemini-3.5-flash-lite", base), ["x"]);
    expect(last.body.generation_config.thinking_level).toBe("minimal");
  });

  it("drops the cut-off last segment when the interaction is incomplete", async () => {
    chunks = [ev("step.delta", { index: 0, delta: { type: "text", text: "[1] 完整\n[2] 只翻了一" } }), completed("incomplete")];
    const events = await collect(new GeminiProvider("k", "gemini-4-hydrogen", base), ["a", "b"]);
    expect(segments(events)).toEqual([{ kind: "segment", index: 0, text: "完整" }]);
    expect(events.at(-1)).toMatchObject({ kind: "end", reason: "max_tokens" });
  });

  it("throws on an error event and on a failed interaction", async () => {
    chunks = [ev("error", { error: { message: "Deadline expired", code: "gateway_timeout" } })];
    await expect(collect(new GeminiProvider("k", "gemini-4-hydrogen", base), ["a"])).rejects.toThrow("Deadline expired");
    chunks = [completed("failed")];
    await expect(collect(new GeminiProvider("k", "gemini-4-hydrogen", base), ["a"])).rejects.toThrow("failed");
  });
});

describe("model tables", () => {
  it("every OpenAI/Gemini model in the UI has a reasoning setting", () => {
    for (const m of MODELS.filter((x) => x.provider === "openai")) expect(REASONING_EFFORT[m.id], m.id).toBeDefined();
    for (const m of MODELS.filter((x) => x.provider === "gemini")) expect(THINKING_LEVEL[m.id], m.id).toBeDefined();
  });
});
