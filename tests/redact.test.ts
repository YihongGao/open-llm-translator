import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/background/redact";

describe("redactSecrets", () => {
  it("masks an Anthropic key inside a sentence", () => {
    const key = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCd";
    expect(redactSecrets(`invalid x-api-key: ${key} was rejected`)).toBe("invalid x-api-key: sk-*** was rejected");
  });

  it("masks an OpenAI project key", () => {
    const key = "sk-proj-Abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ";
    expect(redactSecrets(`Incorrect API key provided: ${key}.`)).toBe("Incorrect API key provided: sk-***.");
  });

  it("masks a Gemini key", () => {
    const key = "AIzaSyA1234567890abcdefghijklmnopqrstuvw";
    expect(redactSecrets(`API key not valid (key=${key}).`)).toBe("API key not valid (key=AIza***).");
  });

  it("masks every occurrence", () => {
    const key = "sk-abcdefghijklmnopqrstuvwxyz";
    expect(redactSecrets(`${key} and ${key}`)).toBe("sk-*** and sk-***");
  });

  it("leaves normal prose and already-masked keys unchanged", () => {
    for (const text of [
      "Anthropic API 錯誤 500：Internal server error",
      "rate limit reached for the task-oriented sk-learn pipeline",
      "Incorrect API key provided: sk-proj-****abcd.",
    ])
      expect(redactSecrets(text)).toBe(text);
  });
});
