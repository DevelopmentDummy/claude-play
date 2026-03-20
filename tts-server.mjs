/**
 * Standalone Edge TTS server — runs as an independent Node.js process.
 * Avoids Next.js runtime interference with ws WebSocket connections.
 *
 * Usage: node tts-server.mjs [port]
 * Default port: 3341 (or TTS_PORT env var)
 */
import { createServer } from "http";
import { readFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { EdgeTTS } from "node-edge-tts";

const PORT = parseInt(process.argv[2] || process.env.TTS_PORT || "3341", 10);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { resolve(null); }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

// Ensure temp dir exists
const TMP_DIR = join(tmpdir(), "claude-bridge-tts");
mkdirSync(TMP_DIR, { recursive: true });

const server = createServer(async (req, res) => {
  // CORS for local
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  // Health check
  if (req.url === "/health" && req.method === "GET") {
    return sendJson(res, 200, { ok: true, pid: process.pid });
  }

  // POST /synthesize
  if (req.url === "/synthesize" && req.method === "POST") {
    const body = await readBody(req);
    if (!body || !body.text || !body.voice) {
      return sendJson(res, 400, { error: "Missing text or voice" });
    }

    const t0 = Date.now();
    const tmpFile = join(TMP_DIR, `tts-${randomBytes(8).toString("hex")}.mp3`);

    try {
      const tts = new EdgeTTS({
        voice: body.voice,
        rate: body.rate || "default",
        pitch: body.pitch || "default",
        outputFormat: body.outputFormat || "audio-24khz-96kbitrate-mono-mp3",
        timeout: 30000,
      });

      await tts.ttsPromise(body.text, tmpFile);

      const audioBuffer = readFileSync(tmpFile);
      const elapsed = Date.now() - t0;
      console.log(`[tts-server] ${elapsed}ms ${audioBuffer.length}B: ${body.text.substring(0, 50)}${body.text.length > 50 ? "..." : ""}`);

      res.writeHead(200, {
        "Content-Type": "audio/mpeg",
        "Content-Length": audioBuffer.length,
      });
      res.end(audioBuffer);

      // Cleanup temp file
      try { unlinkSync(tmpFile); } catch {}
    } catch (err) {
      const elapsed = Date.now() - t0;
      console.error(`[tts-server] Error ${elapsed}ms:`, err?.message || err);
      try { unlinkSync(tmpFile); } catch {}
      sendJson(res, 500, { error: err?.message || String(err) });
    }
    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[tts-server] Port ${PORT} already in use — skipping (another instance running?)`);
    process.exit(0); // Exit cleanly so parent doesn't see an error
  }
  throw err;
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[tts-server] Listening on http://127.0.0.1:${PORT} (PID ${process.pid})`);
});
