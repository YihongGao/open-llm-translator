// Builds dist/ and zips it for Chrome Web Store upload, refusing to package
// anything the store would reject or that must never ship.
// Usage: npm run package   → release/open-llm-translator-<version>.zip
//
// Fails unless npm run typecheck and npm test pass (before anything is built)
// and the build passes scripts/check-dist.mjs (the store-rejection checks).
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
try {
  execFileSync("node", ["scripts/check-dist.mjs", DIST], { stdio: "inherit" });
} catch {
  console.error("\npackage: refusing to package");
  process.exit(1);
}

const manifest = JSON.parse(await readFile(`${DIST}/manifest.json`, "utf8"));
const files = await readdir(DIST, { recursive: true });

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
