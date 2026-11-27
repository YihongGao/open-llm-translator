// Journey: our own t() renders exactly what chrome.i18n.getMessage renders, so "Follow browser"
// is the same as before the UI-language setting existed. For each browser language, in a real
// Chromium, every catalog key is resolved both ways (with substitutions that contain "$").
// Usage: node .claude/skills/verify/scripts/journey-ui-locale-fidelity.mjs   (after npm run build:e2e)
// Exit 0 = every check passed. The mock API is never reached.
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as esbuild from "esbuild";
import { REPO, launch } from "./harness.mjs";

// The real src/shared/i18n.ts, bundled the way the extension bundles it, exposed as a global.
const bundle = await esbuild.build({
  entryPoints: [path.join(REPO, "src/shared/i18n.ts")],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "llmtI18n",
  charset: "utf8",
});
const code = bundle.outputFiles[0].text;
const keys = Object.keys(JSON.parse(await readFile(path.join(REPO, "public/_locales/en/messages.json"), "utf8")));
// Substitutions that would expose a replace-string bug: $& $1 $$ and non-ASCII.
const SUBS = ["A$&B", "$1 $$", "ünï 日本"];

// Browser language -> the locale Chrome serves it.
const CASES = [
  ["zh-TW", "zh_TW"],
  ["ja", "ja"],
  ["zh-CN", "zh_CN"],
  ["en", "en"],
  ["fr", "en"],
  ["zh-HK", "zh_TW"],
];

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `: ${JSON.stringify(detail)}`}`);
};

for (const [locale, expected] of CASES) {
  const run = await launch({ name: `ui-locale-fidelity-${locale}`, locale });
  try {
    // A string goes through CDP Runtime.evaluate, which the extension CSP (no eval) does not apply to. It defines `llmtI18n`.
    await run.sw.evaluate(`${code}
;globalThis.llmtI18n = llmtI18n;`);
    const out = await run.sw.evaluate(
      ([keys, subs]) => {
        const lib = globalThis.llmtI18n;
        const mismatches = [];
        for (const key of keys) {
          const chromeSays = chrome.i18n.getMessage(key, subs);
          const ours = lib.t(key, ...subs);
          if (chromeSays !== ours) mismatches.push({ key, chrome: chromeSays, ours });
        }
        return { uiLanguage: chrome.i18n.getUILanguage(), current: lib.currentLocale(), mismatches, checked: keys.length };
      },
      [keys, SUBS],
    );
    await run.writeJson("fidelity.json", out);
    check(`[${locale}] browser UI language is ${locale}`, out.uiLanguage === locale, out.uiLanguage);
    check(`[${locale}] auto resolves to ${expected}`, out.current === expected, out.current);
    check(`[${locale}] t() equals chrome.i18n.getMessage for all ${out.checked} keys`, out.mismatches.length === 0, out.mismatches.slice(0, 5));
  } catch (err) {
    check(`[${locale}] journey ran to completion`, false, String(err?.stack ?? err));
  } finally {
    await run.writeJson("result.json", results.filter((r) => r.name.startsWith(`[${locale}]`)));
    await run.close();
  }
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `${failed.length} check(s) failed` : "all checks passed");
process.exit(failed.length ? 1 : 0);
