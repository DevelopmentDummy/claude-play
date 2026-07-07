#!/usr/bin/env node
/**
 * lint-data.mjs — data/ 디렉토리 읽기 전용 무결성 검사기
 *
 * data/personas/* 와 data/sessions/* 아래의 모든 *.json을 파싱 검증한다.
 * 어떤 파일도 수정하지 않는다 (read-only).
 *
 * ERROR tier:
 *   - JSON.parse 실패
 *   - UTF-8 BOM(0xEF 0xBB 0xBF)으로 시작하는 JSON
 *     (알려진 사고: PowerShell 5.1 `-Encoding utf8`이 BOM을 붙여 Go 기반 agy 파서가 깨짐)
 *
 * WARN tier (가벼운 shape 검사):
 *   - session.json: persona / model 키 누락
 *   - variables.json: 객체(object)로 파싱되지 않음
 *   - layout.json: 알 수 없는 placement 값
 *     (src/hooks/useLayout.ts 기준 허용 집합: left, right, modal, modal-dismissible,
 *      full-screen, dock, dock-left, dock-right, dock-bottom)
 *   - voice.json: ttsProvider가 허용 집합 밖
 *     (src/lib/session-config-io.ts 기준: comfyui, edge, local, voxcpm)
 *
 * DATA_DIR env를 존중한다 (미설정 시 리포 루트의 ./data — src/lib/data-dir.ts와 동일 규칙).
 *
 * 사용법:
 *   node scripts/lint-data.mjs
 *   node scripts/lint-data.mjs --json
 *
 * Exit codes:
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

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(REPO_ROOT, "data");

// src/hooks/useLayout.ts LayoutConfig.panels.placement 의 실제 허용 집합
const VALID_PLACEMENTS = new Set([
  "left", "right", "modal", "modal-dismissible", "full-screen",
  "dock", "dock-left", "dock-right", "dock-bottom",
]);

// src/lib/session-config-io.ts readVoiceConfig 의 실제 허용 집합
const VALID_TTS_PROVIDERS = new Set(["comfyui", "edge", "local", "voxcpm"]);

const SKIP_DIR_NAMES = new Set(["node_modules", "deleted_personas", "deleted_sessions", "images"]);

// ─────────────────────────────────────────────────────────────
// 문제 수집 (lint-persona.mjs와 동일한 컨벤션)
// ─────────────────────────────────────────────────────────────
const findings = []; // { severity, rule, file, msg }

function issue(severity, rule, file, msg) {
  // 리포 내부면 리포 상대경로, 외부(DATA_DIR override)면 DATA_DIR 상대경로로 표기
  let rel = path.relative(REPO_ROOT, file);
  if (rel.startsWith("..")) rel = path.join("<DATA_DIR>", path.relative(DATA_DIR, file));
  findings.push({ severity, rule, file: rel.replace(/\\/g, "/"), msg });
}

// ─────────────────────────────────────────────────────────────
// 파일 워커 — .json 확장자만, 읽기 전에 스킵 판정
// ─────────────────────────────────────────────────────────────
let scannedCount = 0;

function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    issue("warn", "walk", dir, `디렉토리 읽기 실패: ${err.message}`);
    return;
  }
  for (const entry of entries) {
    const name = entry.name;
    const full = path.join(dir, name);
    if (entry.isDirectory()) {
      if (name.startsWith(".")) continue;            // dot-dirs (.claude, .codex, .git, ...)
      if (SKIP_DIR_NAMES.has(name)) continue;         // node_modules / deleted_* / images
      walk(full);
      continue;
    }
    if (!entry.isFile()) continue;
    // 읽기 전에 확장자로 스킵: .json이 아니면 (이미지 포함) 열지도 않음
    if (!name.toLowerCase().endsWith(".json")) continue;
    lintJsonFile(full, name);
  }
}

function lintJsonFile(file, basename) {
  scannedCount++;
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (err) {
    issue("error", "read", file, `파일 읽기 실패: ${err.message}`);
    return;
  }

  // BOM 검사 (0xEF 0xBB 0xBF)
  let text;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    issue("error", "utf8-bom", file,
      "UTF-8 BOM으로 시작함 — Go 기반 agy 파서가 깨짐 (PowerShell 5.1 -Encoding utf8 사고 유형). node fs/Write 도구로 재저장할 것");
    text = buf.subarray(3).toString("utf-8"); // 파싱 검사는 BOM 제거 후 계속
  } else {
    text = buf.toString("utf-8");
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    issue("error", "json-parse", file, `JSON 파싱 실패: ${err.message}`);
    return;
  }

  // ── WARN tier: 파일명별 가벼운 shape 검사 ──
  const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

  if (basename === "session.json") {
    if (!isObject(data)) {
      issue("warn", "session-shape", file, "session.json이 객체가 아님");
    } else {
      if (!("persona" in data)) issue("warn", "session-shape", file, "session.json에 persona 키 없음");
      if (!("model" in data)) issue("warn", "session-shape", file, "session.json에 model 키 없음");
    }
  } else if (basename === "variables.json") {
    if (!isObject(data)) {
      issue("warn", "variables-shape", file, `variables.json이 객체로 파싱되지 않음 (실제: ${Array.isArray(data) ? "array" : typeof data})`);
    }
  } else if (basename === "layout.json") {
    if (isObject(data)) {
      // 실사용 형태: layout.panels.placement (page.tsx) — 방어적으로 top-level placement도 검사
      const maps = [];
      if (isObject(data.panels) && isObject(data.panels.placement)) maps.push(data.panels.placement);
      if (isObject(data.placement)) maps.push(data.placement);
      for (const map of maps) {
        for (const [panel, val] of Object.entries(map)) {
          if (typeof val !== "string" || !VALID_PLACEMENTS.has(val)) {
            issue("warn", "layout-placement", file,
              `패널 "${panel}"의 placement "${val}"는 알 수 없는 값 (허용: ${[...VALID_PLACEMENTS].join(", ")})`);
          }
        }
      }
    }
  } else if (basename === "voice.json") {
    if (isObject(data) && "ttsProvider" in data && !VALID_TTS_PROVIDERS.has(data.ttsProvider)) {
      issue("warn", "voice-provider", file,
        `ttsProvider "${data.ttsProvider}"는 알 수 없는 값 (허용: ${[...VALID_TTS_PROVIDERS].join(", ")})`);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────────────────
try {
  const roots = [path.join(DATA_DIR, "personas"), path.join(DATA_DIR, "sessions")];
  for (const root of roots) {
    if (!fs.existsSync(root)) {
      issue("warn", "missing-root", root, "스캔 루트가 존재하지 않음");
      continue;
    }
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || SKIP_DIR_NAMES.has(entry.name)) continue;
      walk(path.join(root, entry.name));
    }
  }
} catch (err) {
  console.error(`[lint-data] 스크립트 오류: ${err.message}`);
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
  console.log(JSON.stringify({ dataDir: DATA_DIR, scanned: scannedCount, findings, summary: summarize(findings) }, null, 2));
} else {
  console.log(`데이터 디렉토리: ${DATA_DIR}`);
  console.log(`스캔한 JSON 파일: ${scannedCount}개`);
  if (findings.length === 0) {
    console.log(`✓ 문제 없음`);
  } else {
    for (const f of findings) {
      const tag = f.severity === "error" ? "✗ ERROR" : "⚠ WARN";
      console.log(`  ${tag} [${f.rule}] ${f.file}`);
      console.log(`    ${f.msg}`);
    }
    const s = summarize(findings);
    console.log(`\n총계: ${s.errors} error, ${s.warnings} warning (${scannedCount}개 JSON 스캔)`);
  }
}

const s = summarize(findings);
process.exit(s.errors > 0 ? 1 : 0);
