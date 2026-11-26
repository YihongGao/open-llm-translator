import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve("scripts/check-dist.mjs");
const ICONS = { "16": "i16.png", "32": "i32.png", "48": "i48.png", "128": "i128.png" };
const dirs: string[] = [];

function dist(manifest: object, files: Record<string, string> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), "llmt-check-dist-"));
  dirs.push(dir);
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ name: "Open LLM Translator", icons: ICONS, ...manifest }));
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body);
  return dir;
}

function check(dir: string) {
  const r = spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8" });
  return { code: r.status, stderr: r.stderr };
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("check-dist", () => {
  it("passes a clean build", () => {
    expect(check(dist({ host_permissions: ["https://api.anthropic.com/*"] }, { "content.js": 'const s = "翻譯此頁";' })).code).toBe(0);
  });

  it.each([
    ["E2E manifest name", { name: "Open LLM Translator (E2E)" }, {}, "E2E build"],
    ["<all_urls>", { host_permissions: ["<all_urls>"] }, {}, "broad host permissions"],
    ["*://*/* optional", { optional_host_permissions: ["*://*/*"] }, {}, "broad host permissions"],
    ["missing icon", { icons: { "16": "i16.png" } }, {}, "missing 32px"],
    ["source map", {}, { "background.js.map": "{}" }, "source map in bundle"],
    ["eval", {}, { "content.js": "eval(x)" }, "matches"],
    ["remote import", {}, { "content.js": 'import("https://x.example/a.js")' }, "matches"],
    ["escaped CJK", {}, { "popup.js": 'const s = "\\u7ffb\\u8b6f";' }, "escaped CJK"],
  ] as const)("rejects %s", (_name, manifest, files, message) => {
    const r = check(dist(manifest, files));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(message);
  });
});
