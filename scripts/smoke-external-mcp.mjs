#!/usr/bin/env node
// 외부 MCP 엔드포인트 스모크: tools/list → comfyui_health → (옵션) comfyui_generate
// 사용법: node scripts/smoke-external-mcp.mjs [--generate <출력디렉토리 절대경로>]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port = process.env.PORT || "3340";
const tokenPath = path.join(repoRoot, "data", ".runtime", "external-mcp-token");
const token = fs.readFileSync(tokenPath, "utf-8").trim();

const genIdx = process.argv.indexOf("--generate");
const generateDir = genIdx !== -1 ? process.argv[genIdx + 1] : null;

const transport = new StreamableHTTPClientTransport(
  new URL(`http://127.0.0.1:${port}/mcp/external`),
  { requestInit: { headers: { "x-external-token": token } } }
);
const client = new Client({ name: "external-mcp-smoke", version: "0.0.1" });
await client.connect(transport);

const tools = await client.listTools();
console.log("[smoke] tools:", tools.tools.map((t) => t.name).join(", "));

const health = await client.callTool({ name: "comfyui_health", arguments: {} });
console.log("[smoke] comfyui_health:", String(health.content?.[0]?.text).slice(0, 200));

if (generateDir) {
  console.log("[smoke] comfyui_generate →", generateDir);
  const gen = await client.callTool({
    name: "comfyui_generate",
    arguments: { outputDir: generateDir, prompt: "1girl, smile, simple background", filename: "smoke_test.png" },
  });
  const text = gen.content?.[0]?.text || "{}";
  console.log("[smoke] result:", text);
  let parsed = {};
  try { parsed = JSON.parse(text); } catch { /* Error: ... 텍스트 */ }
  if (parsed.path && fs.existsSync(parsed.path)) {
    console.log("[smoke] OK — file exists at", parsed.path);
  } else {
    console.error("[smoke] FAIL — file missing:", text.slice(0, 300));
    process.exitCode = 1;
  }
}

await client.close();
