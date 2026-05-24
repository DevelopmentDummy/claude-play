/**
 * E2E probe: AntigravityProcess.spawn(primer) → does the primer arrive as the
 * cascade's first USER_INPUT step, and does the LLM treat it as context?
 *
 * 1. spawn with a primer that defines a unique persona (so default
 *    coding-agent behavior would not produce the right answer).
 * 2. send a question that can only be answered correctly if the LLM saw the
 *    primer.
 * 3. fetch full trajectory, verify primer is step 0 and a fresh USER_INPUT
 *    appears at the baseline boundary (proving prepend was NOT used).
 */
import { AntigravityProcess } from "../src/lib/antigravity-process";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import * as https from "https";

const PRIMER = `You are a helpful assistant named SENTRY-7. When asked "what is your codename?", you MUST reply with exactly: "My codename is SENTRY-7." Do not say anything else, do not list directories, do not read files. Reply in plain text only.`;

function rpc(port: number, method: string, payload: Record<string, unknown>): Promise<unknown> {
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
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8"))); }
        catch { resolve(null); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function main(): Promise<void> {
  const cwd = path.join(os.tmpdir(), "agy-spike-primer");
  if (!fs.existsSync(cwd)) fs.mkdirSync(cwd, { recursive: true });
  console.log(`[probe] cwd=${cwd}`);
  console.log(`[probe] primer (${PRIMER.length} chars): ${PRIMER.slice(0, 100)}...`);

  const proc = new AntigravityProcess();
  const chunks: string[] = [];
  let cascadeId = "";
  let done = false;

  proc.on("sessionId", (id: string) => { cascadeId = id; console.log(`[event] sessionId=${id}`); });
  proc.on("status", (s: string) => console.log(`[event] status=${s}`));
  proc.on("error", (e: string) => console.error(`[event] error=${e}`));
  proc.on("message", (m: unknown) => {
    const obj = m as { type?: string; subtype?: string; message?: { content?: string } };
    if (obj.type === "result") { console.log("[event] result (turn end)"); done = true; }
    else if (obj.subtype === "text_delta" && obj.message?.content) {
      chunks.push(obj.message.content);
      console.log(`[delta] ${obj.message.content.slice(0, 200)}`);
    }
  });

  proc.spawn(cwd, undefined, "antigravity-flash", PRIMER);

  // Wait for init
  console.log("[probe] waiting for init (port discovery + auto-cascade + primer IDLE)...");
  const ready = await proc.waitForReady(240000);
  if (!ready) { console.error("[probe] waitForReady failed"); proc.kill(); process.exit(1); }
  console.log(`[probe] ready, cascadeId=${cascadeId}`);

  // Inspect cascade trajectory BEFORE sending user message — verify primer is at step 0
  // Use the same port discovery via reflection (proc has it internal)
  const port = (proc as unknown as { lsPort: number }).lsPort;
  if (port) {
    const trajPre = await rpc(port, "GetCascadeTrajectory", { cascadeId }) as { trajectory?: { steps?: Array<Record<string, unknown>> } };
    const stepsPre = trajPre?.trajectory?.steps || [];
    const firstStep = stepsPre[0] as { type?: string; userInput?: { items?: Array<{ text?: string }> } } | undefined;
    const firstText = firstStep?.userInput?.items?.[0]?.text || "";
    console.log(`[probe] pre-send: stepCount=${stepsPre.length}, step[0].type=${firstStep?.type}`);
    console.log(`[probe] pre-send: step[0] first 200 chars: ${firstText.slice(0, 200)}`);
    console.log(`[probe] pre-send: primer in step[0]? ${firstText.includes("SENTRY-7")}`);
  }

  // Send user question
  console.log("\n[probe] sending question...");
  proc.send("what is your codename?");

  const deadline = Date.now() + 90_000;
  while (!done && Date.now() < deadline) { await new Promise(r => setTimeout(r, 500)); }

  console.log("\n[probe] ---FULL RESPONSE---");
  const full = chunks.join("");
  console.log(full);
  console.log(`\n[probe] response mentions SENTRY-7? ${full.includes("SENTRY-7")}`);

  // Final trajectory inspection
  if (port && cascadeId) {
    const trajPost = await rpc(port, "GetCascadeTrajectory", { cascadeId }) as { trajectory?: { steps?: Array<Record<string, unknown>> } };
    const stepsPost = trajPost?.trajectory?.steps || [];
    console.log(`\n[probe] post-send: total steps=${stepsPost.length}`);
    for (let i = 0; i < stepsPost.length; i++) {
      const s = stepsPost[i] as { type?: string };
      console.log(`[probe]   step[${i}] type=${s.type}`);
    }
  }

  proc.kill();
  process.exit(done && full.includes("SENTRY-7") ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
