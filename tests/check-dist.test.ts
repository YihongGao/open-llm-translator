import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

/** A dist with the given locales, each a { key: message } map. */
function localized(manifest: object, locales: Record<string, Record<string, string>>): string {
  const dir = dist(manifest);
  for (const [locale, messages] of Object.entries(locales)) {
    mkdirSync(path.join(dir, "_locales", locale), { recursive: true });
    const body = Object.fromEntries(Object.entries(messages).map(([k, message]) => [k, { message }]));
    writeFileSync(path.join(dir, "_locales", locale, "messages.json"), JSON.stringify(body));
  }
  return dir;
}

describe("check-dist locales", () => {
  const manifest = { default_locale: "en", description: "__MSG_desc__" };

  it("passes when every locale has every default message", () => {
    expect(check(localized(manifest, { en: { desc: "a" }, ja: { desc: "b" } })).code).toBe(0);
  });

  it("rejects a manifest message missing from the default locale", () => {
    const r = check(localized(manifest, { en: { other: "a" } }));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("__MSG_desc__");
  });

  it("rejects a locale that lacks a default message", () => {
    const r = check(localized(manifest, { en: { desc: "a" }, ja: {} }));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("_locales/ja lacks message desc");
  });

  it("ignores stray files in _locales", () => {
    const dir = localized(manifest, { en: { desc: "a" } });
    writeFileSync(path.join(dir, "_locales", ".DS_Store"), "");
    expect(check(dir).code).toBe(0);
  });

  it("reports a locale folder without messages.json instead of crashing", () => {
    const dir = localized(manifest, { en: { desc: "a" } });
    mkdirSync(path.join(dir, "_locales", "ja"));
    const r = check(dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("_locales/ja/messages.json is missing");
  });

  it("rejects __MSG_ strings without default_locale", () => {
    const r = check(dist({ description: "__MSG_desc__" }));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("without default_locale");
  });
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
    ["debug helper", {}, { "background.js": "globalThis.llmtMeasurePrompts=async()=>{}" }, "debug helper"],
    ["image debug helper", {}, { "background.js": "globalThis.llmtTranslateImage=async()=>{}" }, "debug helper llmtTranslateImage"],
    ["escaped CJK", {}, { "popup.js": 'const s = "\\u7ffb\\u8b6f";' }, "escaped CJK"],
  ] as const)("rejects %s", (_name, manifest, files, message) => {
    const r = check(dist(manifest, files));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(message);
  });
});
