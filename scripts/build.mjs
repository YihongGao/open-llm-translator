// Bundles the extension entry points and copies static files.
// Usage: node scripts/build.mjs [--watch] [--e2e]
//   --e2e  writes dist-e2e/ with host access to all sites, so the Playwright
//          harness can inject the content script without a user gesture
//          (activeTab is only granted by a real click). Never ship this build.
import * as esbuild from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

const watch = process.argv.includes("--watch");
const e2e = process.argv.includes("--e2e");
const outdir = e2e ? "dist-e2e" : "dist";

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await cp("public", outdir, { recursive: true });

if (e2e) {
  const manifestPath = `${outdir}/manifest.json`;
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.name += " (E2E)";
  manifest.host_permissions = [...manifest.host_permissions, "<all_urls>"];
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}

const common = {
  bundle: true,
  target: "chrome120",
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  logLevel: "info",
};

const builds = [
  // MV3 service worker, declared with "type": "module" in manifest.json.
  { ...common, entryPoints: { background: "src/background/index.ts" }, format: "esm", outdir },
  // Content scripts and extension pages are classic scripts.
  { ...common, entryPoints: { content: "src/content/index.ts" }, format: "iife", outdir },
  // Injected into YouTube's main world (chrome.scripting world "MAIN").
  { ...common, entryPoints: { "youtube-hook": "src/page/youtube-hook.ts" }, format: "iife", outdir },
  { ...common, entryPoints: { options: "src/options/options.ts" }, format: "iife", outdir },
  { ...common, entryPoints: { popup: "src/popup/popup.ts" }, format: "iife", outdir },
];

if (watch) {
  const contexts = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log("watching… (static files in public/ are copied only at startup)");
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
