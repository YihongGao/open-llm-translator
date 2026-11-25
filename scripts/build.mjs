// Bundles the three extension entry points and copies static files into dist/.
// Usage: node scripts/build.mjs [--watch]
import * as esbuild from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const watch = process.argv.includes("--watch");
const outdir = "dist";

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await cp("public", outdir, { recursive: true });

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
  { ...common, entryPoints: { options: "src/options/options.ts" }, format: "iife", outdir },
];

if (watch) {
  const contexts = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log("watching… (static files in public/ are copied only at startup)");
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
