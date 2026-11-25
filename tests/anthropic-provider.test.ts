// Drives AnthropicProvider through the real SDK against a local mock SSE
// server, so the request shape and the streaming -> parser path are covered
// without an API key.
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AnthropicProvider } from "../src/background/providers/anthropic";
import type { ProviderEvent } from "../src/background/providers/types";

let server: Server;
let lastBody: any;
let lastHeaders: IncomingHttpHeaders;
let reply: string[] = [];
let stopReason = "end_turn";
let servedModel: string | null = null; // null = echo the requested model
let iterations: object[] | null = null;

function sse(type: string, data: object): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      lastBody = JSON.parse(raw);
      lastHeaders = req.headers;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        sse("message_start", {
          message: {
            id: "msg_1", type: "message", role: "assistant", model: servedModel ?? lastBody.model, content: [],
            stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 },
          },
        }),
      );
      res.write(sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }));
      for (const text of reply) res.write(sse("content_block_delta", { index: 0, delta: { type: "text_delta", text } }));
      res.write(sse("content_block_stop", { index: 0 }));
      res.write(sse("message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5, ...(iterations ? { iterations } : {}) } }));
      res.end(sse("message_stop", {}));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  delete process.env.ANTHROPIC_BASE_URL;
  server.close();
});

async function collect(provider: AnthropicProvider, texts: string[]): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const ev of provider.translate(
    { texts, targetLang: "zh-TW", page: { title: "K8s", url: "https://kubernetes.io" } },
    new AbortController().signal,
  ))
    events.push(ev);
  return events;
}

describe("AnthropicProvider", () => {
  it("streams parsed segments and sends the expected request", async () => {
    reply = ["[1] 文", "件\n[2] Kubernetes 部", "落格\n"];
    stopReason = "end_turn";
    const events = await collect(new AnthropicProvider("sk-test", "claude-sonnet-5-5"), ["Documentation", "Kubernetes Blog"]);

    expect(events).toEqual([
      { kind: "segment", index: 0, text: "文件" },
      { kind: "segment", index: 1, text: "Kubernetes 部落格" },
      {
        kind: "end",
        reason: "complete",
        usage: { inputTokens: 10, outputTokens: 5 },
        servedModel: "claude-sonnet-5-5",
        fallback: false,
      },
    ]);
    expect(lastBody).toMatchObject({
      model: "claude-sonnet-5-5",
      stream: true,
      output_config: { effort: "low" },
      fallbacks: "default",
    });
    expect(lastBody.system).toContain("Traditional Chinese as used in Taiwan");
    expect(lastBody.messages[0].content).toContain("[1] Documentation\n[2] Kubernetes Blog");
    expect(lastHeaders["anthropic-beta"]).toContain("server-side-fallback-2026-07-01");
    // SDK 1.x (API version 2026-10-21) sends the key as a bearer token.
    expect(lastHeaders["authorization"]).toBe("Bearer sk-test");
    expect(lastHeaders["anthropic-dangerous-direct-browser-access"]).toBe("true");
  });

  it("omits fallbacks for Haiku and reports refusal as the end reason", async () => {
    reply = ["[1] 好\n"];
    stopReason = "refusal";
    const events = await collect(new AnthropicProvider("sk-test", "claude-haiku-5-5"), ["ok", "bad"]);
    expect(events).toEqual([
      { kind: "segment", index: 0, text: "好" },
      {
        kind: "end",
        reason: "refusal",
        usage: { inputTokens: 10, outputTokens: 5 },
        servedModel: "claude-haiku-5-5",
        fallback: false,
      },
    ]);
    expect(lastBody.fallbacks).toBeUndefined();
    expect(lastHeaders["anthropic-beta"]).toBeUndefined();
  });

  it("reports the served model and flags a refusal fallback", async () => {
    reply = ["[1] 好\n"];
    stopReason = "end_turn";
    servedModel = "claude-sonnet-5";
    iterations = [
      { type: "message", input_tokens: 10, output_tokens: 0 },
      { type: "fallback_message", input_tokens: 10, output_tokens: 5 },
    ];
    const events = await collect(new AnthropicProvider("sk-test", "claude-sonnet-5-5"), ["ok"]);
    expect(events.at(-1)).toMatchObject({ kind: "end", servedModel: "claude-sonnet-5", fallback: true });
    servedModel = null;
    iterations = null;
  });
});
