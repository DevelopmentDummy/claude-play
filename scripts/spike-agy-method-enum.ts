import { execSync } from "child_process";
import * as https from "https";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

const AGY = path.join(os.homedir(), "AppData", "Local", "agy", "bin", "agy.exe");

async function rpc(port: number, method: string, payload: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = https.request(
      {
        hostname: "127.0.0.1", port,
        path: `/exa.language_server_pb.LanguageServerService/${method}`,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        rejectUnauthorized: false,
        timeout: 8000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString("utf-8") }));
      },
    );
    req.on("error", e => resolve({ status: 0, body: String(e) }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, body: "timeout" }); });
    req.write(body); req.end();
  });
}

async function main(): Promise<void> {
  const cwd = path.join(os.tmpdir(), "agy-method-enum");
  if (!fs.existsSync(cwd)) fs.mkdirSync(cwd, { recursive: true });

  const out = execSync(
    `powershell -NoProfile -Command "$p = Start-Process -FilePath '${AGY}' -ArgumentList '--prompt-interactive','init','--dangerously-skip-permissions' -WorkingDirectory '${cwd}' -WindowStyle Hidden -PassThru; $p.Id"`,
    { encoding: "utf-8" },
  ).trim();
  const pid = Number(out);
  console.log(`agy pid=${pid}`);
  await new Promise(r => setTimeout(r, 5000));

  let port = 0;
  for (let i = 0; i < 12; i++) {
    try {
      const o = execSync(
        `powershell -NoProfile -Command "Get-NetTCPConnection -OwningProcess ${pid} -State Listen | Select-Object LocalPort | ConvertTo-Json -Compress"`,
        { encoding: "utf-8" },
      ).trim();
      if (o) {
        const arr = JSON.parse(o);
        const ports = (Array.isArray(arr) ? arr : [arr]).map((r: { LocalPort: number }) => r.LocalPort).sort((a, b) => a - b);
        if (ports.length) { port = ports[0]; break; }
      }
    } catch { /* */ }
    await new Promise(r => setTimeout(r, 700));
  }
  console.log(`https port=${port}`);

  const start = await rpc(port, "StartCascade", { source: 1 });
  console.log(`StartCascade: ${start.status} ${start.body.slice(0, 200)}`);
  const startObj = JSON.parse(start.body);
  const cascadeId = startObj.cascadeId;
  if (!cascadeId) { console.log("no cascadeId"); execSync(`taskkill /T /F /PID ${pid}`, { stdio: "pipe" }); return; }

  const sendResp = await rpc(port, "SendUserCascadeMessage", {
    cascadeId,
    items: [{ chunk: { text: "Reply with: PONG" } }],
    cascadeConfig: {
      plannerConfig: {
        plannerTypeConfig: { conversational: {} },
        requestedModel: { model: 1018 },
      },
    },
  });
  console.log(`SendUserCascadeMessage: ${sendResp.status} ${sendResp.body.slice(0, 200)}`);
  console.log("message sent, waiting 3s then enumerating methods...");
  await new Promise(r => setTimeout(r, 3000));

  const candidates = [
    "GetConversation", "GetCascade", "GetTrajectory", "GetCascadeTrajectory",
    "GetCascadeMessages", "GetCortexTrajectory", "GetCortexTrajectoryDescriptions",
    "GetUserCascadeMessages", "GetCascadeUpdates", "StreamCascadeUpdates",
    "GetAllCascadeTrajectories", "GetUserTrajectoryDescriptions",
    "ListCascadeMessages", "GetCascadeState", "ReadCascade",
  ];
  // 메시지 처리 완료 대기 (LLM 응답까지)
  await new Promise(r => setTimeout(r, 10000));
  const traj = await rpc(port, "GetCascadeTrajectory", { cascadeId });
  console.log(`---FULL TRAJECTORY (${traj.body.length}b)---`);
  const dumpPath = path.join(cwd, "trajectory-dump.json");
  fs.writeFileSync(dumpPath, traj.body, "utf-8");
  console.log(`dumped to: ${dumpPath}`);

  // step type 다이제스트
  try {
    const obj = JSON.parse(traj.body);
    const steps = obj.trajectory?.steps ?? [];
    console.log(`step count: ${steps.length}`);
    steps.forEach((s: Record<string, unknown>, i: number) => {
      const keys = Object.keys(s).join(",");
      console.log(`step[${i}] type=${s.type} status=${s.status} keys=[${keys}]`);
    });
  } catch (e) { console.log(`parse err: ${e}`); }

  execSync(`taskkill /T /F /PID ${pid}`, { stdio: "pipe" });
}
main().catch(e => { console.error(e); process.exit(1); });
