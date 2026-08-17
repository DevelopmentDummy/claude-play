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

/**
 * `.env*` 파일에 정의된 키 이름만 수집한다 (값은 파싱하지 않음).
 *
 * 이 오케스트레이터는 구 서버 → MCP → API 라우트 체인을 통해 spawn되므로
 * 구 서버의 process.env를 그대로 상속받는다. dotenv/@next/env의
 * loadEnvConfig는 이미 존재하는 env var를 덮어쓰지 않기 때문에,
 * 상속된 값을 그대로 넘기면 `.env.local` 수정이 재시작으로 영원히
 * 반영되지 않는다. spawn 시 이 키들을 제거해 새 프로세스가 파일에서
 * 다시 읽도록 강제한다.
 */
function collectEnvFileKeys() {
  const files = [
    ".env",
    ".env.local",
    ".env.development",
    ".env.development.local",
    ".env.production",
    ".env.production.local",
  ];
  const keys = new Set();
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(ROOT, f), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      if (m) keys.add(m[1]);
    }
  }
  return keys;
}

/**
 * 상속 env에서 `.env*` 유래 키를 걷어낸 사본을 만든다.
 *
 * `__NEXT_PROCESSED_ENV`도 반드시 함께 지워야 한다. @next/env의 processEnv()는
 * 이 플래그가 이미 서 있으면 `.env*` 파일을 읽어 loadedEnvFiles에는 채우면서도
 * process.env에는 단 하나도 반영하지 않고 즉시 반환한다. 키만 지우고 이 플래그를
 * 남겨두면 값이 복구되지 않고 통째로 사라진다.
 */
function spawnEnv(extra = {}) {
  const keys = collectEnvFileKeys();
  keys.add("__NEXT_PROCESSED_ENV");
  const env = { ...process.env };
  const stripped = [];
  for (const k of keys) {
    if (k in env) {
      delete env[k];
      stripped.push(k);
    }
  }
  if (stripped.length) {
    log(`stripped ${stripped.length} env keys from spawn env: ${stripped.join(", ")}`);
  }
  return { ...env, ...extra };
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
        env: spawnEnv({ NODE_OPTIONS: "" }),
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

  // ⚠️ NODE_ENV는 반드시 mode에 맞춰 강제한다.
  //
  // `npm run start`는 `set NODE_ENV=production`으로 시작하는데, 그 값이 서버 →
  // MCP 자식 → restart 오케스트레이터 → 새 서버로 계속 상속된다. 그래서 한 번
  // 프로덕션으로 띄운 뒤에는 `npm run dev`로 재시작해도 `server.ts`의
  // `const dev = NODE_ENV !== "production"`이 false가 되어 **프로덕션 모드로 뜬다**.
  // 증상: Next가 hot reload를 하지 않고 빌드된 .next만 서빙 → `src/` 수정이
  // 재빌드 전까지 반영되지 않는다("스테일 캐시"로 오진하기 쉽다).
  // `.env*` 유래 키를 걷어내는 spawnEnv()는 NODE_ENV를 건드리지 않으므로 여기서 처리한다.
  const childEnv = spawnEnv({ NODE_OPTIONS: "" });
  if (script === "dev") delete childEnv.NODE_ENV;
  else childEnv.NODE_ENV = "production";
  log(`spawn env NODE_ENV=${childEnv.NODE_ENV ?? "(unset — dev)"}`);

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
        env: childEnv,
        detached: true,
        stdio: ["ignore", outFd, errFd],
        windowsHide: true,
      });
    } else {
      child = spawn("npm", ["run", script], {
        cwd: ROOT,
        env: childEnv,
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
