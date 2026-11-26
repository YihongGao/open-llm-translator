import { describe, expect, it } from "vitest";
import { keyFieldHint, typedKeyPatch } from "../src/shared/settings";

describe("typedKeyPatch", () => {
  it("includes only keys the user typed, trimmed", () => {
    expect(typedKeyPatch({ anthropicApiKey: "  sk-ant-new  ", openaiApiKey: "", geminiApiKey: "   " })).toEqual({
      anthropicApiKey: "sk-ant-new",
    });
  });

  it("is empty when nothing was typed, so saving keeps every stored key", () => {
    expect(typedKeyPatch({ anthropicApiKey: "", openaiApiKey: "", geminiApiKey: "" })).toEqual({});
  });
});

describe("keyFieldHint", () => {
  it("shows only the last four characters of a stored key", () => {
    const hint = keyFieldHint("sk-ant-api03-secretsecret-WXYZ", "sk-ant-...");
    expect(hint).toContain("WXYZ");
    expect(hint).not.toContain("secret");
    expect(hint).not.toContain("sk-ant-api03");
  });

  it("does not reveal any characters of a short stored key", () => {
    expect(keyFieldHint("abcd1234", "sk-...")).not.toMatch(/[a-d1-4]{4}/);
  });

  it("falls back to the example placeholder when no key is stored", () => {
    expect(keyFieldHint("", "AIza...")).toBe("AIza...");
  });
});
