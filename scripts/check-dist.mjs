// Refuses a build the Chrome Web Store would reject or that must never ship.
// Usage: node scripts/check-dist.mjs [dir]   (default dist; build it first)
// Exit 1 lists every problem. Run by CI on each PR and by scripts/package.mjs.
//
// Checks:
//   - manifest: no "(E2E)" name, no broad host access (<all_urls>, *://*/*),
//     icons at 16/32/48/128
//   - no source maps in the bundle
//   - no remote or dynamic code: eval(, new Function(, importScripts(,
//     import("http…") — MV3 forbids executing code not shipped in the package
//   - no \uXXXX-escaped CJK text (reads as obfuscation to store reviewers)
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

const files = await readdir(dir, { recursive: true });
for (const f of files.filter((f) => f.endsWith(".map"))) problems.push(`source map in bundle: ${f}`);

// Escaped Chinese strings look like the "character encoding" obfuscation the
// store rejects as Red Titanium.
const ESCAPED_CJK = /\\u[4-9][0-9A-Fa-f]{3}/;
const REMOTE_CODE = [/\beval\(/, /\bnew Function\(/, /\bimportScripts\(/, /\bimport\(\s*["'`]https?:/];
for (const f of files.filter((f) => f.endsWith(".js"))) {
  const src = await readFile(`${dir}/${f}`, "utf8");
  for (const re of REMOTE_CODE) if (re.test(src)) problems.push(`${f} matches ${re}`);
  if (ESCAPED_CJK.test(src)) problems.push(`${f} has \\uXXXX-escaped CJK text: build with esbuild charset "utf8"`);
}

if (problems.length) {
  console.error(`\ncheck-dist: ${dir} would be rejected:\n` + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
console.log(`check-dist: ${dir} ok (${files.length} entries checked)`);
