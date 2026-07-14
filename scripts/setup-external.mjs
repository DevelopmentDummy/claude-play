#!/usr/bin/env node
// 외부 프로젝트에 claude-play-bridge MCP + 스킬팩을 셋업한다. 멱등 — 재실행 시 갱신.
// 사용법: node scripts/setup-external.mjs <대상 프로젝트 경로> [--port N]
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ── 인자 파싱 ──
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const target = args[0] ? path.resolve(args[0]) : null;
if (!target) {
  console.error("사용법: node scripts/setup-external.mjs <대상 프로젝트 경로> [--port N]");
  process.exit(1);
}
if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
  console.error(`대상 디렉토리가 없습니다: ${target}`);
  process.exit(1);
}

// ── 포트: --port > repo .env.local/.env의 PORT > 3340 ──
function readEnvPort() {
  for (const file of [".env.local", ".env"]) {
    try {
      const m = fs.readFileSync(path.join(repoRoot, file), "utf-8").match(/^PORT=(\d+)/m);
      if (m) return m[1];
    } catch { /* 없으면 다음 */ }
  }
  return "3340";
}
const portIdx = process.argv.indexOf("--port");
const port = portIdx !== -1 ? process.argv[portIdx + 1] : readEnvPort();

// ── 토큰: 서버와 같은 파일 공유 (없으면 생성 — 서버도 같은 파일을 읽는다) ──
const tokenPath = path.join(repoRoot, "data", ".runtime", "external-mcp-token");
let token;
try {
  token = fs.readFileSync(tokenPath, "utf-8").trim();
} catch { token = ""; }
if (!token) {
  token = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, token + "\n", "utf-8");
  console.log(`+ 토큰 생성: ${tokenPath}`);
}

// ── .mcp.json 병합 (기존 서버 항목 보존) ──
const mcpJsonPath = path.join(target, ".mcp.json");
let mcpConfig = {};
try {
  mcpConfig = JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8"));
} catch { /* 없거나 깨졌으면 새로 */ }
mcpConfig.mcpServers = mcpConfig.mcpServers || {};
mcpConfig.mcpServers["claude-play-bridge"] = {
  type: "http",
  url: `http://127.0.0.1:${port}/mcp/external`,
  headers: { "x-external-token": token },
};
fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2) + "\n", "utf-8");
console.log(`✓ .mcp.json: claude-play-bridge → http://127.0.0.1:${port}/mcp/external`);

// ── 스킬 복사 ──
const CURATED_SKILLS = [
  { name: "generate-image", src: path.join(repoRoot, "scripts", "external-package", "skills", "generate-image") },
  ...["generate-image-gemini", "manage-workflows", "civitai-search", "lora-lab", "workflow-research"].map((n) => ({
    name: n,
    src: path.join(repoRoot, "data", "tools", "comfyui", "skills", n),
  })),
];

function copySkill(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copySkill(s, d);
    } else if (entry.name.endsWith(".md") || entry.name.endsWith(".sh")) {
      let content = fs.readFileSync(s, "utf-8");
      content = content.replace(/\{\{PORT\}\}/g, port);
      content = content.replace(/mcp__claude_play__/g, "mcp__claude-play-bridge__");
      fs.writeFileSync(d, content, "utf-8");
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

const skillsDest = path.join(target, ".claude", "skills");
const copied = [];
const missing = [];
for (const skill of CURATED_SKILLS) {
  if (!fs.existsSync(skill.src)) {
    missing.push(skill.name);
    continue;
  }
  copySkill(skill.src, path.join(skillsDest, skill.name));
  copied.push(skill.name);
}
console.log(`✓ 스킬 복사 (${copied.length}): ${copied.join(", ")}`);
if (missing.length) console.warn(`! 소스 없음(건너뜀): ${missing.join(", ")}`);

console.log(`
셋업 완료. 다음 단계:
1. 브릿지 서버가 켜져 있는지 확인 (claude bridge 레포에서 npm run dev 또는 npm run start)
2. 이 프로젝트에서 Claude Code를 재시작(또는 /mcp 로 재연결)하면 claude-play-bridge 도구가 보인다
3. 검증: mcp__claude-play-bridge__comfyui_health 호출 → ComfyUI 상태 응답 확인
`);
