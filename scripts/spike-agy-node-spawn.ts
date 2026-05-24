/**
 * Probe: can we use Node's child_process.spawn (stdio:ignore, detached, windowsHide)
 * to launch agy and have it bring up the LS host?
 *
 * If YES → use direct spawn, args go through OS-level safely (multiline primer
 *          preserved). No PowerShell quoting headaches.
 * If NO  → fall back to PowerShell with manual command-line quoting.
 */
import { spawn, execSync } from "child_process";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

const AGY_PATH = path.join(os.homedir(), "AppData", "Local", "agy", "bin", "agy.exe");

async function main() {
  const cwd = path.join(os.tmpdir(), "agy-node-spawn-probe");
  if (!fs.existsSync(cwd)) fs.mkdirSync(cwd, { recursive: true });

  // Multi-line primer with various special chars
  const primer = `You are SENTRY-7.
When asked "codename?", reply: "My codename is SENTRY-7."
Special chars: 'apostrophe' "quote" $var \`backtick\` & ampersand
Korean: 한국어 테스트 — multi-byte UTF-8`;

  console.log(`[probe] primer length=${primer.length}`);
  console.log(`[probe] primer:\n${primer}\n`);

  const child = spawn(AGY_PATH, [
    "--prompt-interactive", primer,
    "--dangerously-skip-permissions",
  ], {
    cwd,
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  child.unref();
  const pid = child.pid;
  if (!pid) { console.error("[probe] spawn failed: no pid"); process.exit(1); }
  console.log(`[probe] spawned pid=${pid}`);

  // Wait up to 15s for LS port
  let port: number | null = null;
  for (let i = 0; i < 30; i++) {
    try {
      const out = execSync(
        `powershell -NoProfile -Command "Get-NetTCPConnection -OwningProcess ${pid} -State Listen -ErrorAction SilentlyContinue | Select-Object LocalPort | ConvertTo-Json -Compress"`,
        { encoding: "utf-8" },
      ).trim();
      if (out) {
        const parsed = JSON.parse(out) as { LocalPort: number } | { LocalPort: number }[];
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        const ports = arr.map(r => r.LocalPort).sort((a, b) => a - b);
        if (ports.length >= 1) { port = ports[0]; break; }
      }
    } catch { /* */ }
    await new Promise(r => setTimeout(r, 500));
  }

  if (!port) {
    console.error("[probe] no LS port found within 15s — node spawn doesn't work for agy LS mode");
    try { execSync(`taskkill /T /F /PID ${pid}`, { stdio: "ignore" }); } catch { /* */ }
    process.exit(1);
  }

  console.log(`[probe] LS port=${port}`);

  // Wait a few more seconds for cascade creation
  await new Promise(r => setTimeout(r, 5000));

  // Query trajectory and check if primer is preserved fully
  const https = await import("https");
  const rpc = (method: string, payload: Record<string, unknown>) => new Promise<string>((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: "127.0.0.1", port: port!,
      path: `/exa.language_server_pb.LanguageServerService/${method}`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      rejectUnauthorized: false, timeout: 15000,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    });
    req.on("error", reject);
    req.write(body); req.end();
  });

  const allText = await rpc("GetAllCascadeTrajectories", {});
  const all = JSON.parse(allText) as { trajectorySummaries?: Record<string, { summary?: string }> };
  const summaries = all.trajectorySummaries || {};
  const ids = Object.keys(summaries);
  if (ids.length === 0) {
    console.log("[probe] no cascades created");
    try { execSync(`taskkill /T /F /PID ${pid}`, { stdio: "ignore" }); } catch { /* */ }
    process.exit(1);
  }
  const cid = ids[0];
  console.log(`[probe] cascade ${cid} summary: ${summaries[cid].summary?.slice(0, 200)}`);

  const trajText = await rpc("GetCascadeTrajectory", { cascadeId: cid });
  const traj = JSON.parse(trajText) as { trajectory?: { steps?: Array<{ type?: string; userInput?: { items?: Array<{ text?: string }> } }> } };
  const step0 = traj.trajectory?.steps?.[0];
  const step0Text = step0?.userInput?.items?.[0]?.text || "";

  console.log(`\n[probe] step[0].type=${step0?.type}`);
  console.log(`[probe] step[0] text length=${step0Text.length}`);
  console.log(`[probe] step[0] text:\n${step0Text}`);
  console.log(`\n[probe] FULL primer in step[0]? ${step0Text === primer}`);
  console.log(`[probe] Contains SENTRY-7? ${step0Text.includes("SENTRY-7")}`);
  console.log(`[probe] Contains newline? ${step0Text.includes("\n")}`);
  console.log(`[probe] Contains Korean? ${step0Text.includes("한국어")}`);

  try { execSync(`taskkill /T /F /PID ${pid}`, { stdio: "ignore" }); } catch { /* */ }
  console.log(`[probe] killed pid=${pid}`);
}

main().catch(e => { console.error(e); process.exit(1); });
