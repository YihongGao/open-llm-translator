import { describe, expect, it } from "vitest";
import { IMAGE_MODELS, MODELS, defaultSettings, providerOf, resolveImageModel } from "../src/shared/settings";

describe("image model", () => {
  it("defaults to Sonnet, which is an image model", () => {
    expect(defaultSettings().imageModel).toBe("claude-sonnet-5-5");
    expect(IMAGE_MODELS.map((m) => m.id)).toContain(defaultSettings().imageModel);
  });

  it("offers exactly the Anthropic models (image translation supports Claude only)", () => {
    expect(IMAGE_MODELS.length).toBeGreaterThan(0);
    expect(IMAGE_MODELS.every((m) => providerOf(m.id).id === "anthropic")).toBe(true);
    expect(IMAGE_MODELS).toEqual(MODELS.filter((m) => m.provider === "anthropic"));
  });

  it("keeps a valid stored choice and replaces anything else with the default", () => {
    expect(resolveImageModel("claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(resolveImageModel("gpt-6-luna")).toBe("claude-sonnet-5-5");
    expect(resolveImageModel("removed-model")).toBe("claude-sonnet-5-5");
    expect(resolveImageModel("")).toBe("claude-sonnet-5-5");
  });
});
