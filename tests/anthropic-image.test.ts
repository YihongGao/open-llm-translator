// Drives streamImageRegions through the real SDK against a local mock SSE
// server: request shape, streaming -> parser path, and error mapping.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeAnthropicError } from "../src/background/providers/anthropic";
import { streamImageRegions, type ImageEvent, type ImageInput } from "../src/background/providers/anthropic-image";

let server: Server;
let lastBody: any;
let reply: string[] = [];
let stopReason = "end_turn";
let status = 200;

function sse(type: string, data: object): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      lastBody = JSON.parse(raw);
      if (status !== 200) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "bad key" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        sse("message_start", {
          message: {
            id: "msg_1", type: "message", role: "assistant", model: lastBody.model, content: [],
            stop_reason: null, stop_sequence: null, usage: { input_tokens: 2500, output_tokens: 0 },
          },
        }),
      );
      res.write(sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }));
      for (const text of reply) res.write(sse("content_block_delta", { index: 0, delta: { type: "text_delta", text } }));
      res.write(sse("content_block_stop", { index: 0 }));
      res.write(sse("message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 80 } }));
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

const image: ImageInput = { base64: "AAAA", mediaType: "image/jpeg", width: 800, height: 1200 };

async function collect(model: string): Promise<ImageEvent[]> {
  const events: ImageEvent[] = [];
  for await (const ev of streamImageRegions("sk-test", model, image, "zh-TW", new AbortController().signal)) events.push(ev);
  return events;
}

describe("streamImageRegions", () => {
  it("streams parsed regions and sends one image plus the prompt", async () => {
    reply = ["[1] 10,20,", "110,80 | 你好\n[2] 5,5,50,50 | 再見\n"];
    stopReason = "end_turn";
    status = 200;
    const events = await collect("claude-sonnet-5-5");

    expect(events).toEqual([
      { kind: "region", box: [10, 20, 110, 80], text: "你好" },
      { kind: "region", box: [5, 5, 50, 50], text: "再見" },
      {
        kind: "end",
        reason: "complete",
        usage: { inputTokens: 2500, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0 },
        servedModel: "claude-sonnet-5-5",
      },
    ]);
    const content = lastBody.messages[0].content;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } });
    expect(content[1].text).toContain("800×1200 image");
    expect(content[1].text).toContain("Traditional Chinese");
    expect(lastBody.output_config).toEqual({ effort: "low" });
    expect(lastBody.max_tokens).toBe(4000);
  });

  it("asks for the server-side fallback on Sonnet and Opus, not on Haiku", async () => {
    reply = [];
    await collect("claude-opus-5-5");
    expect(lastBody.fallbacks).toBe("default");
    await collect("claude-haiku-5-5");
    expect(lastBody.fallbacks).toBeUndefined();
  });

  it("ignores a repeated list (Haiku)", async () => {
    reply = ["[1] 0,0,10,10 | a\n[2] 0,0,10,10 | b\n[1] 0,0,10,10 | a\n[2] 0,0,10,10 | b\n"];
    const regions = (await collect("claude-haiku-5-5")).filter((e) => e.kind === "region");
    expect(regions.map((r) => r.kind === "region" && r.text)).toEqual(["a", "b"]);
  });

  it("drops a last line cut off by max_tokens and reports it", async () => {
    reply = ["[1] 0,0,10,10 | a\n[2] 0,0,10,10 | b cut"];
    stopReason = "max_tokens";
    const events = await collect("claude-sonnet-5-5");
    expect(events.filter((e) => e.kind === "region")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ kind: "end", reason: "max_tokens" });
  });

  it("surfaces API errors for describeAnthropicError", async () => {
    status = 401;
    const err = await collect("claude-sonnet-5-5").catch((e) => e);
    expect(err).toBeInstanceOf(Anthropic.AuthenticationError);
    expect(describeAnthropicError(err).settings).toBe(true);
    status = 200;
  });
});
