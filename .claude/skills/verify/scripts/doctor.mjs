// Read-only: is this checkout ready to drive? Exit 0 = yes.
// Usage: node .claude/skills/verify/scripts/doctor.mjs
import { chromium } from "playwright";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BUILD_DIR, PROFILE_PREFIX, REPO, buildProblems } from "./harness.mjs";
import { strandedProcesses } from "./cleanup.mjs";

const lines = [];
let bad = false;
const check = (ok, msg, fix = "") => {
  lines.push(`${ok ? "ok  " : "FAIL"} ${msg}${!ok && fix ? `  → ${fix}` : ""}`);
  if (!ok) bad = true;
};
const info = (msg) => lines.push(`info ${msg}`);

const exe = chromium.executablePath();
check(existsSync(exe), `Playwright Chromium at ${exe}`, "npx playwright install chromium");

const problems = buildProblems();
check(problems.length === 0, problems.length ? problems.join("; ") : "dist-e2e/ is the E2E build and newer than src/ and public/", "npm run build:e2e");
if (existsSync(path.join(BUILD_DIR, "manifest.json"))) {
  const m = JSON.parse(readFileSync(path.join(BUILD_DIR, "manifest.json"), "utf8"));
  info(`build: ${m.name} v${m.version}; host_permissions: ${m.host_permissions.join(", ")}`);
}
const pkg = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8"));
info(`repo package version ${pkg.version}`);

const stranded = strandedProcesses();
check(stranded.length === 0, `${stranded.length} stranded verify browser process(es)`, "node .claude/skills/verify/scripts/cleanup.mjs");
const dirs = readdirSync(tmpdir()).filter((d) => d.startsWith(PROFILE_PREFIX));
info(`${dirs.length} verify temp dir(s) in ${tmpdir()}${dirs.length ? " (live runs or leftovers; cleanup.mjs removes leftovers)" : ""}`);

console.log(lines.join("\n"));
process.exit(bad ? 1 : 0);
