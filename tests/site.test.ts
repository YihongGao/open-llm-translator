import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// The landing page is deployed from dist-site/ as-is, so every local file it
// references must be in the build output.
describe("landing page build", () => {
  let html = "";
  beforeAll(() => {
    execFileSync(process.execPath, ["scripts/build-site.mjs"]);
    html = readFileSync("dist-site/index.html", "utf8");
  });

  it("ships every local file the page references", () => {
    const refs = [...html.matchAll(/\b(?:href|src)="([^"#][^"]*)"/g)]
      .map((m) => m[1] ?? "")
      .filter((r) => !/^(?:https?:|mailto:)/.test(r));
    expect(refs).toContain("content.css");
    expect(refs).toContain("demo.js");
    for (const ref of refs) {
      // Pages serves dist-site/ under /open-llm-translator/, so paths must stay inside it.
      expect(ref, ref).not.toMatch(/^(?:\.\.|\/)/);
      expect(existsSync(join("dist-site", ref)), ref).toBe(true);
    }
  });

  it("uses the extension's own stylesheet for translations", () => {
    expect(readFileSync("dist-site/content.css", "utf8")).toBe(readFileSync("public/content.css", "utf8"));
  });
});
