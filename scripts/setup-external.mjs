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
  // 영상 워크플로는 한 판이 수십 분이다. 동기 호출용 상한을 넉넉히 준다.
  // (클라이언트 유휴 타임아웃은 이 값으로 늘릴 수 없으므로, 장시간 렌더는
  //  generate-video 스킬이 안내하는 async + 파일 폴링으로 처리한다.)
  timeout: 3_600_000,
};
fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2) + "\n", "utf-8");
console.log(`✓ .mcp.json: claude-play-bridge → http://127.0.0.1:${port}/mcp/external`);

// ── 스킬 복사 ──
// 로컬 파이프라인 스킬(ComfyUI 8188 직결)에 붙는 경고 배너.
// 원본은 이 레포의 페르소나 작업 환경을 전제로 쓰였으므로, 외부 사본에서는
// "기본 경로는 브릿지 MCP"라는 계약과 경로 예시의 한계를 먼저 알려야 한다.
const LOCAL_PIPELINE_BANNER = `
> **⚠️ 외부 프로젝트 사본** — 이 문서는 같은 PC의 ComfyUI(\`127.0.0.1:8188\`)를 직접 다루는
> **로컬 파이프라인 스킬**이다. 영상 한 편을 만드는 일반 경로는 \`generate-video\` 스킬
> (브릿지 MCP 경유)이 먼저다. 이 문서는 그 경로로 처리되지 않는 것 — 세그먼트 체이닝,
> 사운드 레이어링, 프롬프트·연출 노하우 — 을 다룰 때 참고한다.
> 본문의 파일 경로·프로젝트 디렉터리·스크립트 예시는 **원본 개발 환경 기준**이므로
> 이 프로젝트에 맞게 바꿔 읽어라.
`;

const CURATED_SKILLS = [
  { name: "generate-image", src: path.join(repoRoot, "scripts", "external-package", "skills", "generate-image") },
  { name: "generate-video", src: path.join(repoRoot, "scripts", "external-package", "skills", "generate-video") },
  ...["generate-image-gemini", "manage-workflows", "civitai-search", "lora-lab", "workflow-research"].map((n) => ({
    name: n,
    src: path.join(repoRoot, "data", "tools", "comfyui", "skills", n),
  })),
  // 영상 노하우 스킬 — 실행은 8188 직결이라 배너를 주입해 계약을 명시한다.
  ...["minimax-h3", "h3-longtake", "long-video-chaining", "video-sound-design"].map((n) => ({
    name: n,
    src: path.join(repoRoot, "data", "skills", n),
    banner: LOCAL_PIPELINE_BANNER,
  })),
];

/** frontmatter를 닫는 두 번째 `---` 바로 뒤에 배너를 끼운다 (스킬 파싱을 깨지 않도록). */
function injectBanner(content, banner) {
  if (!banner || !content.startsWith("---")) return content;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return content;
  const cut = content.indexOf("\n", end + 1) + 1;
  if (cut <= 0) return content;
  return content.slice(0, cut) + banner + content.slice(cut);
}

function copySkill(src, dest, banner) {
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
      if (entry.name === "SKILL.md") content = injectBanner(content, banner);
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
  copySkill(skill.src, path.join(skillsDest, skill.name), skill.banner);
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
