// Builds dist/ and zips it for Chrome Web Store upload, refusing to package
// anything the store would reject or that must never ship.
// Usage: npm run package   → release/llm-bilingual-translator-<version>.zip
//
// Checks (each one fails the run):
//   - manifest: no "(E2E)" name, no broad host access (<all_urls>, *://*/*)
//   - no source maps in the bundle
//   - no remote or dynamic code: eval(, new Function(, importScripts(,
//     import("http…") — MV3 forbids executing code not shipped in the package
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const DIST = "dist";
const RELEASE = "release";

execFileSync("node", ["scripts/build.mjs"], { stdio: "inherit" });

const problems = [];
const manifest = JSON.parse(await readFile(`${DIST}/manifest.json`, "utf8"));

if (manifest.name.includes("(E2E)")) problems.push(`manifest name is the E2E build's: ${manifest.name}`);
const broad = [...(manifest.host_permissions ?? []), ...(manifest.optional_host_permissions ?? [])].filter(
  (p) => p === "<all_urls>" || /^(\*|https?):\/\/\*\//.test(p),
);
if (broad.length) problems.push(`broad host permissions: ${broad.join(", ")}`);
for (const size of ["16", "32", "48", "128"]) {
  if (!manifest.icons?.[size]) problems.push(`manifest.icons is missing ${size}px`);
}

const files = await readdir(DIST, { recursive: true });
for (const f of files.filter((f) => f.endsWith(".map"))) problems.push(`source map in bundle: ${f}`);

const REMOTE_CODE = [/\beval\(/, /\bnew Function\(/, /\bimportScripts\(/, /\bimport\(\s*["'`]https?:/];
for (const f of files.filter((f) => f.endsWith(".js"))) {
  const src = await readFile(`${DIST}/${f}`, "utf8");
  for (const re of REMOTE_CODE) if (re.test(src)) problems.push(`${f} matches ${re}`);
}

if (problems.length) {
  console.error("\npackage: refusing to package:\n" + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}

await mkdir(RELEASE, { recursive: true });
const out = resolve(RELEASE, `llm-bilingual-translator-${manifest.version}.zip`);
await rm(out, { force: true });
// Zip the contents of dist/ so manifest.json sits at the archive root; -X drops
// macOS extended attributes.
execFileSync("zip", ["-r", "-X", "-q", out, ".", "-x", ".DS_Store", "-x", "*/.DS_Store"], { cwd: DIST });
console.log(`\npackage: wrote ${out} (version ${manifest.version}, ${files.length} entries checked)`);
