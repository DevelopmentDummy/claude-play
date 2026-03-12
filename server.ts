import { createServer, type IncomingMessage, type ServerResponse } from "http";
import next from "next";
import { parse } from "url";
import { spawn, type ChildProcess } from "child_process";
import * as path from "path";
import { setupWebSocket } from "./src/lib/ws-server";
import { handleTtsRequest } from "./src/lib/tts-handler";

const dev = process.env.NODE_ENV !== "production";
const hostname = "0.0.0.0";
const port = parseInt(process.env.PORT || "3340", 10);
const ttsPort = parseInt(process.env.TTS_PORT || "3341", 10);

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
    const { execSync } = require("child_process") as typeof import("child_process");
    execSync(`taskkill /T /F /PID ${child.pid}`, { stdio: "ignore" });
  } catch {
    try { child.kill(); } catch {}
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

// Spawn TTS server and ensure cleanup on exit
const ttsProcess = spawnTtsServer();
for (const sig of ["exit", "SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => killTtsServer(ttsProcess));
}

app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    const parsedUrl = parse(req.url!, true);
    const pathname = parsedUrl.pathname || "";

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
