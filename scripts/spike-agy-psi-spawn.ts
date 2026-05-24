/**
 * Probe: launch agy via PowerShell + ProcessStartInfo (raw command line) so
 * multiline primer text survives intact through CreateProcessW.
 */
import { execSync } from "child_process";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

const AGY_PATH = path.join(os.homedir(), "AppData", "Local", "agy", "bin", "agy.exe");

async function main() {
  const cwd = path.join(os.tmpdir(), "agy-psi-spawn-probe");
  if (!fs.existsSync(cwd)) fs.mkdirSync(cwd, { recursive: true });

  const primer = `You are SENTRY-7.
When asked "codename?", reply: "My codename is SENTRY-7."
Special chars: 'apostrophe' "quote" $var \`backtick\` & ampersand
Korean: 한국어 테스트 — multi-byte UTF-8`;

  const tempDir = path.join(os.tmpdir(), "agy-bridge");
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
  const tempPrimerPath = path.join(tempDir, `primer-psi-${Date.now()}.txt`);
  fs.writeFileSync(tempPrimerPath, primer, "utf-8");

  const escapePS = (s: string) => s.replace(/'/g, "''");
  // CommandLineToArgvW convention: wrap in double-quotes, escape inner quote as ""
  const psCmd = [
    `$primer = [System.IO.File]::ReadAllText('${escapePS(tempPrimerPath)}', [System.Text.Encoding]::UTF8)`,
    `$rawArgs = '--prompt-interactive "' + ($primer -replace '"', '""') + '" --dangerously-skip-permissions'`,
    `$psi = New-Object System.Diagnostics.ProcessStartInfo`,
    `$psi.FileName = '${escapePS(AGY_PATH)}'`,
    `$psi.Arguments = $rawArgs`,
    `$psi.UseShellExecute = $false`,
    `$psi.CreateNoWindow = $true`,
    `$psi.WorkingDirectory = '${escapePS(cwd)}'`,
    `$p = [System.Diagnostics.Process]::Start($psi)`,
    `$p.Id`,
  ].join("; ");

  const out = execSync(`powershell -NoProfile -Command "${psCmd}"`, { encoding: "utf-8" }).trim();
  const pid = Number(out);
  console.log(`[probe] spawned pid=${pid}`);
  try { fs.unlinkSync(tempPrimerPath); } catch { /* */ }

  // Wait for LS port
  let port: number | null = null;
  for (let i = 0; i < 30; i++) {
    try {
      const o = execSync(
        `powershell -NoProfile -Command "Get-NetTCPConnection -OwningProcess ${pid} -State Listen -ErrorAction SilentlyContinue | Select-Object LocalPort | ConvertTo-Json -Compress"`,
        { encoding: "utf-8" },
      ).trim();
      if (o) {
        const parsed = JSON.parse(o) as { LocalPort: number } | { LocalPort: number }[];
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        const ports = arr.map(r => r.LocalPort).sort((a, b) => a - b);
        if (ports.length >= 1) { port = ports[0]; break; }
      }
    } catch { /* */ }
    await new Promise(r => setTimeout(r, 500));
  }
  if (!port) { console.error("[probe] no LS port"); try { execSync(`taskkill /T /F /PID ${pid}`, { stdio: "ignore" }); } catch { /* */ } process.exit(1); }
  console.log(`[probe] LS port=${port}`);

  await new Promise(r => setTimeout(r, 5000));

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
    req.on("error", reject); req.write(body); req.end();
  });

  const allText = await rpc("GetAllCascadeTrajectories", {});
  const all = JSON.parse(allText) as { trajectorySummaries?: Record<string, { summary?: string }> };
  const ids = Object.keys(all.trajectorySummaries || {});
  if (ids.length === 0) { console.error("[probe] no cascade created"); try { execSync(`taskkill /T /F /PID ${pid}`, { stdio: "ignore" }); } catch { /* */ } process.exit(1); }

  const cid = ids[0];
  const trajText = await rpc("GetCascadeTrajectory", { cascadeId: cid });
  const traj = JSON.parse(trajText) as { trajectory?: { steps?: Array<{ type?: string; userInput?: { items?: Array<{ text?: string }> } }> } };
  const step0Text = traj.trajectory?.steps?.[0]?.userInput?.items?.[0]?.text || "";

  console.log(`\n[probe] step[0] text length=${step0Text.length} (primer was ${primer.length})`);
  console.log(`[probe] step[0] text:\n${step0Text}`);
  console.log(`\n[probe] EXACT match: ${step0Text === primer}`);
  console.log(`[probe] contains SENTRY-7: ${step0Text.includes("SENTRY-7")}`);
  console.log(`[probe] contains newline: ${step0Text.includes("\n")}`);
  console.log(`[probe] contains quote: ${step0Text.includes('"')}`);
  console.log(`[probe] contains Korean: ${step0Text.includes("한국어")}`);

  try { execSync(`taskkill /T /F /PID ${pid}`, { stdio: "ignore" }); } catch { /* */ }
  console.log(`[probe] killed pid=${pid}`);
}

main().catch(e => { console.error(e); process.exit(1); });
