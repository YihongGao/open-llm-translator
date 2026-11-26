import { beforeEach, describe, expect, it, vi } from "vitest";
import { PROVIDERS, clearApiKey } from "../src/shared/settings";

describe("clearApiKey", () => {
  const store: Record<string, unknown> = {};
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          remove: async (key: string) => {
            delete store[key];
          },
        },
      },
    });
  });

  it("removes only that provider's key, leaving no empty string behind", async () => {
    Object.assign(store, { anthropicApiKey: "a", openaiApiKey: "o", model: "m" });
    await clearApiKey(PROVIDERS.find((p) => p.id === "anthropic")!);
    expect(store).toEqual({ openaiApiKey: "o", model: "m" });
    expect("anthropicApiKey" in store).toBe(false);
  });
});
