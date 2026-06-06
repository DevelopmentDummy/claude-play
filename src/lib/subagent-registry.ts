import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { getDataDir } from "./data-dir";

interface ProcEntry { pid: number; sessionId: string; name: string; startedAt: string; }

function regPath(): string {
  const dir = path.join(getDataDir(), ".runtime");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "subagent-procs.json");
}

function read(): ProcEntry[] {
  try {
    const raw = fs.readFileSync(regPath(), "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function write(entries: ProcEntry[]): void {
  try { fs.writeFileSync(regPath(), JSON.stringify(entries), "utf-8"); } catch { /* ignore */ }
}

export function registerSubProc(pid: number, sessionId: string, name: string): void {
  const entries = read().filter(e => e.pid !== pid);
  entries.push({ pid, sessionId, name, startedAt: new Date().toISOString() });
  write(entries);
}

export function unregisterSubProc(pid: number): void {
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

/** On server boot: kill any sub-agent PIDs that survived a previous server (orphans)
 *  and clear the registry. Live-checks each PID so we never kill a reused PID we know
 *  nothing about — only ones still recorded. */
export function reapOrphanSubProcs(): void {
  const entries = read();
  for (const e of entries) {
    if (isAlive(e.pid)) {
      console.log(`[subagent-registry] reaping orphan pid=${e.pid} (${e.sessionId}/${e.name})`);
      killPid(e.pid);
    }
  }
  write([]);
}
