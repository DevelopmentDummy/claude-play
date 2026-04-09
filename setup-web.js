#!/usr/bin/env node
// setup-web.js — Start server, open browser for web setup, wait for completion, then exit.
// Designed for AI agents to run after `node setup.js --yes`.

const { spawn, execSync } = require("child_process");
const http = require("http");
const os = require("os");
const path = require("path");

const envPath = path.join(__dirname, ".env.local");
let port = 3340;
try {
  const envContent = require("fs").readFileSync(envPath, "utf8");
  const match = envContent.match(/^PORT=(\d+)/m);
  if (match) port = parseInt(match[1], 10);
} catch {}

const baseUrl = `http://127.0.0.1:${port}`;
const setupUrl = `http://localhost:${port}/setup`;

function log(msg) { console.log(`  ${msg}`); }

function pollJson(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      // 401 = setup complete (auth now required), treat as done
      if (res.statusCode === 401) {
        res.resume();
        resolve({ setupComplete: true, _authRequired: true });
        return;
      }
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(3000, () => { req.destroy(); });
  });
}

function openBrowser(url) {
  const cmd = os.platform() === "win32" ? `start "" "${url}"`
    : os.platform() === "darwin" ? `open "${url}"`
    : `xdg-open "${url}"`;
  try { execSync(cmd, { stdio: "ignore" }); } catch {}
}

async function waitForServer() {
  log("Waiting for server to start...");
  while (true) {
    const data = await pollJson(`${baseUrl}/api/setup/status`);
    if (data) return data;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function waitForSetupComplete(isServerExited) {
  while (true) {
    if (isServerExited()) return;
    const data = await pollJson(`${baseUrl}/api/setup/status`);
    if (data && data.setupComplete) return;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

async function main() {
  log("Starting server...");
  const server = spawn("npm", ["run", "start"], {
    cwd: __dirname,
    stdio: "ignore",
    shell: true,
    detached: false,
  });

  const cleanup = () => {
    try {
      if (os.platform() === "win32") {
        execSync(`taskkill /T /F /PID ${server.pid}`, { stdio: "ignore" });
      } else {
        process.kill(-server.pid, "SIGTERM");
      }
    } catch {}
  };

  let serverExited = false;
  server.on("exit", () => { serverExited = true; });

  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });

  const status = await waitForServer();

  if (status.setupComplete) {
    log("Web setup is already complete.");
    log(`To start the server, run start.bat or: npm run start`);
    cleanup();
    process.exit(0);
  }

  log(`Server ready — opening ${setupUrl}`);
  openBrowser(setupUrl);

  log("Waiting for web setup to complete... (user is configuring in browser)");
  await waitForSetupComplete(() => serverExited);

  cleanup();
  console.log("");
  log("========================================");
  log("  Web setup complete!");
  log("========================================");
  log("");
  log("To start the server:");
  log("  - Double-click start.bat, or");
  log("  - Run: npm run start");
  log(`  - Then open http://localhost:${port}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
