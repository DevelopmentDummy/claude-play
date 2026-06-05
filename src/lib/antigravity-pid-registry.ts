import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { getDataDir } from "./data-dir";

/**
 * Disk-persisted registry of spawned agy.exe PIDs.
 *
 * Why this exists: agy.exe is launched fully detached via PowerShell
 * `Start-Process` (see antigravity-process.ts) and its PID is otherwise only
 * tracked in memory. When the dev server restarts (`tsx watch` on any code
 * edit) the in-memory PID is lost but the detached agy.exe keeps running, with
 * the session directory as its working directory — which holds a Windows
 * directory handle and makes `fs.renameSync` (soft-delete) fail with EBUSY.
 *
 * Recording each spawn here lets the delete routes reap those orphans even
 * after the owning instance is gone. Killing always verifies the PID is still
 * a live agy.exe first, so a recycled PID is never mistakenly killed.
 */

interface AgyProcEntry {
  pid: number;
  cwd: string;
  cascadeId: string | null;
  spawnedAt: number;
}

function registryPath(): string {
  return path.join(getDataDir(), ".runtime", "agy-procs.json");
}

function readRegistry(): AgyProcEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath(), "utf-8"));
    return Array.isArray(parsed)
      ? parsed.filter((e) => e && typeof e.pid === "number" && typeof e.cwd === "string")
      : [];
  } catch {
    return [];
  }
}

function writeRegistry(entries: AgyProcEntry[]): void {
  const p = registryPath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(entries), "utf-8");
  } catch {
    /* best-effort — losing the registry only degrades to the old behaviour */
  }
}

function dirExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** PIDs that are currently live agy.exe processes. One PowerShell call.
 *  Guards taskkill against PID recycling — we never kill a non-agy PID. */
function liveAgyPids(): Set<number> {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "Get-Process -Name agy -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id"`,
      { encoding: "utf-8" },
    );
    return new Set(
      out
        .split(/\r?\n/)
        .map((s) => Number(s.trim()))
        .filter((n) => n > 0),
    );
  } catch {
    return new Set();
  }
}

/** Record a freshly-spawned agy.exe PID. Prunes entries whose cwd no longer
 *  exists so the file stays bounded across many sessions. */
export function recordAgyPid(pid: number, cwd: string, cascadeId: string | null): void {
  if (!pid || Number.isNaN(pid)) return;
  const resolved = path.resolve(cwd);
  const entries = readRegistry().filter((e) => e.pid !== pid && dirExists(e.cwd));
  entries.push({ pid, cwd: resolved, cascadeId, spawnedAt: Date.now() });
  writeRegistry(entries);
}

/** Drop a PID from the registry (called right after a tracked kill). */
export function forgetAgyPid(pid: number | null): void {
  if (!pid) return;
  const entries = readRegistry();
  const next = entries.filter((e) => e.pid !== pid);
  if (next.length !== entries.length) writeRegistry(next);
}

export interface ReapResult {
  matched: number[];
  killed: number[];
}

/**
 * Kill every recorded agy.exe whose working directory is `dir` (or under it),
 * then drop those entries from the registry. Each PID is verified as a live
 * agy.exe before taskkill. Pass `{ dryRun: true }` to report matches without
 * killing and without mutating the registry.
 */
export function killAgyForDir(dir: string, opts: { dryRun?: boolean } = {}): ReapResult {
  const targetLc = path.resolve(dir).toLowerCase();
  const prefix = targetLc + path.sep;
  const entries = readRegistry();
  const live = liveAgyPids();
  const matched: number[] = [];
  const killed: number[] = [];
  const remaining: AgyProcEntry[] = [];

  for (const e of entries) {
    const ecwd = path.resolve(e.cwd).toLowerCase();
    const isMatch = ecwd === targetLc || ecwd.startsWith(prefix);
    if (!isMatch) {
      remaining.push(e);
      continue;
    }
    matched.push(e.pid);
    if (live.has(e.pid)) {
      if (opts.dryRun) {
        remaining.push(e);
        continue;
      }
      try {
        execSync(`taskkill /T /F /PID ${e.pid}`, { stdio: "pipe" });
        killed.push(e.pid);
      } catch {
        /* already gone or access denied — drop the entry regardless */
      }
    }
    // matched-but-dead, or successfully killed: entry is dropped (not pushed).
  }

  if (!opts.dryRun) writeRegistry(remaining);
  return { matched, killed };
}
