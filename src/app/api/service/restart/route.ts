import { NextResponse } from "next/server";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { getServices } from "@/lib/services";
import { markRestartTriggered } from "@/lib/restart-notification";

export const maxDuration = 30;

function spawnRespawnOrchestrator(
  root: string,
  mode: string | undefined,
  skipBuild: boolean,
): number | null {
  const script = path.join(root, "scripts", "restart.mjs");
  const orchArgs: string[] = [script];
  if (mode === "dev" || mode === "start") {
    orchArgs.push("--mode", mode);
  }
  if (skipBuild) {
    orchArgs.push("--skip-build");
  }
  const isWin = process.platform === "win32";

  // Capture orchestrator's stdout/stderr to a file so we can debug crashes that
  // happen before its own logger initializes (e.g. import errors).
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const orchLogPath = path.join(dataDir, "restart-orchestrator.log");
  fs.appendFileSync(
    orchLogPath,
    `\n[${new Date().toISOString()}] === api route spawning orchestrator (mode=${mode || "auto"}, skipBuild=${skipBuild}, isWin=${isWin}) ===\n`,
  );
  const orchOutFd = fs.openSync(orchLogPath, "a");
  const orchErrFd = fs.openSync(orchLogPath, "a");

  // On Windows, spawn through `cmd /c start /B` so the orchestrator's PPID points to
  // a short-lived cmd.exe that exits immediately. This detaches it from the current
  // server's PID tree — otherwise `taskkill /T /F /PID <server>` walks the tree and
  // kills the orchestrator before it can spawn the replacement server.
  const child = isWin
    ? spawn("cmd", ["/c", "start", "/B", "node", ...orchArgs], {
        cwd: root,
        detached: true,
        stdio: ["ignore", orchOutFd, orchErrFd],
        windowsHide: true,
        env: { ...process.env, NODE_OPTIONS: "" },
      })
    : spawn("node", orchArgs, {
        cwd: root,
        detached: true,
        stdio: ["ignore", orchOutFd, orchErrFd],
        windowsHide: true,
        env: { ...process.env, NODE_OPTIONS: "" },
      });

  // Parent doesn't need these fds anymore — child has its own dup'd handles
  try { fs.closeSync(orchOutFd); } catch { /* already closed */ }
  try { fs.closeSync(orchErrFd); } catch { /* already closed */ }
  child.unref();
  return child.pid ?? null;
}

export async function POST(req: Request) {
  let body: {
    mode?: string;
    skipBuild?: boolean;
    respawn?: boolean;
    sessionId?: string;
    triggeredBy?: string;
  } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body is fine */
  }

  const root = process.cwd();
  const script = path.join(root, "scripts", "restart.mjs");
  if (!fs.existsSync(script)) {
    return NextResponse.json({ error: `restart script not found: ${script}` }, { status: 500 });
  }

  const respawn = body.respawn !== false;
  const skipBuild = !!body.skipBuild;

  if (!respawn) {
    return NextResponse.json({
      ok: true,
      stage: "noop",
      note: "respawn disabled; nothing to do.",
    });
  }

  // If a session triggered this restart (e.g. via MCP tool), drop a marker so the
  // session gets a silent "restart completed" notification when it's reactivated
  // on the new server. See restart-notification.ts.
  console.log(`[restart] POST received: sessionId=${body.sessionId ?? "<none>"} triggeredBy=${body.triggeredBy ?? "<none>"} skipBuild=${skipBuild} respawn=${respawn}`);
  let markerWritten = false;
  if (body.sessionId) {
    try {
      const svc = getServices();
      const sessionDir = svc.sessions.getSessionDir(body.sessionId);
      const sessionInfo = svc.sessions.getSessionInfo(body.sessionId);
      if (sessionInfo) {
        markRestartTriggered(sessionDir, body.sessionId, body.triggeredBy || "api");
        markerWritten = true;
      } else {
        console.warn(`[restart] sessionId=${body.sessionId} provided but session not found — marker NOT written`);
      }
    } catch (err) {
      console.warn(`[restart] failed to write notification marker:`, err);
    }
  } else {
    console.log(`[restart] no sessionId provided — silent notification will not be delivered`);
  }

  // Spawn orchestrator and return immediately — orchestrator runs build → kill → respawn
  // in the background. This keeps the running server unaffected during build.
  const orchestratorPid = spawnRespawnOrchestrator(root, body.mode, skipBuild);

  return NextResponse.json({
    ok: true,
    stage: "scheduled",
    orchestratorPid,
    mode: body.mode || "auto",
    skipBuild,
    notificationMarker: markerWritten,
    note: skipBuild
      ? "Orchestrator spawned (skipBuild). It will kill and respawn the server. See data/restart.log."
      : "Orchestrator spawned. It will run 'npm run build' first, then kill and respawn on success. See data/restart.log and data/restart-build.log.",
  });
}
