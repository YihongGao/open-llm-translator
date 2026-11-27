// Image translation over the Anthropic API: one vision call per image, the
// reply streamed and parsed region by region. Not a TranslationProvider (that
// interface is text-only). Errors go through describeAnthropicError.

import Anthropic from "@anthropic-ai/sdk";
import { RegionLineParser, buildImagePrompt } from "../image-protocol";
import { MODELS_WITH_FALLBACK, FALLBACK_BETA } from "./anthropic";
import type { TokenUsage } from "./types";

export interface ImageInput {
  base64: string;
  mediaType: "image/jpeg" | "image/png";
  /** Pixels of the encoded image, as stated in the prompt. */
  width: number;
  height: number;
}

export type ImageEvent =
  | { kind: "region"; /** Pixels of the sent image. */ box: [number, number, number, number]; text: string }
  /** Always the last event. */
  | { kind: "end"; reason: "complete" | "max_tokens" | "refusal"; usage: TokenUsage; servedModel: string };

export async function* streamImageRegions(
  apiKey: string,
  model: string,
  image: ImageInput,
  targetLang: string,
  signal: AbortSignal,
): AsyncGenerator<ImageEvent> {
  // Same direct-browser setup as AnthropicProvider: the key is the user's own.
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
  const parser = new RegionLineParser();
  const stream = client.beta.messages.stream(
    {
      model,
      max_tokens: 4000,
      output_config: { effort: "low" },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.base64 } },
            { type: "text", text: buildImagePrompt(targetLang, image.width, image.height) },
          ],
        },
      ],
      ...(MODELS_WITH_FALLBACK.has(model) ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
    },
    { signal },
  );

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      for (const r of parser.push(event.delta.text)) yield { kind: "region", box: r.box, text: r.text };
    }
  }
  const final = await stream.finalMessage();
  const truncated = final.stop_reason !== "end_turn" && final.stop_reason !== "stop_sequence";
  for (const r of parser.end({ truncated })) yield { kind: "region", box: r.box, text: r.text };
  yield {
    kind: "end",
    reason: final.stop_reason === "refusal" ? "refusal" : final.stop_reason === "max_tokens" ? "max_tokens" : "complete",
    usage: {
      inputTokens: final.usage.input_tokens,
      outputTokens: final.usage.output_tokens,
      cacheReadTokens: final.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: final.usage.cache_creation_input_tokens ?? 0,
    },
    servedModel: final.model,
  };
}
