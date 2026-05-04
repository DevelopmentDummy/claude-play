#!/usr/bin/env node
// Detached respawn orchestrator:
//   build (optional) → wait → kill old server → wait for port → spawn new server
// Spawned via cmd /c start /B + { detached: true, stdio: file, .unref() } so it
// survives the API route's parent death AND keeps logging through the kill.
//
// Args:
//   --mode dev|start    (default: read from data/.server.pid, fallback "dev")
//   --skip-build        (default: build runs first, only kill on success)

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const PID_FILE = path.join(ROOT, "data", ".server.pid");
const LOG_FILE = path.join(ROOT, "data", "restart.log");
const BUILD_LOG = path.join(ROOT, "data", "restart-build.log");
const NEW_SERVER_LOG = path.join(ROOT, "data", "restart-newserver.log");

const argv = process.argv.slice(2);
const argMode = (() => {
  const i = argv.indexOf("--mode");
  return i >= 0 ? argv[i + 1] : null;
})();
const skipBuild = argv.includes("--skip-build");

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

// Look up a Windows process's PPID and command line via PowerShell.
function getProcessInfoWin(pid) {
  if (!isWin || !pid) return null;
  const res = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue; if ($p) { $p | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress }`,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  if (!res.stdout || !res.stdout.trim()) return null;
  try {
    const obj = JSON.parse(res.stdout);
    return {
      pid: Number(obj.ProcessId) || null,
      ppid: Number(obj.ParentProcessId) || null,
      cmd: String(obj.CommandLine || ""),
    };
  } catch {
    return null;
  }
}

// Walk up the parent chain from the leaf server pid and return the topmost
// ancestor that still looks like part of the claude-bridge launch tree
// (npm.cmd run / tsx server.ts / cmd.exe wrappers including `cmd /K`).
//
// `.server.pid` records the deepest node process — but `taskkill /T /F` only
// kills DESCENDANTS, leaving the wrapper chain (cmd /K from `start /B
// npm.cmd`, npm-cli.js, the inner cmd /d /s /c, tsx) alive. Those orphans
// either keep the port held or accumulate across restarts.
function findTopmostBridgeAncestor(leafPid) {
  if (!isWin || !leafPid) return leafPid;
  const rootLower = ROOT.toLowerCase();
  const looksRelated = (cmdLine) => {
    const c = (cmdLine || "").toLowerCase();
    if (!c) return false;
    if (c.includes(rootLower)) return true;
    if (c.includes("server.ts")) return true;
    if (/\bnpm(?:\.cmd|-cli\.js)?\b.*\brun\b/.test(c)) return true;
    if (/\btsx\b/.test(c)) return true;
    return false;
  };
  let topmost = leafPid;
  let current = leafPid;
  const seen = new Set([leafPid]);
  for (let depth = 0; depth < 12; depth++) {
    const info = getProcessInfoWin(current);
    if (!info || !info.ppid) break;
    if (seen.has(info.ppid)) break;
    seen.add(info.ppid);
    const parent = getProcessInfoWin(info.ppid);
    if (!parent) break;
    if (!looksRelated(parent.cmd)) break;
    topmost = info.ppid;
    current = info.ppid;
  }
  return topmost;
}

function runBuild() {
  return new Promise((resolve) => {
    const start = Date.now();
    fs.appendFileSync(
      BUILD_LOG,
      `\n[${ts()}] === orchestrator running 'npm run build' ===\n`,
    );
    const outFd = fs.openSync(BUILD_LOG, "a");
    const errFd = fs.openSync(BUILD_LOG, "a");

    let child;
    try {
      child = spawn(isWin ? "npm.cmd" : "npm", ["run", "build"], {
        cwd: ROOT,
        env: { ...process.env, NODE_OPTIONS: "" },
        stdio: ["ignore", outFd, errFd],
        windowsHide: true,
        shell: isWin,
      });
    } catch (err) {
      log(`FAILED to spawn build: ${err && err.stack ? err.stack : String(err)}`);
      try { fs.closeSync(outFd); } catch {}
      try { fs.closeSync(errFd); } catch {}
      resolve({ ok: false, code: null, durationMs: Date.now() - start });
      return;
    }

    child.on("error", (err) => {
      log(`build spawn error: ${err && err.stack ? err.stack : String(err)}`);
    });
    child.on("close", (code) => {
      try { fs.closeSync(outFd); } catch {}
      try { fs.closeSync(errFd); } catch {}
      resolve({ ok: code === 0, code, durationMs: Date.now() - start });
    });
  });
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
  log(`spawning new server: npm run ${script} (cwd=${ROOT})`);

  // Capture new server's stdout/stderr to a log file so we can see why it dies.
  fs.appendFileSync(
    NEW_SERVER_LOG,
    `\n[${ts()}] === orchestrator spawning npm run ${script} ===\n`,
  );
  const outFd = fs.openSync(NEW_SERVER_LOG, "a");
  const errFd = fs.openSync(NEW_SERVER_LOG, "a");

  // On Windows, npm.cmd is a batch wrapper that requires cmd.exe. Use `shell: true`
  // so spawn invokes it through cmd.exe and inherits proper handle propagation.
  // Wrap with `cmd /c start /B` to break PPID tree (parent orchestrator may also
  // be transient) — but here orchestrator stays alive long enough that simple
  // detached + shell suffices.
  let child;
  try {
    if (isWin) {
      // `start /B npm.cmd ...` makes Windows auto-wrap the .cmd launch in
      // `cmd /K npm.cmd ...`, and /K never exits — the wrapper survives every
      // future restart's taskkill and accumulates as a zombie. Forcing an
      // explicit `cmd /c` makes `start` see a regular .exe (no /K injection),
      // and /c exits cleanly once npm finishes.
      child = spawn("cmd", ["/c", "start", "/B", "cmd", "/c", "npm.cmd", "run", script], {
        cwd: ROOT,
        env: { ...process.env, NODE_OPTIONS: "" },
        detached: true,
        stdio: ["ignore", outFd, errFd],
        windowsHide: true,
      });
    } else {
      child = spawn("npm", ["run", script], {
        cwd: ROOT,
        env: { ...process.env, NODE_OPTIONS: "" },
        detached: true,
        stdio: ["ignore", outFd, errFd],
        windowsHide: true,
      });
    }
  } catch (err) {
    log(`FAILED to spawn new server: ${err && err.stack ? err.stack : String(err)}`);
    try { fs.closeSync(outFd); } catch {}
    try { fs.closeSync(errFd); } catch {}
    return;
  }

  child.on("error", (err) => {
    log(`new server spawn error event: ${err && err.stack ? err.stack : String(err)}`);
  });
  child.on("exit", (code, signal) => {
    log(`new server child exited early (code=${code}, signal=${signal})`);
  });

  try { fs.closeSync(outFd); } catch {}
  try { fs.closeSync(errFd); } catch {}
  child.unref();
  log(`new server spawn requested (detached pid=${child.pid})`);
}

async function main() {
  log(`==== respawn orchestrator started (pid=${process.pid}, ppid=${process.ppid}, argMode=${argMode || "auto"}, skipBuild=${skipBuild}) ====`);
  log(`node=${process.version} platform=${process.platform} cwd=${ROOT}`);

  const info = readPidInfo();
  const oldPid = info?.pid;
  const port = info?.port || parseInt(process.env.PORT || "3340", 10);
  const mode = argMode || info?.mode || "dev";

  log(`detected old pid=${oldPid ?? "?"} port=${port} mode=${mode}`);

  // Step 1: Build first while old server is still serving traffic.
  // Old server stays alive throughout the build — only get killed if build succeeds.
  if (!skipBuild) {
    log("starting build phase (old server still running)");
    const buildResult = await runBuild();
    log(`build phase done: ok=${buildResult.ok} code=${buildResult.code} duration=${buildResult.durationMs}ms`);
    if (!buildResult.ok) {
      log("build FAILED — aborting restart, old server kept alive");
      log("==== orchestrator done (build failure) ====\n");
      return;
    }
  } else {
    log("skipBuild=true — skipping build phase");
  }

  // Step 2: Brief delay so any in-flight requests on the old server can finish
  await new Promise((r) => setTimeout(r, 500));
  log("post-build delay complete");

  if (oldPid) {
    const topPid = findTopmostBridgeAncestor(oldPid);
    if (topPid !== oldPid) {
      log(`killing old server tree from topmost ancestor pid=${topPid} (leaf=${oldPid})`);
    } else {
      log(`killing old server pid=${oldPid} (and child tree)`);
    }
    killPid(topPid);
    log(`taskkill returned, orchestrator still alive (pid=${process.pid})`);
  } else {
    log("no PID file found — relying on port-free wait");
  }

  const portFree = await waitForPortFree(port);
  log(portFree ? `port ${port} is free` : `port ${port} still in use after wait — proceeding anyway`);

  log("about to call spawnNewServer");
  spawnNewServer(mode);
  log("spawnNewServer returned");

  // Linger briefly so spawn-error and early-exit events have a chance to fire and log
  await new Promise((r) => setTimeout(r, 3000));
  log("==== orchestrator done ====\n");
}

main().catch((err) => {
  log(`FATAL: ${err && err.stack ? err.stack : String(err)}`);
  process.exit(1);
});
