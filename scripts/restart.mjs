#!/usr/bin/env node
// Detached respawn orchestrator: kill old server → wait for port → spawn new server
// Spawned via { detached: true, stdio: 'ignore', .unref() } so it survives parent death.
// Build is NOT done here — the API route runs `next build` synchronously while the
// old server is still alive, then only invokes this script if the build succeeded.
//
// Args:
//   --mode dev|start    (default: read from data/.server.pid, fallback "dev")

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const PID_FILE = path.join(ROOT, "data", ".server.pid");
const LOG_FILE = path.join(ROOT, "data", "restart.log");

const argv = process.argv.slice(2);
const argMode = (() => {
  const i = argv.indexOf("--mode");
  return i >= 0 ? argv[i + 1] : null;
})();

const isWin = process.platform === "win32";

function ts() {
  return new Date().toISOString();
}

function log(line) {
  const formatted = `[${ts()}] ${line}\n`;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, formatted);
  } catch {
    /* ignore log errors */
  }
}

function readPidInfo() {
  try {
    return JSON.parse(fs.readFileSync(PID_FILE, "utf8"));
  } catch {
    return null;
  }
}

function killPid(pid) {
  if (!pid) return;
  try {
    if (isWin) {
      spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    /* already dead */
  }
}

async function waitForPortFree(port, maxWaitMs = 20_000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (isWin) {
      const res = spawnSync("cmd", [
        "/c",
        `netstat -ano | findstr :${port} | findstr LISTENING`,
      ], { encoding: "utf8" });
      if (!res.stdout || !res.stdout.trim()) return true;
    } else {
      const res = spawnSync("lsof", ["-i", `:${port}`], { encoding: "utf8" });
      if (!res.stdout || !res.stdout.includes("LISTEN")) return true;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function spawnNewServer(mode) {
  const script = mode === "start" ? "start" : "dev";
  log(`spawning new server: npm run ${script}`);
  const child = spawn(isWin ? "npm.cmd" : "npm", ["run", script], {
    cwd: ROOT,
    env: { ...process.env, NODE_OPTIONS: "" },
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    shell: false,
  });
  child.unref();
  log(`new server spawn requested (detached pid=${child.pid})`);
}

async function main() {
  log(`==== respawn orchestrator started (argMode=${argMode || "auto"}) ====`);

  const info = readPidInfo();
  const oldPid = info?.pid;
  const port = info?.port || parseInt(process.env.PORT || "3340", 10);
  const mode = argMode || info?.mode || "dev";

  log(`detected old pid=${oldPid ?? "?"} port=${port} mode=${mode}`);

  // Brief delay so the API response can flush before we tear things down
  await new Promise((r) => setTimeout(r, 500));

  if (oldPid) {
    log(`killing old server pid=${oldPid} (and child tree)`);
    killPid(oldPid);
  } else {
    log("no PID file found — relying on port-free wait");
  }

  const portFree = await waitForPortFree(port);
  log(portFree ? `port ${port} is free` : `port ${port} still in use after wait — proceeding anyway`);

  spawnNewServer(mode);
  log("==== orchestrator done ====\n");
}

main().catch((err) => {
  log(`FATAL: ${err && err.stack ? err.stack : String(err)}`);
  process.exit(1);
});
