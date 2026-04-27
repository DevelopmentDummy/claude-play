import { NextResponse } from "next/server";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";

export const maxDuration = 600;

interface BuildResult {
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
}

function tailLines(text: string, n: number): string {
  const lines = text.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - n)).join("\n");
}

function runBuild(root: string): Promise<BuildResult> {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const start = Date.now();
    const child = spawn(isWin ? "npm.cmd" : "npm", ["run", "build"], {
      cwd: root,
      env: { ...process.env, NODE_OPTIONS: "" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => { stdout += b.toString(); });
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
    child.on("close", (code) => {
      resolve({
        ok: code === 0,
        exitCode: code,
        durationMs: Date.now() - start,
        stdoutTail: tailLines(stdout, 50),
        stderrTail: tailLines(stderr, 50),
      });
    });
  });
}

function spawnRespawnOrchestrator(root: string, mode: string | undefined): number | null {
  const script = path.join(root, "scripts", "restart.mjs");
  const args = [script];
  if (mode === "dev" || mode === "start") {
    args.push("--mode", mode);
  }
  const child = spawn("node", args, {
    cwd: root,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  child.unref();
  return child.pid ?? null;
}

export async function POST(req: Request) {
  let body: { mode?: string; skipBuild?: boolean; respawn?: boolean } = {};
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

  let build: BuildResult | null = null;
  if (!skipBuild) {
    build = await runBuild(root);
    if (!build.ok) {
      return NextResponse.json({
        ok: false,
        stage: "build",
        message: "Build failed — server NOT restarted",
        build,
      }, { status: 500 });
    }
  }

  let orchestratorPid: number | null = null;
  if (respawn) {
    orchestratorPid = spawnRespawnOrchestrator(root, body.mode);
  }

  return NextResponse.json({
    ok: true,
    stage: respawn ? "respawn-spawned" : "build-only",
    build,
    respawn,
    orchestratorPid,
    mode: body.mode || "auto",
    note: respawn
      ? "Server will be killed and respawned within ~1-2s. Reconnect after a few seconds. See data/restart.log."
      : "Build complete; respawn skipped.",
  });
}
