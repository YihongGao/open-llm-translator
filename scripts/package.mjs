// Builds dist/ and zips it for Chrome Web Store upload, refusing to package
// anything the store would reject or that must never ship.
// Usage: npm run package   → release/open-llm-translator-<version>.zip
//
// Checks (each one fails the run):
//   - npm run typecheck and npm test pass (before anything is built)
//   - manifest: no "(E2E)" name, no broad host access (<all_urls>, *://*/*)
//   - no source maps in the bundle
//   - no remote or dynamic code: eval(, new Function(, importScripts(,
//     import("http…") — MV3 forbids executing code not shipped in the package
//   - no \uXXXX-escaped CJK text (reads as obfuscation to store reviewers)
import { execFileSync, execSync } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { zipSync } from "fflate";

const DIST = "dist";
const RELEASE = "release";

// Never zip a build whose types or tests are broken. Through the shell so
// `npm` resolves to npm.cmd on Windows.
for (const script of ["typecheck", "test"]) {
  try {
    execSync(`npm run ${script}`, { stdio: "inherit" });
  } catch {
    console.error(`\npackage: refusing to package: \`npm run ${script}\` failed`);
    process.exit(1);
  }
}

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

// Escaped Chinese strings look like the "character encoding" obfuscation the
// store rejects as Red Titanium.
const ESCAPED_CJK = /\\u[4-9][0-9A-Fa-f]{3}/;
const REMOTE_CODE = [/\beval\(/, /\bnew Function\(/, /\bimportScripts\(/, /\bimport\(\s*["'`]https?:/];
for (const f of files.filter((f) => f.endsWith(".js"))) {
  const src = await readFile(`${DIST}/${f}`, "utf8");
  for (const re of REMOTE_CODE) if (re.test(src)) problems.push(`${f} matches ${re}`);
  if (ESCAPED_CJK.test(src)) problems.push(`${f} has \\uXXXX-escaped CJK text: build with esbuild charset "utf8"`);
}

if (problems.length) {
  console.error("\npackage: refusing to package:\n" + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}

await mkdir(RELEASE, { recursive: true });
const out = resolve(RELEASE, `open-llm-translator-${manifest.version}.zip`);
// Zip the contents of dist/ so manifest.json sits at the archive root. Entry
// names use "/" on every OS (readdir returns "\" on Windows).
const entries = {};
for (const f of files) {
  const name = f.split(sep).join("/");
  if (name.split("/").pop() === ".DS_Store") continue;
  const path = `${DIST}/${name}`;
  if ((await stat(path)).isFile()) entries[name] = await readFile(path);
}
await writeFile(out, zipSync(entries, { level: 9 }));
console.log(`\npackage: wrote ${out} (version ${manifest.version}, ${files.length} entries checked)`);
