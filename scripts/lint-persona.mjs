#!/usr/bin/env node
/**
 * lint-persona.mjs — 페르소나 정적 분석기
 *
 * 레이어 책임 경계(panel-design 스킬의 아키텍처 원리) 위반을 정적으로 검출한다.
 * 단일 페르소나 디렉토리 또는 모든 페르소나를 스캔할 수 있다.
 *
 * 사용법:
 *   node scripts/lint-persona.mjs                    # data/personas/* 전부
 *   node scripts/lint-persona.mjs data/personas/be_a_god
 *   node scripts/lint-persona.mjs --json             # JSON 출력
 *
 * 검사 규칙:
 *   1. engine-meta.json 스키마 — actions 필드 구조, auto_tick_hours 타입 등
 *   2. 레거시 choice 스키마 — `{"tool":"engine",...}` 금지. `{"panel":"...","action":"..."}` 권장
 *   3. 패널 인라인 runTool — registerAction 블록 밖에서 `runTool('engine', ...)` 호출 금지
 *   4. 패널 커버리지 — engine-meta에 있는 mutating 액션이 어떤 패널에도 등록 안 됐으면 경고
 *   5. tick 금지 — choice actions나 예시에 `"action":"tick"` 등장 금지
 *
 * Exit codes:
 *   0 — 문제 없음
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
const positional = args.filter(a => !a.startsWith("--"));

const targets = [];
if (positional.length > 0) {
  for (const p of positional) targets.push(path.resolve(p));
} else {
  const personasDir = path.join(REPO_ROOT, "data", "personas");
  if (fs.existsSync(personasDir)) {
    for (const entry of fs.readdirSync(personasDir, { withFileTypes: true })) {
      if (entry.isDirectory()) targets.push(path.join(personasDir, entry.name));
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 문제 수집
// ─────────────────────────────────────────────────────────────
const findings = []; // { persona, severity, rule, file, line?, msg }

function issue(persona, severity, rule, file, msg, line) {
  findings.push({ persona, severity, rule, file: path.relative(REPO_ROOT, file).replace(/\\/g, "/"), line, msg });
}

// ─────────────────────────────────────────────────────────────
// Rule 1: engine-meta.json 스키마 검증
// ─────────────────────────────────────────────────────────────
function lintEngineMeta(persona, metaPath) {
  if (!fs.existsSync(metaPath)) return null;
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  } catch (err) {
    issue(persona, "error", "engine-meta-parse", metaPath, `JSON 파싱 실패: ${err.message}`);
    return null;
  }

  if (!meta.actions || typeof meta.actions !== "object") {
    issue(persona, "error", "engine-meta-structure", metaPath, "`actions` 필드가 객체가 아님");
    return meta;
  }

  for (const [key, action] of Object.entries(meta.actions)) {
    if (!action || typeof action !== "object") {
      issue(persona, "error", "engine-meta-action", metaPath, `액션 "${key}"가 객체가 아님`);
      continue;
    }
    if (typeof action.description !== "string") {
      issue(persona, "warn", "engine-meta-action", metaPath, `액션 "${key}"에 description 문자열 없음`);
    }
    if ("auto_tick_hours" in action && typeof action.auto_tick_hours !== "number") {
      issue(persona, "error", "engine-meta-action", metaPath, `액션 "${key}"의 auto_tick_hours가 number가 아님`);
    }
    if ("available_when" in action && typeof action.available_when !== "object") {
      issue(persona, "warn", "engine-meta-action", metaPath, `액션 "${key}"의 available_when이 객체가 아님`);
    }
    if ("choice_examples" in action && !Array.isArray(action.choice_examples)) {
      issue(persona, "warn", "engine-meta-action", metaPath, `액션 "${key}"의 choice_examples가 배열이 아님`);
    }
  }

  // tick은 _internal_actions에만 있어야 함 (공개 actions 금지)
  if ("tick" in meta.actions) {
    issue(persona, "error", "tick-exposed", metaPath, "`tick`이 공개 actions에 노출됨. `_internal_actions`로 이동해야 함");
  }

  return meta;
}

// ─────────────────────────────────────────────────────────────
// Rule 2+5: 레거시 choice 스키마 / tick 호출 탐색 (md/json 파일)
// ─────────────────────────────────────────────────────────────
function lintLegacyChoices(persona, file) {
  if (!fs.existsSync(file)) return;
  const content = fs.readFileSync(file, "utf-8");
  const lines = content.split(/\r?\n/);

  lines.forEach((line, idx) => {
    const ln = idx + 1;
    // Legacy { "tool": "engine" } pattern in choice actions
    if (/"tool"\s*:\s*"engine"/.test(line)) {
      issue(persona, "error", "legacy-choice-schema", file,
        `legacy choice 스키마 — "tool":"engine" 대신 "panel":"...","action":"..." 사용`, ln);
    }
    // Tick in choice actions
    if (/"action"\s*:\s*"tick"/.test(line)) {
      issue(persona, "error", "tick-in-choice", file,
        `choice 또는 예시에 tick 호출이 노출됨. tick은 엔진 내부 전용`, ln);
    }
  });
}

// ─────────────────────────────────────────────────────────────
// Rule 3: 패널 인라인 runTool (registerAction 블록 밖)
// ─────────────────────────────────────────────────────────────
function lintPanelInlineRunTool(persona, panelFile) {
  if (!fs.existsSync(panelFile)) return;
  const content = fs.readFileSync(panelFile, "utf-8");
  const lines = content.split(/\r?\n/);

  // 간단 휴리스틱: __panelBridge.registerAction 블록의 대략적 범위를 추적.
  // registerAction( 을 만나면 추적 시작, 매칭 괄호가 닫히면 종료.
  // 그 외 영역에서 __panelBridge.runTool('engine', ... 같은 호출이 있으면 경고.
  let depth = 0;
  let inRegisterAction = false;
  let regStartLine = 0;

  lines.forEach((line, idx) => {
    const ln = idx + 1;
    if (!inRegisterAction && /__panelBridge\.registerAction\s*\(/.test(line)) {
      inRegisterAction = true;
      regStartLine = ln;
      // count parens on this line
      const opens = (line.match(/\(/g) || []).length;
      const closes = (line.match(/\)/g) || []).length;
      depth = opens - closes;
      if (depth <= 0) { inRegisterAction = false; depth = 0; }
      return;
    }
    if (inRegisterAction) {
      const opens = (line.match(/\(/g) || []).length;
      const closes = (line.match(/\)/g) || []).length;
      depth += opens - closes;
      if (depth <= 0) {
        inRegisterAction = false;
        depth = 0;
      }
      return;
    }
    // Outside registerAction blocks — flag runTool('engine', ...)
    if (/__panelBridge\.runTool\s*\(\s*['"]engine['"]/.test(line)) {
      // Check if inside a comment
      if (/^\s*(\/\/|\*|<!--)/.test(line)) return;
      // Allow explicit disable pragma on same or preceding line
      const prevLine = idx > 0 ? lines[idx - 1] : "";
      if (/lint-persona:\s*allow-runtool/.test(line) || /lint-persona:\s*allow-runtool/.test(prevLine)) return;
      issue(persona, "error", "inline-runtool-engine", panelFile,
        `registerAction 블록 밖에서 runTool('engine', ...) 직접 호출. executeAction 경로로 위임해야 함 (공용 헬퍼 함수면 위 줄에 "// lint-persona: allow-runtool" 추가)`, ln);
    }
  });
}

// ─────────────────────────────────────────────────────────────
// Rule 4: 패널 커버리지 (mutating 엔진 액션이 어떤 패널에도 registerAction 안 됐는지)
// ─────────────────────────────────────────────────────────────
function lintPanelCoverage(persona, meta, panelFiles) {
  if (!meta?.actions) return;
  const registered = new Set();
  for (const pf of panelFiles) {
    if (!fs.existsSync(pf)) continue;
    const content = fs.readFileSync(pf, "utf-8");
    // __panelBridge.registerAction('name', ...) 에서 name 추출
    const re = /__panelBridge\.registerAction\s*\(\s*['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(content)) !== null) registered.add(m[1]);
  }
  for (const [name, action] of Object.entries(meta.actions)) {
    const hours = action?.auto_tick_hours;
    const isMutating = (typeof hours !== "number") || hours > 0 || name !== "query_status";
    if (!isMutating) continue;
    if (!registered.has(name)) {
      issue(persona, "warn", "panel-coverage", path.join(path.dirname(panelFiles[0] || ""), ".coverage"),
        `엔진 액션 "${name}"이 어떤 패널에도 registerAction으로 등록되지 않음. AI 선택지만으로 호출 가능한지 확인`);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Persona-level lint
// ─────────────────────────────────────────────────────────────
function lintPersona(personaDir) {
  const persona = path.basename(personaDir);
  const metaPath = path.join(personaDir, "engine-meta.json");
  const meta = lintEngineMeta(persona, metaPath);

  // Legacy choice/tick scans
  const scanFiles = [
    path.join(personaDir, "opening.md"),
    path.join(personaDir, "session-instructions.md"),
    path.join(personaDir, "engine-meta.json"),
    path.join(personaDir, "CLAUDE.md"),
    path.join(personaDir, "GEMINI.md"),
    path.join(personaDir, "AGENTS.md"),
  ];
  for (const f of scanFiles) lintLegacyChoices(persona, f);

  // Panel inline runTool + coverage
  const panelsDir = path.join(personaDir, "panels");
  const panelFiles = [];
  if (fs.existsSync(panelsDir)) {
    for (const entry of fs.readdirSync(panelsDir)) {
      if (entry.endsWith(".html")) {
        const p = path.join(panelsDir, entry);
        panelFiles.push(p);
        lintPanelInlineRunTool(persona, p);
      }
    }
  }
  lintPanelCoverage(persona, meta, panelFiles);
}

// ─────────────────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────────────────
for (const t of targets) {
  try {
    lintPersona(t);
  } catch (err) {
    console.error(`[lint-persona] ${t}: ${err.message}`);
    process.exit(2);
  }
}

// ─────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────
if (wantJson) {
  console.log(JSON.stringify({ findings, summary: summarize(findings) }, null, 2));
} else {
  if (findings.length === 0) {
    console.log(`✓ ${targets.length}개 페르소나 — 문제 없음`);
  } else {
    const byPersona = new Map();
    for (const f of findings) {
      if (!byPersona.has(f.persona)) byPersona.set(f.persona, []);
      byPersona.get(f.persona).push(f);
    }
    for (const [p, list] of byPersona) {
      console.log(`\n── ${p} ──`);
      for (const f of list) {
        const loc = f.line ? `${f.file}:${f.line}` : f.file;
        const tag = f.severity === "error" ? "✗ ERROR" : "⚠ WARN";
        console.log(`  ${tag} [${f.rule}] ${loc}`);
        console.log(`    ${f.msg}`);
      }
    }
    const s = summarize(findings);
    console.log(`\n총계: ${s.errors} error, ${s.warnings} warning (${targets.length}개 페르소나)`);
  }
}

function summarize(list) {
  return {
    errors: list.filter(f => f.severity === "error").length,
    warnings: list.filter(f => f.severity === "warn").length,
  };
}

const s = summarize(findings);
process.exit(s.errors > 0 ? 1 : 0);
