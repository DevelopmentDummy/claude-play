import { AntigravityProcess } from "../src/lib/antigravity-process";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

async function main(): Promise<void> {
  const cwd = path.join(os.tmpdir(), "agy-spike-roundtrip");
  if (!fs.existsSync(cwd)) fs.mkdirSync(cwd, { recursive: true });
  console.log(`[cwd] ${cwd}`);
  const proc = new AntigravityProcess();
  const chunks: string[] = [];
  let cascadeId = "";
  let done = false;

  proc.on("sessionId", (id: string) => {
    cascadeId = id;
    console.log(`[event] sessionId=${id}`);
  });
  proc.on("status", (s: string) => console.log(`[event] status=${s}`));
  proc.on("error", (e: string) => console.error(`[event] error=${e}`));
  proc.on("message", (m: unknown) => {
    console.log(`[event-raw] ${JSON.stringify(m).slice(0, 300)}`);
    const obj = m as { type?: string; subtype?: string; message?: { content?: string } };
    if (obj.type === "result") {
      console.log("[event] result (turn end)");
      done = true;
    } else if (obj.subtype === "text_delta" && obj.message?.content) {
      chunks.push(obj.message.content);
      const c = obj.message.content;
      console.log(`[delta] ${c.slice(0, 80)}${c.length > 80 ? "..." : ""}`);
    }
  });

  proc.spawn(cwd, undefined, "antigravity-flash");
  await new Promise(r => setTimeout(r, 5000));

  proc.send("Respond in plain text only. Do NOT use any tools, file operations, or directory listings. Reply with exactly: PONG-AGY");

  const deadline = Date.now() + 60_000;
  while (!done && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
  }

  console.log("---FULL RESPONSE---");
  console.log(chunks.join(""));
  console.log(`---cascadeId=${cascadeId} timeout=${!done}---`);
  proc.kill();
  process.exit(done ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
