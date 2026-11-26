// Tears down what verify runs left behind after a crash: Chromium processes
// whose command line points into an llmt-verify-* temp dir, then those dirs.
// Never matches by process name, so the user's own Chrome is untouched.
// Never touches .verify-artifacts/ (the evidence).
//
// Usage: node .claude/skills/verify/scripts/cleanup.mjs [--dry-run]
import { execFileSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROFILE_PREFIX = "llmt-verify-"; // same as harness.mjs (not imported, so cleanup works even if harness breaks)

/** [{ pid, cmd }] of processes started by a verify run. */
export function strandedProcesses() {
  let rows;
  if (process.platform === "win32") {
    const ps = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${PROFILE_PREFIX}*' } | ForEach-Object { "$($_.ProcessId)\`t$($_.CommandLine)" }`;
    rows = execFileSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" }).split(/\r?\n/);
  } else {
    rows = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" })
      .split("\n")
      .map((l) => l.trim().replace(/^(\d+)\s+/, "$1\t"));
  }
  return rows
    .map((l) => l.split("\t"))
    .filter(([pid, cmd]) => pid && cmd?.includes(PROFILE_PREFIX) && Number(pid) !== process.pid && !cmd.includes("Get-CimInstance"))
    .map(([pid, cmd]) => ({ pid: Number(pid), cmd }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dry = process.argv.includes("--dry-run");
  const procs = strandedProcesses();
  for (const p of procs) {
    console.log(`${dry ? "would kill" : "kill"} ${p.pid}: ${p.cmd.slice(0, 140)}`);
    if (!dry) {
      try {
        process.kill(p.pid);
      } catch {} // already gone (killing the browser takes its children with it)
    }
  }
  if (!dry && procs.length) await new Promise((r) => setTimeout(r, 1000)); // let Windows release file locks
  const dirs = readdirSync(tmpdir()).filter((d) => d.startsWith(PROFILE_PREFIX));
  for (const d of dirs) {
    console.log(`${dry ? "would remove" : "remove"} ${path.join(tmpdir(), d)}`);
    if (!dry) rmSync(path.join(tmpdir(), d), { recursive: true, force: true, maxRetries: 5 });
  }
  console.log(`cleanup: ${procs.length} process(es), ${dirs.length} temp dir(s)${dry ? " (dry run)" : ""}; .verify-artifacts/ kept`);
}
