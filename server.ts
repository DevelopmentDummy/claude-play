import { createServer, type IncomingMessage, type ServerResponse } from "http";
import next from "next";
import { parse } from "url";
import { spawn, execSync, type ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { loadEnvConfig } from "@next/env";
import { setupWebSocket } from "./src/lib/ws-server";
import { handleTtsRequest } from "./src/lib/tts-handler";
import { isAuthEnabled, verifyAuthToken, parseCookieToken } from "./src/lib/auth";
import { shouldRedirectToSetup } from "./src/lib/setup-guard";
import { destroyAllBackgroundProcesses } from "./src/lib/background-session";
import { destroyAllInstances } from "./src/lib/session-registry";
import { reapOrphanSubProcs } from "./src/lib/subagent-registry";

loadEnvConfig(process.cwd());

const dev = process.env.NODE_ENV !== "production";
const hostname = "0.0.0.0";
const port = parseInt(process.env.PORT || "3340", 10);
const ttsPort = parseInt(process.env.TTS_PORT || String(port + 1), 10);
const GPU_MANAGER_PORT = parseInt(process.env.GPU_MANAGER_PORT || String(port + 2), 10);
const GPU_MANAGER_PYTHON = process.env.GPU_MANAGER_PYTHON || "python";
interface ServerGlobals extends Record<string, unknown> {
  __ttsPid?: number;
  __gpuManagerPid?: number;
  __comfyuiPid?: number;
  __cleanupRegistered?: boolean;
  __shuttingDown?: boolean;
}
const g = globalThis as ServerGlobals;

/** Spawn standalone TTS server as a child process (killed when parent exits) */
function spawnTtsServer(): ChildProcess | null {
  if (process.env.TTS_ENABLED === "false") {
    console.log("[tts] TTS disabled via TTS_ENABLED=false");
    return null;
  }

  const serverPath = path.join(process.cwd(), "tts-server.mjs");
  const child = spawn("node", [serverPath, String(ttsPort)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_OPTIONS: "" },
    windowsHide: true,
  });

  child.stdout?.on("data", (d: Buffer) => process.stdout.write(d));
  child.stderr?.on("data", (d: Buffer) => process.stderr.write(d));

  child.on("exit", (code) => {
    if (!g.__shuttingDown && code !== null && code !== 0) {
      console.error(`[tts] TTS server exited with code ${code}`);
    }
  });

  return child;
}

/** Kill TTS server process (Windows-safe) */
function killTtsServer(child: ChildProcess | null) {
  if (!child || child.killed || !child.pid) return;
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /T /F /PID ${child.pid}`, { stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    try { child.kill(); } catch {}
  }
}

/** Spawn GPU Manager Python process (killed when parent exits) */
let gpuManagerWaiting = false;
const gpuManagerBuffered: Buffer[] = [];
let gpuManagerRestarts = 0;
const GPU_MANAGER_MAX_RESTARTS = 3;

function spawnGpuManager(): ChildProcess | null {
  if (process.env.GPU_MANAGER_ENABLED === "false") {
    console.log("[gpu-manager] disabled via GPU_MANAGER_ENABLED=false");
    return null;
  }
  const serverScript = path.join(process.cwd(), "gpu-manager", "server.py");
  if (!fs.existsSync(serverScript)) {
    console.log("[gpu-manager] server.py not found, skipping");
    return null;
  }

  const comfyuiHost = process.env.COMFYUI_HOST || "127.0.0.1";
  const comfyuiPort = process.env.COMFYUI_PORT || "8188";
  const comfyuiUrl = `http://${comfyuiHost}:${comfyuiPort}`;

  const child = spawn(GPU_MANAGER_PYTHON, [
    serverScript,
    "--port", String(GPU_MANAGER_PORT),
    "--comfyui-url", comfyuiUrl,
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
    windowsHide: true,
  });

  child.stdout?.on("data", (d: Buffer) => {
    if (gpuManagerWaiting) gpuManagerBuffered.push(d);
    else process.stdout.write(d);
  });
  child.stderr?.on("data", (d: Buffer) => {
    if (gpuManagerWaiting) gpuManagerBuffered.push(d);
    else process.stderr.write(d);
  });

  child.on("exit", (code) => {
    if (g.__shuttingDown) {
      return;
    }
    if (code !== null && code !== 0) {
      console.error(`[gpu-manager] exited with code ${code}`);
      if (gpuManagerRestarts < GPU_MANAGER_MAX_RESTARTS) {
        gpuManagerRestarts++;
        console.log(`[gpu-manager] restarting (${gpuManagerRestarts}/${GPU_MANAGER_MAX_RESTARTS})...`);
        (async () => {
          // Kill anything still holding the port, then wait for it to be free
          killProcessOnPort(GPU_MANAGER_PORT);
          await waitForPortFree(GPU_MANAGER_PORT);
          gpuManagerProcess = spawnGpuManager();
          g.__gpuManagerPid = gpuManagerProcess?.pid;
        })();
      } else {
        console.error("[gpu-manager] max restarts reached, GPU features disabled");
      }
    }
  });

  return child;
}

function killGpuManager(child: ChildProcess | null) {
  if (!child || child.killed || !child.pid) return;
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /T /F /PID ${child.pid}`, { stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    try { child.kill(); } catch {}
  }
}

async function waitForGpuManager(maxWaitMs = 30_000): Promise<boolean> {
  const url = `http://127.0.0.1:${GPU_MANAGER_PORT}/health`;
  const deadline = Date.now() + maxWaitMs;
  const dotInterval = setInterval(() => process.stdout.write("."), 1000);
  gpuManagerWaiting = true;
  process.stdout.write("[gpu-manager] waiting");
  try {
    while (Date.now() < deadline) {
      try {
        const res = await fetch(url);
        if (res.ok) { process.stdout.write("\n"); return true; }
      } catch { /* not ready yet */ }
      await new Promise(r => setTimeout(r, 1000));
    }
    process.stdout.write("\n");
    return false;
  } finally {
    clearInterval(dotInterval);
    gpuManagerWaiting = false;
    for (const buf of gpuManagerBuffered) process.stderr.write(buf);
    gpuManagerBuffered.length = 0;
  }
}

/**
 * Resolve the Python interpreter to use for ComfyUI.
 * Priority: COMFYUI_PYTHON env > <comfyuiDir>/venv (Scripts|bin)/python(.exe).
 * Returns null if no usable interpreter is found — caller should skip spawn.
 */
function resolveComfyuiPython(comfyuiDir: string): string | null {
  if (process.env.COMFYUI_PYTHON) return process.env.COMFYUI_PYTHON;
  const venvPython = process.platform === "win32"
    ? path.join(comfyuiDir, "venv", "Scripts", "python.exe")
    : path.join(comfyuiDir, "venv", "bin", "python");
  return fs.existsSync(venvPython) ? venvPython : null;
}

/** Check if any process is LISTENING on a given port. */
function isPortInUse(p: number): boolean {
  if (process.platform === "win32") {
    try {
      const out = execSync(`netstat -ano | findstr :${p} | findstr LISTENING`, {
        encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
      });
      return !!out.trim();
    } catch { return false; }
  }
  try {
    const out = execSync(`lsof -i :${p} -t`, { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
    return !!out.trim();
  } catch { return false; }
}

/**
 * Spawn ComfyUI as a child process. Opt-in via COMFYUI_AUTOSTART=true and
 * COMFYUI_DIR. Skips if the configured port already has a LISTENING process
 * (treated as "already running").
 */
function spawnComfyui(): ChildProcess | null {
  if (process.env.COMFYUI_AUTOSTART !== "true") return null;
  const comfyuiDir = process.env.COMFYUI_DIR;
  if (!comfyuiDir) {
    console.log("[comfyui] COMFYUI_AUTOSTART=true but COMFYUI_DIR unset — skipping");
    return null;
  }
  if (!fs.existsSync(path.join(comfyuiDir, "main.py"))) {
    console.warn(`[comfyui] main.py not found in ${comfyuiDir} — skipping`);
    return null;
  }

  const comfyuiHost = process.env.COMFYUI_HOST || "127.0.0.1";
  const comfyuiPort = parseInt(process.env.COMFYUI_PORT || "8188", 10);

  if (isPortInUse(comfyuiPort)) {
    console.log(`[comfyui] port ${comfyuiPort} already in use — assuming external instance, skipping spawn`);
    return null;
  }

  const python = resolveComfyuiPython(comfyuiDir);
  if (!python) {
    console.warn(`[comfyui] no venv python at ${comfyuiDir}/venv — set COMFYUI_PYTHON or create the venv. Skipping.`);
    return null;
  }

  console.log(`[comfyui] spawning ${python} main.py --listen ${comfyuiHost} --port ${comfyuiPort}`);
  const child = spawn(python, [
    "main.py",
    "--listen", comfyuiHost,
    "--port", String(comfyuiPort),
  ], {
    cwd: comfyuiDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
    windowsHide: true,
  });

  child.stdout?.on("data", (d: Buffer) => process.stdout.write(d));
  child.stderr?.on("data", (d: Buffer) => process.stderr.write(d));

  child.on("exit", (code) => {
    if (!g.__shuttingDown && code !== null && code !== 0) {
      console.error(`[comfyui] exited with code ${code}`);
    }
  });

  return child;
}

function killComfyui(child: ChildProcess | null) {
  if (!child || child.killed || !child.pid) return;
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /T /F /PID ${child.pid}`, { stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    try { child.kill(); } catch {}
  }
}

/** Wait until ComfyUI's HTTP API is responsive (or timeout). */
async function waitForComfyui(maxWaitMs = 60_000): Promise<boolean> {
  const host = process.env.COMFYUI_HOST || "127.0.0.1";
  const port = parseInt(process.env.COMFYUI_PORT || "8188", 10);
  const url = `http://${host}:${port}/system_stats`;
  const deadline = Date.now() + maxWaitMs;
  const dotInterval = setInterval(() => process.stdout.write("."), 1000);
  process.stdout.write("[comfyui] waiting");
  try {
    while (Date.now() < deadline) {
      try {
        const res = await fetch(url);
        if (res.ok) { process.stdout.write("\n"); return true; }
      } catch { /* not ready yet */ }
      await new Promise(r => setTimeout(r, 1000));
    }
    process.stdout.write("\n");
    return false;
  } finally {
    clearInterval(dotInterval);
  }
}

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

/** Read JSON body from incoming request */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { resolve(null); }
    });
    req.on("error", reject);
  });
}

/** Send JSON response */
function sendJson(res: ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

// Spawn TTS server and GPU Manager, ensure cleanup on exit
// Use globalThis PIDs to survive tsx watch hot-reloads
/** Kill process by PID (Windows-safe, ignores errors) */
function killPid(pid: number | undefined) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /T /F /PID ${pid}`, { stdio: "ignore" });
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch { /* already dead */ }
}

/** Wait until a port is free (no LISTENING process), up to maxWaitMs */
async function waitForPortFree(p: number, maxWaitMs = 15_000): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const out = execSync(`netstat -ano | findstr :${p} | findstr LISTENING`, {
        encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
      });
      if (!out.trim()) break;
    } catch {
      break; // findstr found nothing — port is free
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}

/** Kill any process listening on a given port (Windows) */
function killProcessOnPort(p: number) {
  if (process.platform !== "win32") return;
  try {
    const out = execSync(`netstat -ano | findstr :${p} | findstr LISTENING`, { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
    const pids = new Set(out.split("\n").map(l => parseInt(l.trim().split(/\s+/).pop() || "", 10)).filter(n => n > 0));
    for (const pid of pids) killPid(pid);
  } catch { /* nothing listening */ }
}

function cleanupManagedProcesses(): void {
  g.__shuttingDown = true;
  killPid(g.__ttsPid);
  killPid(g.__gpuManagerPid);
  killPid(g.__comfyuiPid);
  destroyAllBackgroundProcesses();
  // Tree-kill all active session AI processes (Antigravity/Claude/Codex/Gemini/Kimi)
  try { destroyAllInstances(); } catch (err) { console.warn("[cleanup] destroyAllInstances failed:", err); }
}

/** Kill any stale agy.exe processes left behind from prior runs (Windows only).
 *  AntigravityProcess spawns agy with `--prompt-interactive spike-init` via
 *  `Start-Process -WindowStyle Hidden`, which detaches the child from Node's
 *  process tree. If Node crashes or hot-reloads while a turn is in flight, the
 *  agy LS host survives with no parent to clean it up. We match by the marker
 *  arg so non-bridge agy invocations (e.g. user running `agy` manually) are
 *  untouched. */
function killStaleAntigravityProcesses(): void {
  if (process.platform !== "win32") return;
  try {
    const out = execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='agy.exe'\\" | Where-Object { $_.CommandLine -like '*spike-init*' } | Select-Object -ExpandProperty ProcessId"`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] },
    );
    const pids = out.split(/\r?\n/).map(s => parseInt(s.trim(), 10)).filter(n => n > 0);
    for (const pid of pids) {
      try { execSync(`taskkill /T /F /PID ${pid}`, { stdio: "ignore" }); } catch { /* already dead */ }
    }
    if (pids.length > 0) console.log(`[cleanup] killed ${pids.length} stale agy process(es): ${pids.join(", ")}`);
  } catch { /* powershell or wmi unavailable — silent */ }
}

// Kill previous child processes from prior hot-reload cycle
killPid(g.__ttsPid);
killPid(g.__gpuManagerPid);
killPid(g.__comfyuiPid);
// Also kill anything still on GPU Manager port (fallback)
killProcessOnPort(GPU_MANAGER_PORT);
// Sweep orphan Antigravity agy.exe processes from prior crashes/hot-reloads
killStaleAntigravityProcesses();
// Reap any sub-agent PIDs that survived a previous server boot
reapOrphanSubProcs();

const ttsProcess = spawnTtsServer();
let gpuManagerProcess = spawnGpuManager();
const comfyuiProcess = spawnComfyui();
g.__ttsPid = ttsProcess?.pid;
g.__gpuManagerPid = gpuManagerProcess?.pid;
g.__comfyuiPid = comfyuiProcess?.pid;
g.__shuttingDown = false;

// Write our own PID so external scripts (e.g. scripts/restart.mjs) can find us
try {
  const pidFile = path.join(process.cwd(), "data", ".server.pid");
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, JSON.stringify({
    pid: process.pid,
    port,
    mode: dev ? "dev" : "start",
    startedAt: new Date().toISOString(),
  }, null, 2));
} catch (err) {
  console.warn("[server] failed to write PID file:", err);
}

if (!g.__cleanupRegistered) {
  g.__cleanupRegistered = true;
  for (const sig of ["exit", "SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, cleanupManagedProcesses);
  }
}

app.prepare().then(async () => {
  // Wait for GPU Manager to be ready
  if (gpuManagerProcess) {
    const ready = await waitForGpuManager();
    if (ready) {
      console.log("[gpu-manager] ready");
    } else {
      console.warn("[gpu-manager] failed to start, GPU features may be unavailable");
    }
  }
  // Wait for ComfyUI to be ready (when auto-spawned). Failures are non-fatal —
  // ComfyUI clients will surface errors per-call; we just log here.
  if (comfyuiProcess) {
    const ready = await waitForComfyui();
    if (ready) {
      console.log("[comfyui] ready");
    } else {
      console.warn("[comfyui] failed to start within timeout — image features may be unavailable");
    }
  }
  const server = createServer(async (req, res) => {
    const parsedUrl = parse(req.url!, true);
    const pathname = parsedUrl.pathname || "";

    // Redirect to /setup if setup is not complete
    if (shouldRedirectToSetup(pathname)) {
      res.writeHead(302, { Location: "/setup" });
      res.end();
      return;
    }

    // Auth check for intercepted routes
    if (isAuthEnabled()) {
      const isIntercepted = pathname === "/api/chat/tts"
        || /^\/api\/personas\/[^/]+\/voice\/generate$/.test(pathname);

      if (isIntercepted) {
        const cookieToken = parseCookieToken(req.headers.cookie);
        if (!cookieToken || !verifyAuthToken(cookieToken)) {
          return sendJson(res, 401, { error: "Unauthorized" });
        }
      }
    }

    // Intercept TTS routes — run in plain Node context to avoid App Router runtime interference
    // with outbound WebSocket connections (node-edge-tts / ws)
    if (pathname === "/api/chat/tts" && req.method === "POST") {
      const body = await readJsonBody(req);
      const result = await handleTtsRequest("chat-tts", body);
      return sendJson(res, result.status, result.data);
    }

    const voiceGenMatch = pathname.match(/^\/api\/personas\/([^/]+)\/voice\/generate$/);
    if (voiceGenMatch) {
      const name = decodeURIComponent(voiceGenMatch[1]);
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        const result = await handleTtsRequest("voice-generate-post", body, name);
        return sendJson(res, result.status, result.data);
      }
      if (req.method === "GET") {
        const result = await handleTtsRequest("voice-generate-get", parsedUrl.query, name);
        if (result.binary) {
          res.writeHead(200, {
            "Content-Type": "audio/mpeg",
            "Content-Length": result.binary.length,
          });
          return res.end(result.binary);
        }
        return sendJson(res, result.status, result.data);
      }
    }

    handle(req, res, parsedUrl);
  });

  setupWebSocket(server);

  server.listen(port, hostname, () => {
    console.log(`> Ready on http://${hostname}:${port}`);
  });
});
