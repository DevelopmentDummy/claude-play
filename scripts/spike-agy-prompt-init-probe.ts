/**
 * Probe: does `agy --prompt-interactive <MARKER>` auto-create a cascade
 * whose first step contains <MARKER>?
 *
 * If YES → `--prompt-interactive` is the legitimate system-prompt channel
 *          and we should stop calling StartCascade ourselves; instead reuse
 *          the auto-cascade.
 * If NO  → `--prompt-interactive` text is dropped/ignored by the LS mode
 *          and we need a different injection path (more aggressive prepend,
 *          or stdin pipe, or proto field discovery).
 */
import { execSync } from "child_process";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import * as https from "https";

const AGY_PATH = path.join(os.homedir(), "AppData", "Local", "agy", "bin", "agy.exe");
const MARKER = "TEST_SYSTEM_PROMPT_MARKER_XYZ123_PROBE_2026";

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function discoverPort(pid: number): number | null {
  for (let i = 0; i < 20; i++) {
    try {
      const out = execSync(
        `powershell -NoProfile -Command "Get-NetTCPConnection -OwningProcess ${pid} -State Listen -ErrorAction SilentlyContinue | Select-Object LocalPort | ConvertTo-Json -Compress"`,
        { encoding: "utf-8" },
      ).trim();
      if (out) {
        const parsed = JSON.parse(out) as { LocalPort: number } | { LocalPort: number }[];
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        const ports = arr.map(r => r.LocalPort).sort((a, b) => a - b);
        if (ports.length >= 1) return ports[0];
      }
    } catch { /* retry */ }
    execSync(`powershell -NoProfile -Command "Start-Sleep -Milliseconds 700"`, { stdio: "pipe" });
  }
  return null;
}

function rpc(port: number, method: string, payload: Record<string, unknown>): Promise<{ status: number; text: string }> {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "127.0.0.1",
      port,
      path: `/exa.language_server_pb.LanguageServerService/${method}`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      rejectUnauthorized: false,
      timeout: 30000,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString("utf-8") }));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const cwd = path.join(os.tmpdir(), "agy-spike-prompt-init-probe");
  if (!fs.existsSync(cwd)) fs.mkdirSync(cwd, { recursive: true });
  console.log(`[probe] cwd=${cwd} marker="${MARKER}"`);

  // Spawn agy with marker as --prompt-interactive arg
  const argList = `'--prompt-interactive','${MARKER}','--dangerously-skip-permissions'`;
  const cmd = `powershell -NoProfile -Command "$p = Start-Process -FilePath '${AGY_PATH}' -ArgumentList ${argList} -WorkingDirectory '${cwd.replace(/'/g, "''")}' -WindowStyle Hidden -PassThru; $p.Id"`;
  const out = execSync(cmd, { encoding: "utf-8" }).trim();
  const pid = Number(out);
  if (!pid || Number.isNaN(pid)) { console.error("spawn failed"); process.exit(1); }
  console.log(`[probe] agy pid=${pid}`);

  try {
    const port = discoverPort(pid);
    if (!port) { console.error("no LS port found"); return; }
    console.log(`[probe] LS port=${port}`);

    // Give agy time to bootstrap and create any auto-cascade
    await sleep(4000);

    // 1) Look at all cascades
    const allRes = await rpc(port, "GetAllCascadeTrajectories", {});
    console.log(`[probe] GetAllCascadeTrajectories status=${allRes.status} bytes=${allRes.text.length}`);
    if (allRes.status !== 200) {
      console.log(`[probe] body: ${allRes.text.slice(0, 500)}`);
      return;
    }
    const all = JSON.parse(allRes.text) as { trajectorySummaries?: Record<string, unknown> };
    const summaries = all.trajectorySummaries || {};
    const cascadeIds = Object.keys(summaries);
    console.log(`[probe] auto-cascades count=${cascadeIds.length}`);
    console.log(`[probe] summaries=${JSON.stringify(summaries, null, 2).slice(0, 2000)}`);

    // 2) For each auto-cascade, fetch trajectory and grep for marker
    for (const cid of cascadeIds) {
      const trajRes = await rpc(port, "GetCascadeTrajectory", { cascadeId: cid });
      console.log(`\n[probe] === cascade ${cid} === bytes=${trajRes.text.length}`);
      const found = trajRes.text.includes(MARKER);
      console.log(`[probe] marker found in trajectory: ${found}`);
      if (found) {
        // Find the marker context
        const idx = trajRes.text.indexOf(MARKER);
        console.log(`[probe] context (±200 bytes):\n${trajRes.text.slice(Math.max(0, idx - 200), idx + 200 + MARKER.length)}`);
      } else {
        // Print first 1500 chars to see structure
        console.log(`[probe] first 1500 chars of trajectory:\n${trajRes.text.slice(0, 1500)}`);
      }
    }
  } finally {
    try { execSync(`taskkill /T /F /PID ${pid}`, { stdio: "ignore" }); } catch { /* */ }
    console.log(`[probe] killed pid=${pid}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
