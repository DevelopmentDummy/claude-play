import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { getDataDir } from "./data-dir";

interface ProcEntry {
  pid: number;
  sessionId: string;
  name: string;
  /** Absolute path of the session directory the sub-agent runs in.
   *  Used by reap to guard against PID recycling. */
  dir: string;
  startedAt: string;
}

/** Pure path calculation — no mkdir side-effect. */
function regPath(): string {
  return path.join(getDataDir(), ".runtime", "subagent-procs.json");
}

function read(): ProcEntry[] {
  try {
    const raw = fs.readFileSync(regPath(), "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function write(entries: ProcEntry[]): void {
  try {
    const dir = path.dirname(regPath());
    fs.mkdirSync(dir, { recursive: true });
    /* best-effort: losing the registry only means orphans aren't reaped next boot */
    fs.writeFileSync(regPath(), JSON.stringify(entries, null, 2), "utf-8");
  } catch { /* ignore */ }
}

// Non-atomic read-modify-write is acceptable: sub spawns are single-writer in
// practice (sequential, server-process-mediated), so races are not a concern.
export function registerSubProc(pid: number, sessionId: string, name: string, dir: string): void {
  const entries = read().filter(e => e.pid !== pid);
  entries.push({ pid, sessionId, name, dir, startedAt: new Date().toISOString() });
  write(entries);
}

export function unregisterSubProc(pid: number): void {
  // Non-atomic read-modify-write — see note above registerSubProc.
  write(read().filter(e => e.pid !== pid));
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function killPid(pid: number): void {
  try {
    if (process.platform === "win32") execSync(`taskkill /T /F /PID ${pid}`, { stdio: "ignore" });
    else process.kill(pid);
  } catch { /* already gone */ }
}

/** Best-effort: read a live process's command line. Returns "" on any error. */
function getCmdline(pid: number): string {
  try {
    if (process.platform === "win32") {
      const out = execSync(
        `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine"`,
        { stdio: ["ignore", "pipe", "ignore"], timeout: 5000 },
      );
      return out.toString("utf-8");
    }
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf-8");
  } catch {
    return "";
  }
}

/** On server boot: kill any sub-agent PIDs that survived a previous server (orphans)
 *  and clear the registry. Guards against PID recycling: a dead sub's PID may have
 *  been reused by an unrelated process since last boot. We only kill a live PID when
 *  its command line still references the session directory we recorded (subs run with
 *  cwd/args under it). If we can't read the command line we skip the kill (fail safe).
 *  Mirrors the intent of the antigravity registry's name-based identity check. */
export function reapOrphanSubProcs(): void {
  const entries = read();
  for (const e of entries) {
    if (!isAlive(e.pid)) continue;
    // Guard against PID recycling: a dead sub's PID may have been reused by an
    // unrelated process. Only kill if the live process's command line still
    // references the session dir we recorded (subs run with cwd/args under it).
    // Mirrors the antigravity registry's name-based identity check. If we can't
    // read the command line, skip the kill (fail safe).
    const cmd = getCmdline(e.pid).toLowerCase();
    if (!cmd || !cmd.includes(e.dir.toLowerCase())) continue;
    console.log(`[subagent-registry] reaping orphan pid=${e.pid} (${e.sessionId}/${e.name})`);
    killPid(e.pid);
  }
  write([]);
}
