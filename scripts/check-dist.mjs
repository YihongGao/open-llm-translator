// Refuses a build the Chrome Web Store would reject or that must never ship.
// Usage: node scripts/check-dist.mjs [dir]   (default dist; build it first)
// Exit 1 lists every problem. Run by CI on each PR and by scripts/package.mjs.
//
// Checks:
//   - manifest: no "(E2E)" name, no broad host access (<all_urls>, *://*/*),
//     icons at 16/32/48/128
//   - every __MSG_x__ in the manifest exists in the default locale's messages.json,
//     and no other locale lacks a message the default locale has
//   - no source maps in the bundle
//   - no remote or dynamic code: eval(, new Function(, importScripts(,
//     import("http…") — MV3 forbids executing code not shipped in the package
//   - no \uXXXX-escaped CJK text (reads as obfuscation to store reviewers)
//   - no debug helper: llmtMeasurePrompts must be compiled out (__LLMT_DEBUG__)
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";

const dir = process.argv[2] ?? "dist";
const problems = [];
const manifest = JSON.parse(await readFile(`${dir}/manifest.json`, "utf8"));

if (manifest.name.includes("(E2E)")) problems.push(`manifest name is the E2E build's: ${manifest.name}`);
const broad = [...(manifest.host_permissions ?? []), ...(manifest.optional_host_permissions ?? [])].filter(
  (p) => p === "<all_urls>" || /^(\*|https?):\/\/\*\//.test(p),
);
if (broad.length) problems.push(`broad host permissions: ${broad.join(", ")}`);
for (const size of ["16", "32", "48", "128"]) {
  if (!manifest.icons?.[size]) problems.push(`manifest.icons is missing ${size}px`);
}

const msgRefs = [...JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)].map((m) => m[1]);
if (msgRefs.length || manifest.default_locale) {
  const catalog = async (locale) => JSON.parse(await readFile(`${dir}/_locales/${locale}/messages.json`, "utf8"));
  if (!manifest.default_locale) problems.push("manifest uses __MSG_ strings without default_locale");
  else if (!existsSync(`${dir}/_locales/${manifest.default_locale}/messages.json`))
    problems.push(`_locales/${manifest.default_locale}/messages.json is missing`);
  else {
    const base = await catalog(manifest.default_locale);
    for (const key of msgRefs) if (!base[key]) problems.push(`manifest references __MSG_${key}__, absent from the default locale`);
    for (const locale of await readdir(`${dir}/_locales`)) {
      const other = await catalog(locale);
      for (const key of Object.keys(base)) if (!other[key]) problems.push(`_locales/${locale} lacks message ${key}`);
    }
  }
}

const files = await readdir(dir, { recursive: true });
for (const f of files.filter((f) => f.endsWith(".map"))) problems.push(`source map in bundle: ${f}`);

// Escaped Chinese strings look like the "character encoding" obfuscation the
// store rejects as Red Titanium.
const ESCAPED_CJK = /\\u[4-9][0-9A-Fa-f]{3}/;
const REMOTE_CODE = [/\beval\(/, /\bnew Function\(/, /\bimportScripts\(/, /\bimport\(\s*["'`]https?:/];
const DEBUG_HELPER = "llmtMeasurePrompts";
for (const f of files.filter((f) => f.endsWith(".js"))) {
  const src = await readFile(`${dir}/${f}`, "utf8");
  for (const re of REMOTE_CODE) if (re.test(src)) problems.push(`${f} matches ${re}`);
  if (src.includes(DEBUG_HELPER)) problems.push(`${f} contains the debug helper ${DEBUG_HELPER}: gate it on __LLMT_DEBUG__`);
  if (ESCAPED_CJK.test(src)) problems.push(`${f} has \\uXXXX-escaped CJK text: build with esbuild charset "utf8"`);
}

if (problems.length) {
  console.error(`\ncheck-dist: ${dir} would be rejected:\n` + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
console.log(`check-dist: ${dir} ok (${files.length} entries checked)`);
