#!/usr/bin/env node
/**
 * check-docs.mjs — 문서 ↔ 코드 드리프트 검사기 (기계 검증용, 서버 실행 없음)
 *
 * "docs/는 구조적 진실의 원천"이라는 규칙을 사람 기억이 아니라 verify 게이트로 강제한다.
 * 파일이 추가되거나 사라졌는데 문서가 따라오지 않으면 커밋 전에 걸린다.
 *
 * ERROR tier (누락 = 문서 갱신 필요):
 *   1. src/app/api/** /route.ts 의 모든 라우트 경로가 docs/api-routes.md 에 등장
 *   2. src/lib/**.ts (테스트 제외) 의 모든 파일명이 docs/architecture.md 에 등장
 *      (서브디렉토리 파일은 디렉토리명 + 파일명 둘 다 등장해야 함)
 *   3. src/components/*.tsx + src/hooks/*.ts 의 모든 파일명이 docs/frontend.md 에 등장
 *   4. src/mcp/claude-play-mcp-server.mjs 의 server.registerTool() 이름이 전부 docs/architecture.md 에 등장
 *   5. src/lib/external-mcp/registry.ts 의 EXTERNAL_TOOLS 이름이 전부 docs/external-mcp.md 에 등장
 *   6. docs/codebase-map.md 가 백틱으로 참조하는 리포 상대 경로가 전부 실존
 *   7. 문서가 표에서 언급하는 src/lib·components·hooks 파일이 실존 (유령 항목)
 *
 * WARN tier (판단 필요):
 *   8. src/ + server.ts + tts-server.mjs + scripts/*.mjs 의 process.env.X 가
 *      docs/infrastructure.md 와 .env.example 둘 다에 없음
 *
 * 절대 하지 않는 것: data/ 접근, src/ TS 모듈 import, 파일 수정.
 *
 * 사용법:
 *   node scripts/check-docs.mjs
 *   node scripts/check-docs.mjs --json
 *
 * Exit codes (check-static 컨벤션):
 *   0 — 문제 없음 (WARN만 있어도 0)
 *   1 — 에러 발견
 *   2 — 스크립트 자체 오류
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const wantJson = args.includes("--json");

const findings = []; // { severity, rule, file, msg }

function issue(severity, rule, file, msg) {
  const rel = path.isAbsolute(file) ? path.relative(REPO_ROOT, file) : file;
  findings.push({ severity, rule, file: rel.replace(/\\/g, "/"), msg });
}

function rp(...segs) {
  return path.join(REPO_ROOT, ...segs);
}

function readDoc(rel) {
  const abs = rp(...rel.split("/"));
  if (!fs.existsSync(abs)) {
    issue("error", "doc-missing", rel, "문서 파일이 존재하지 않음");
    return null;
  }
  return fs.readFileSync(abs, "utf-8");
}

function walk(dir, pred, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, pred, out);
    else if (pred(full)) out.push(full);
  }
  return out;
}

function toPosix(p) {
  return p.replace(/\\/g, "/");
}

// ─────────────────────────────────────────────────────────────
// 1. API 라우트 ↔ docs/api-routes.md
// ─────────────────────────────────────────────────────────────
function checkApiRoutes() {
  const doc = readDoc("docs/api-routes.md");
  if (doc === null) return;
  const apiDir = rp("src", "app", "api");
  const routeFiles = walk(apiDir, (f) => path.basename(f) === "route.ts");
  for (const file of routeFiles) {
    const rel = toPosix(path.relative(apiDir, path.dirname(file)));
    const url = "/api/" + rel;
    if (!doc.includes("`" + url + "`")) {
      issue("error", "route-undocumented", file, `docs/api-routes.md 에 \`${url}\` 행이 없음`);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 2. src/lib ↔ docs/architecture.md
// ─────────────────────────────────────────────────────────────
const TEST_RE = /\.test\.(ts|mts|tsx)$/;

function checkLib() {
  const doc = readDoc("docs/architecture.md");
  if (doc === null) return;
  const libDir = rp("src", "lib");
  const files = walk(libDir, (f) => /\.(ts|tsx|mts|mjs)$/.test(f) && !TEST_RE.test(f));
  for (const file of files) {
    const rel = toPosix(path.relative(libDir, file));
    const base = path.basename(file);
    const sub = path.dirname(rel);
    const hasBase = doc.includes("`" + base + "`") || doc.includes("`" + rel + "`");
    const hasDir = sub === "." || doc.includes(sub + "/");
    if (!hasBase || !hasDir) {
      issue("error", "lib-undocumented", file, `docs/architecture.md 에 \`${rel}\` 언급이 없음`);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 3. src/components + src/hooks ↔ docs/frontend.md
// ─────────────────────────────────────────────────────────────
function checkFrontend() {
  const doc = readDoc("docs/frontend.md");
  if (doc === null) return;
  const targets = [
    ...walk(rp("src", "components"), (f) => /\.tsx?$/.test(f) && !TEST_RE.test(f)),
    ...walk(rp("src", "hooks"), (f) => /\.tsx?$/.test(f) && !TEST_RE.test(f)),
  ];
  for (const file of targets) {
    const base = path.basename(file);
    if (!doc.includes("`" + base + "`")) {
      issue("error", "frontend-undocumented", file, `docs/frontend.md 에 \`${base}\` 행이 없음`);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 4. MCP 도구 ↔ docs/architecture.md
// ─────────────────────────────────────────────────────────────
function checkMcpTools() {
  const doc = readDoc("docs/architecture.md");
  if (doc === null) return;
  const mcpFile = rp("src", "mcp", "claude-play-mcp-server.mjs");
  if (!fs.existsSync(mcpFile)) {
    issue("error", "mcp-server-missing", mcpFile, "MCP 서버 파일이 존재하지 않음");
    return;
  }
  const src = fs.readFileSync(mcpFile, "utf-8");
  const re = /server\.registerTool\(\s*"([a-z_]+)"/g;
  let m;
  let count = 0;
  while ((m = re.exec(src)) !== null) {
    count++;
    if (!doc.includes("`" + m[1] + "`")) {
      issue("error", "mcp-tool-undocumented", mcpFile, `docs/architecture.md MCP Tools 표에 \`${m[1]}\` 행이 없음`);
    }
  }
  if (count === 0) {
    issue("error", "mcp-tool-parse", mcpFile, "server.registerTool(\"name\" 패턴을 하나도 찾지 못함 — 등록 방식이 바뀌었으면 이 검사기를 갱신할 것");
  }
}

// ─────────────────────────────────────────────────────────────
// 5. 외부 MCP 툴 ↔ docs/external-mcp.md
// ─────────────────────────────────────────────────────────────
function checkExternalTools() {
  const doc = readDoc("docs/external-mcp.md");
  if (doc === null) return;
  const regFile = rp("src", "lib", "external-mcp", "registry.ts");
  if (!fs.existsSync(regFile)) return; // 서브시스템 자체가 없으면 검사 생략
  const src = fs.readFileSync(regFile, "utf-8");
  const re = /^\s*name:\s*"([a-z_]+)"/gm;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (!doc.includes("`" + m[1] + "`")) {
      issue("error", "external-tool-undocumented", regFile, `docs/external-mcp.md 에 \`${m[1]}\` 행이 없음`);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 6. docs/codebase-map.md 가 참조하는 경로 실존
// ─────────────────────────────────────────────────────────────
const MAP_PATH_RE = /`((?:src|scripts|gpu-manager|docs)\/[^`\s]+|server\.ts|tts-server\.mjs|next\.config\.ts|setup\.js|setup-web\.js|\.env\.example|[a-z-]+\.(?:md|yaml))`/g;

function checkCodebaseMap() {
  const rel = "docs/codebase-map.md";
  const doc = readDoc(rel);
  if (doc === null) return;
  const seen = new Set();
  let m;
  while ((m = MAP_PATH_RE.exec(doc)) !== null) {
    let ref = m[1];
    if (seen.has(ref)) continue;
    seen.add(ref);
    // `a/route.ts`·`b/route.ts` 같은 나열이나 `{a,b}` 확장은 검사에서 제외 (사람이 읽는 축약)
    if (/[{}·<>]/.test(ref)) continue;
    // 글롭 축약 (`src/app/api/profiles/*`, `docs/specs/2026-06-*`) 은 글롭 앞 디렉토리까지만 확인
    if (ref.includes("*")) ref = path.posix.dirname(ref.slice(0, ref.indexOf("*")) + "x");
    const abs = rp(...ref.split("/"));
    if (!fs.existsSync(abs)) {
      issue("error", "map-path-missing", rel, `참조 경로가 존재하지 않음: \`${m[1]}\``);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 7. 문서 표의 유령 항목 (문서에는 있는데 코드에 없음)
// ─────────────────────────────────────────────────────────────
function checkPhantoms() {
  const pairs = [
    ["docs/architecture.md", rp("src", "lib"), /^\| `([a-z0-9-]+\.(?:ts|mjs))` \|/gm],
    ["docs/frontend.md", rp("src", "components"), /^\| `([A-Z][A-Za-z0-9]+\.tsx)` \|/gm],
    ["docs/frontend.md", rp("src", "hooks"), /^\| `(use[A-Za-z0-9]+\.ts)` \|/gm],
  ];
  for (const [docRel, dir, re] of pairs) {
    const doc = readDoc(docRel);
    if (doc === null) continue;
    let m;
    while ((m = re.exec(doc)) !== null) {
      const name = m[1];
      const found = walk(dir, (f) => path.basename(f) === name).length > 0;
      if (!found) {
        issue("error", "doc-phantom-entry", docRel, `표에 \`${name}\` 행이 있지만 ${toPosix(path.relative(REPO_ROOT, dir))} 아래에 그 파일이 없음`);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 8. env var ↔ docs/infrastructure.md + .env.example (WARN)
// ─────────────────────────────────────────────────────────────
const ENV_IGNORE = new Set([
  "NODE_ENV", "PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP",
  "SystemRoot", "COMSPEC", "PWD", "SHELL", "CI", "TERM", "HOSTNAME", "COMPUTERNAME",
  "NODE_OPTIONS", "npm_config_user_agent", "USERNAME", "USER",
]);

function checkEnvVars() {
  const infra = readDoc("docs/infrastructure.md");
  const example = fs.existsSync(rp(".env.example")) ? fs.readFileSync(rp(".env.example"), "utf-8") : "";
  if (infra === null) return;
  const files = [
    ...walk(rp("src"), (f) => /\.(ts|tsx|mts|mjs)$/.test(f) && !TEST_RE.test(f)),
    rp("server.ts"),
    rp("tts-server.mjs"),
    ...walk(rp("scripts"), (f) => f.endsWith(".mjs")),
  ].filter((f) => fs.existsSync(f));
  const re = /process\.env\.([A-Z][A-Z0-9_]+)/g;
  const usage = new Map(); // name → first file
  for (const file of files) {
    const src = fs.readFileSync(file, "utf-8");
    let m;
    while ((m = re.exec(src)) !== null) {
      const name = m[1];
      if (ENV_IGNORE.has(name)) continue;
      if (!usage.has(name)) usage.set(name, file);
    }
  }
  for (const [name, file] of usage) {
    const inInfra = infra.includes(name);
    const inExample = example.includes(name);
    if (!inInfra && !inExample) {
      issue("warn", "env-undocumented", file, `process.env.${name} 이 docs/infrastructure.md 와 .env.example 어디에도 없음`);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 실행 + 리포트
// ─────────────────────────────────────────────────────────────
try {
  checkApiRoutes();
  checkLib();
  checkFrontend();
  checkMcpTools();
  checkExternalTools();
  checkCodebaseMap();
  checkPhantoms();
  checkEnvVars();
} catch (err) {
  console.error(`check-docs: 스크립트 오류 — ${err instanceof Error ? err.stack || err.message : String(err)}`);
  process.exit(2);
}

const errors = findings.filter((f) => f.severity === "error");
const warns = findings.filter((f) => f.severity === "warn");

if (wantJson) {
  console.log(JSON.stringify({ ok: errors.length === 0, errors: errors.length, warnings: warns.length, findings }, null, 2));
} else {
  for (const f of findings) {
    const tag = f.severity === "error" ? "ERROR" : "WARN ";
    console.log(`${tag} [${f.rule}] ${f.file} — ${f.msg}`);
  }
  console.log(`check-docs: ${errors.length} error(s), ${warns.length} warning(s)`);
}

process.exit(errors.length > 0 ? 1 : 0);
