import { createServer, type IncomingMessage, type ServerResponse } from "http";
import next from "next";
import { parse } from "url";
import { spawn, execSync, type ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { setupWebSocket } from "./src/lib/ws-server";
import { handleTtsRequest } from "./src/lib/tts-handler";
import { isAuthEnabled, verifyAuthToken, parseCookieToken } from "./src/lib/auth";
import { shouldRedirectToSetup } from "./src/lib/setup-guard";

const dev = process.env.NODE_ENV !== "production";
const hostname = "0.0.0.0";
const port = parseInt(process.env.PORT || "3340", 10);
const ttsPort = parseInt(process.env.TTS_PORT || String(port + 1), 10);
const GPU_MANAGER_PORT = parseInt(process.env.GPU_MANAGER_PORT || String(port + 2), 10);
const GPU_MANAGER_PYTHON = process.env.GPU_MANAGER_PYTHON || "python";

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
    if (code !== null && code !== 0) {
      console.error(`[tts] TTS server exited with code ${code}`);
    }
  });

  return child;
}

/** Kill TTS server process (Windows-safe) */
function killTtsServer(child: ChildProcess | null) {
  if (!child || child.killed || !child.pid) return;
  try {
    execSync(`taskkill /T /F /PID ${child.pid}`, { stdio: "ignore" });
  } catch {
    try { child.kill(); } catch {}
  }
}

/** Spawn GPU Manager Python process (killed when parent exits) */
let gpuManagerRestarts = 0;
const GPU_MANAGER_MAX_RESTARTS = 3;

function spawnGpuManager(): ChildProcess | null {
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

  child.stdout?.on("data", (d: Buffer) => process.stdout.write(d));
  child.stderr?.on("data", (d: Buffer) => process.stderr.write(d));

  child.on("exit", (code) => {
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
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
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
const g = globalThis as Record<string, unknown>;

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

// Kill previous child processes from prior hot-reload cycle
killPid(g.__ttsPid as number | undefined);
killPid(g.__gpuManagerPid as number | undefined);
// Also kill anything still on GPU Manager port (fallback)
killProcessOnPort(GPU_MANAGER_PORT);

const ttsProcess = spawnTtsServer();
let gpuManagerProcess = spawnGpuManager();
g.__ttsPid = ttsProcess?.pid;
g.__gpuManagerPid = gpuManagerProcess?.pid;

for (const sig of ["exit", "SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    killTtsServer(ttsProcess);
    killGpuManager(gpuManagerProcess);
  });
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
