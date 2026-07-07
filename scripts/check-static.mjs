#!/usr/bin/env node
/**
 * check-static.mjs — 정적 무결성 검사기 (기계 검증용, 서버 실행 없음)
 *
 * 세 가지를 검사한다:
 *   1. 1급 JS 엔트리 구문 검사 — `node --check`로 파싱만 수행 (실행 안 함)
 *   2. 런타임이 참조하는 핵심 파일 존재 여부
 *   3. 프로바이더 CLI 가용성 프로브 (claude/codex/kimi/agy --version) — WARN 전용, 절대 실패 아님
 *
 * 사용법:
 *   node scripts/check-static.mjs
 *   node scripts/check-static.mjs --json
 *
 * Exit codes:
 *   0 — 문제 없음 (WARN만 있어도 0)
 *   1 — 에러 발견
 *   2 — 스크립트 자체 오류
 */

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const wantJson = args.includes("--json");

// ─────────────────────────────────────────────────────────────
// 문제 수집 (lint-persona.mjs와 동일한 컨벤션)
// ─────────────────────────────────────────────────────────────
const findings = []; // { severity, rule, file, msg }

function issue(severity, rule, file, msg) {
  const rel = path.isAbsolute(file) ? path.relative(REPO_ROOT, file) : file;
  findings.push({ severity, rule, file: rel.replace(/\\/g, "/"), msg });
}

// ─────────────────────────────────────────────────────────────
// Check 1: node --check 구문 검사
// ─────────────────────────────────────────────────────────────
function collectSyntaxTargets() {
  const fixed = [
    "src/mcp/claude-play-mcp-server.mjs",
    "tts-server.mjs",
    "setup.js",
    "setup-web.js",
    "postcss.config.mjs",
  ].map((p) => path.join(REPO_ROOT, ...p.split("/")));

  const scriptsDir = path.join(REPO_ROOT, "scripts");
  if (fs.existsSync(scriptsDir)) {
    for (const entry of fs.readdirSync(scriptsDir)) {
      if (entry.endsWith(".mjs")) fixed.push(path.join(scriptsDir, entry));
    }
  }
  // dedupe (scripts/*.mjs 글롭이 고정 목록과 겹칠 수 있음)
  return [...new Set(fixed)];
}

function checkSyntax(file) {
  if (!fs.existsSync(file)) {
    issue("error", "syntax-target-missing", file, "구문 검사 대상 파일이 존재하지 않음");
    return;
  }
  // 경로에 공백이 있어도 안전: argv 배열 + shell 미사용
  const res = spawnSync(process.execPath, ["--check", file], {
    encoding: "utf-8",
    timeout: 30_000,
    windowsHide: true,
  });
  if (res.error) {
    issue("error", "syntax-spawn", file, `node --check 실행 실패: ${res.error.message}`);
    return;
  }
  if (res.status !== 0) {
    const detail = (res.stderr || res.stdout || "").trim().split(/\r?\n/).slice(0, 4).join(" | ");
    issue("error", "syntax", file, `구문 오류 (node --check exit ${res.status}): ${detail}`);
  }
}

// ─────────────────────────────────────────────────────────────
// Check 2: 런타임 참조 핵심 파일 존재 여부
// ─────────────────────────────────────────────────────────────
const REQUIRED_FILES = [
  "tts-server.mjs",              // server.ts가 detached spawn
  "builder-prompt.md",           // /api/builder/start·edit이 매번 컴파일
  "session-shared.md",           // 세션 인스트럭션 조립
  "panel-spec.md",               // 패널 스펙 주입
  "src/mcp/claude-play-mcp-server.mjs", // per-session MCP 서버
  "scripts/restart.mjs",         // restart 오케스트레이터
];
const WARN_ONLY_FILES = [
  "gpu-manager/server.py",       // GPU Manager (opt-in — 없어도 코어 기능 동작)
];

function checkExistence() {
  for (const rel of REQUIRED_FILES) {
    const abs = path.join(REPO_ROOT, ...rel.split("/"));
    if (!fs.existsSync(abs)) {
      issue("error", "missing-file", rel, "런타임이 참조하는 필수 파일이 없음");
    }
  }
  for (const rel of WARN_ONLY_FILES) {
    const abs = path.join(REPO_ROOT, ...rel.split("/"));
    if (!fs.existsSync(abs)) {
      issue("warn", "missing-optional-file", rel, "선택적 런타임 파일이 없음 (GPU Manager 등 opt-in 기능 비활성)");
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Check 3: 프로바이더 CLI 가용성 프로브 (WARN 전용 — 절대 error 아님)
// ─────────────────────────────────────────────────────────────
const PROVIDER_CLIS = ["claude", "codex", "kimi", "agy"];

function probeProviders() {
  for (const cli of PROVIDER_CLIS) {
    // Windows에서 .cmd shim은 shell:true 필요. 인자는 고정 리터럴이라 안전.
    const res = spawnSync(cli, ["--version"], {
      encoding: "utf-8",
      timeout: 5_000,
      shell: process.platform === "win32",
      windowsHide: true,
    });
    if (res.error) {
      const reason = res.error.code === "ETIMEDOUT" ? "5초 타임아웃" : res.error.message;
      issue("warn", "provider-cli", cli, `프로바이더 CLI '${cli}' 사용 불가 (${reason})`);
      continue;
    }
    if (res.signal) {
      issue("warn", "provider-cli", cli, `프로바이더 CLI '${cli}' 사용 불가 (signal ${res.signal} — 타임아웃 추정)`);
      continue;
    }
    if (res.status !== 0) {
      issue("warn", "provider-cli", cli, `프로바이더 CLI '${cli}' 사용 불가 (--version exit ${res.status})`);
      continue;
    }
    const version = (res.stdout || "").trim().split(/\r?\n/)[0];
    okProbes.push({ cli, version });
  }
}
const okProbes = []; // { cli, version }

// ─────────────────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────────────────
let syntaxTargets = [];
try {
  syntaxTargets = collectSyntaxTargets();
  for (const f of syntaxTargets) checkSyntax(f);
  checkExistence();
  probeProviders();
} catch (err) {
  console.error(`[check-static] 스크립트 오류: ${err.message}`);
  process.exit(2);
}

// ─────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────
function summarize(list) {
  return {
    errors: list.filter((f) => f.severity === "error").length,
    warnings: list.filter((f) => f.severity === "warn").length,
  };
}

if (wantJson) {
  console.log(JSON.stringify({
    findings,
    providers: okProbes,
    checked: { syntaxFiles: syntaxTargets.length, requiredFiles: REQUIRED_FILES.length + WARN_ONLY_FILES.length },
    summary: summarize(findings),
  }, null, 2));
} else {
  console.log(`구문 검사: ${syntaxTargets.length}개 파일 (node --check)`);
  console.log(`존재 검사: 필수 ${REQUIRED_FILES.length}개 + 선택 ${WARN_ONLY_FILES.length}개`);
  for (const p of okProbes) console.log(`  ✓ CLI ${p.cli}: ${p.version}`);
  if (findings.length === 0) {
    console.log(`✓ 문제 없음`);
  } else {
    for (const f of findings) {
      const tag = f.severity === "error" ? "✗ ERROR" : "⚠ WARN";
      console.log(`  ${tag} [${f.rule}] ${f.file}`);
      console.log(`    ${f.msg}`);
    }
    const s = summarize(findings);
    console.log(`\n총계: ${s.errors} error, ${s.warnings} warning`);
  }
}

const s = summarize(findings);
process.exit(s.errors > 0 ? 1 : 0);
