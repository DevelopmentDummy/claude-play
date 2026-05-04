#!/usr/bin/env node
// build-manifest.mjs — LoRA 치트시트 .md → .manifest.txt 변환기 (v2: 트리거 포함)
//
// 사용법:
//   node build-manifest.mjs                  # 모든 *.md → *.manifest.txt + lora-triggers.from-cheatsheet.json
//   node build-manifest.mjs illustrious.md   # 단일 파일
//
// 출력 한 줄 포맷:
//   filename.safetensors [cat,flag1,flag2] 짧은 용도 │ 강도
//   filename.safetensors [cat,flag1,flag2,auto-trig] 짧은 용도 │ 강도
//   filename.safetensors [cat,flag1,flag2] 짧은 용도 │ 강도 │ trig?: tag1, tag2
//
// auto-trig: lora-triggers.json에 등록되어 서버가 자동 주입한다 → 토큰 값은 매니페스트에서 생략
// trig?:     selective — 옵션/바리에이션 동반. 자동 주입 X, 매번 사용자가 골라 박을 후보 토큰 노출
// (트리거 없는 항목은 두 표기 모두 생략)
//
// flag:
//   base       - [BASE]/[ANIMA-BASE]   (워크플로우에 자동 주입됨)
//   nsfw-base  - [NSFW-BASE]            (NSFW 컷에서만 자동 주입)
//   nsfw       - 카테고리에 NSFW 키워드
//   warn       - 비고에 ⚠️
//   broken     - 비고에 ❌
//   auto-trig  - 트리거가 lora-triggers.json에 등록됨 (서버가 자동 주입)
//
// 부산물:
//   lora-triggers.from-cheatsheet.json  치트시트에서 추출한 트리거 매핑 (검토용).
//                                       비교 결과를 stdout에 리포트하고, runtime인
//                                       lora-triggers.json은 절대 자동 덮어쓰지 않는다.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../../../..");
const RUNTIME_TRIGGERS_PATH = path.join(REPO_ROOT, "data/tools/comfyui/lora-triggers.json");
const SUGGESTION_PATH = path.join(REPO_ROOT, "data/tools/comfyui/lora-triggers.from-cheatsheet.json");

const CATEGORY_ALIAS = {
  "퀄리티/디테일": "quality",
  "스타일/연출": "style",
  "스크린캡 강화": "style",
  "포즈/액션": "pose",
  "체위 / 삽입": "pose",
  "삽입/체위": "pose",
  "의상/소품": "outfit",
  "노출/언더웨어": "exposure",
  "표정/감정": "expression",
  "캐릭터": "character",
  "배경/조명": "background",
  "특수 컨셉": "concept",
  "BDSM/구속": "bdsm",
  "기타": "misc",
  "커스텀 학습": "custom",
  "품질 / 범용 보정": "quality",
  "스타일": "style",
  "튜닝 / 특수 렌더": "tuning",
  "디테일러 / 해부학 디테일": "detailer",
  "포즈 / 체위 (NSFW)": "pose",
  "특수 컨셉 / 밈": "concept",
  "배경": "background",
};

function slugCategory(heading) {
  const stripped = heading.replace(/^#+\s*/, "").trim();
  if (CATEGORY_ALIAS[stripped]) return CATEGORY_ALIAS[stripped];
  return stripped.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "misc";
}

function shortenUse(text, max = 60) {
  let s = text.replace(/`[^`]+`/g, m => m.slice(1, -1));
  s = s.replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1).replace(/[,，·]\s*$/, "") + "…";
}

function extractFilename(cell) {
  const m = cell.match(/`([^`]+\.safetensors)`/);
  return m ? m[1] : null;
}

function compactStrength(cell) {
  let s = cell.replace(/`/g, "").replace(/\*\*/g, "").trim();
  s = s.replace(/~/g, "-");
  s = s.replace(/\s*\(시작[^)]*\)/g, "");
  s = s.replace(/\s*\(확정\)/g, "");
  s = s.replace(/\s+/g, "");
  return s;
}

// 트리거 컬럼 파싱
// 반환: { value: string, selective: boolean }
//   selective=true → 자동 주입에서 제외 (사용자가 수동으로 골라야 함)
//   - 옵션/바리에이션 마커 동반
//   - 슬래시 옵션 표기 (vaginal/anal 같은)
//   - 메타 토큰 누출 (<lora:> 등)
//   - 토큰 수가 비정상적으로 많음 (8개 초과 → 상황 묘사로 간주)
function extractTriggers(cell) {
  const empty = { value: "", selective: false };
  if (!cell) return empty;
  const cleaned = cell.replace(/\s+/g, " ").trim();

  if (/^(없음|무트리거|명시\s*없음|—|–|-)/i.test(cleaned)) return empty;

  // 옵션/바리에이션/보조 마커 감지 → selective
  const hasOptionMarker = /(\(\+?옵션|바리에이션\s*태그|\+\s*보조|옵션:)/.test(cell);

  // 옵션 부분 잘라내기 (selective 판정과 별개로, 매니페스트 표기에서 옵션은 제거)
  const truncated = cell
    .replace(/\s*\(\+?옵션[\s\S]*?\)/g, "")
    .replace(/\s*바리에이션\s*태그\s*:[\s\S]*$/m, "")
    .replace(/\s*\+\s*보조[\s\S]*$/, "");

  // 코드 스팬 추출
  const spans = [...truncated.matchAll(/`([^`]+)`/g)].map(m => m[1].trim()).filter(Boolean);
  let value = "";
  if (spans.length > 0) {
    value = cleanTriggerString(spans.join(", "));
  } else {
    if (/(태그와|태그 필수|함께|직접 서술|프롬프트 권장|프롬프트와)/.test(cleaned)) return empty;
    if (/^[\w\s,()@\-\\:]+$/.test(cleaned) && cleaned.length < 200) {
      value = cleanTriggerString(cleaned);
    }
  }

  if (!value) return empty;

  // selective 판정
  let selective = hasOptionMarker;
  if (/<lora/i.test(value)) selective = true;          // 메타 토큰 누출
  if (/\//.test(value)) selective = true;              // 슬래시 옵션 (vaginal/anal 등)
  const tokenCount = value.split(",").map(s => s.trim()).filter(Boolean).length;
  if (tokenCount > 8) selective = true;                // 너무 많으면 상황 묘사로 간주

  return { value, selective };
}

function cleanTriggerString(s) {
  return s
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[,;]\s*$/, "");
}

function detectFlags(category, notesCell, nameCell) {
  const flags = [];
  const allText = `${notesCell} ${nameCell}`;
  if (/\[BASE\]/.test(allText) || /\[ANIMA-BASE\]/.test(allText)) flags.push("base");
  if (/\[NSFW-BASE\]/.test(allText)) flags.push("nsfw-base");
  if (/nsfw|체위|exposure|bdsm|밈/i.test(category)) flags.push("nsfw");
  if (/❌/.test(notesCell)) flags.push("broken");
  if (/⚠️/.test(notesCell)) flags.push("warn");
  return [...new Set(flags)];
}

function parseTableLine(line) {
  if (!line.startsWith("|")) return null;
  const inner = line.slice(1, line.endsWith("|") ? -1 : undefined);
  const cells = inner.split("|").map(c => c.trim());
  if (cells.length < 4) return null;
  return cells;
}

function isSeparator(cells) {
  return cells.every(c => /^:?-+:?$/.test(c));
}

function parseMarkdown(md) {
  const lines = md.split(/\r?\n/);
  const entries = [];
  let currentCategory = "misc";
  let inTable = false;
  let tableHeaderSeen = false;

  for (const line of lines) {
    if (/^#{2,4}\s+/.test(line) && !line.startsWith("####")) {
      if (/^##\s+(LoRA 목록|사용 방법|프롬프트 운영 원칙|운영 노트|baseLoras|운영 추천)/.test(line)) {
        inTable = false;
        tableHeaderSeen = false;
        continue;
      }
      if (line.startsWith("### ")) {
        currentCategory = slugCategory(line);
        inTable = false;
        tableHeaderSeen = false;
      }
      continue;
    }
    if (line.startsWith("####")) continue;

    const cells = parseTableLine(line);
    if (!cells) {
      inTable = false;
      tableHeaderSeen = false;
      continue;
    }
    if (!tableHeaderSeen) {
      if (/LoRA\s*파일명|파일명/.test(cells[0])) {
        tableHeaderSeen = true;
        inTable = true;
      }
      continue;
    }
    if (isSeparator(cells)) continue;
    if (!inTable) continue;

    const [nameCell, strengthCell, useCell, triggerCell = "", notesCell = ""] = cells;
    const filename = extractFilename(nameCell);
    if (!filename) continue;

    const flags = detectFlags(currentCategory, notesCell, nameCell);
    const flagStr = [currentCategory, ...flags].join(",");
    const strength = compactStrength(strengthCell);
    const use = shortenUse(useCell);
    const trig = extractTriggers(triggerCell);

    entries.push({
      filename,
      flags: flagStr,
      use,
      strength,
      triggers: trig.value,
      triggersSelective: trig.selective,
    });
  }
  return entries;
}

function formatManifest(entries, sourcePath, runtimeTriggers) {
  const header = [
    `# 자동 생성된 LoRA 매니페스트 — 직접 편집 금지`,
    `# 원본: ${path.basename(sourcePath)}`,
    `# 생성: ${new Date().toISOString()}`,
    `# 포맷: 파일명 [카테고리,플래그] 짧은 용도 │ 강도 [│ trig?: 태그]`,
    `# 플래그: base, nsfw-base, nsfw, warn(⚠️), broken(❌), auto-trig`,
    `# auto-trig: lora-triggers.json에 등록되어 서버가 자동 주입 (토큰 값은 매니페스트에 안 적음)`,
    `# trig?:    selective — 옵션/바리에이션 동반. 자동 주입 X, 후보 토큰에서 골라 직접 박을 것`,
    `# 풀 노트가 필요하면 원본 .md를 grep`,
    ``,
  ].join("\n");

  const body = entries
    .map(e => {
      const flags = e.flags.split(",");
      const isAuto = !!e.triggers && !e.triggersSelective && runtimeTriggers[e.filename];
      if (isAuto) flags.push("auto-trig");
      const base = `${e.filename} [${flags.join(",")}] ${e.use} │ ${e.strength}`;
      if (e.triggers && e.triggersSelective) {
        return `${base} │ trig?: ${e.triggers}`;
      }
      return base;
    })
    .join("\n");

  return header + body + "\n";
}

function processFile(mdPath, runtimeTriggers = {}) {
  const md = fs.readFileSync(mdPath, "utf-8");
  const entries = parseMarkdown(md);
  const outPath = mdPath.replace(/\.md$/, ".manifest.txt");
  const manifest = formatManifest(entries, mdPath, runtimeTriggers);
  fs.writeFileSync(outPath, manifest, "utf-8");
  return { outPath, count: entries.length, bytes: manifest.length, entries };
}

function loadRuntimeTriggers() {
  if (!fs.existsSync(RUNTIME_TRIGGERS_PATH)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(RUNTIME_TRIGGERS_PATH, "utf-8"));
    delete data._comment;
    return data;
  } catch {
    return {};
  }
}

function writeSuggestionFile(allEntries) {
  const suggestion = {
    _comment: "자동 추출된 LoRA → 트리거 매핑 (build-manifest.mjs). selective(옵션/바리에이션 동반) 항목은 제외됨. 검토 후 lora-triggers.json에 머지하라. 이 파일은 매 빌드마다 덮어써진다.",
  };
  const sorted = [...allEntries].sort((a, b) => a.filename.localeCompare(b.filename));
  let excluded = 0;
  for (const e of sorted) {
    if (!e.triggers) continue;
    if (e.triggersSelective) { excluded++; continue; }
    suggestion[e.filename] = e.triggers;
  }
  fs.writeFileSync(SUGGESTION_PATH, JSON.stringify(suggestion, null, 2) + "\n", "utf-8");
  return { suggestion, excluded };
}

function diffTriggers(suggestion, runtime) {
  const sKeys = new Set(Object.keys(suggestion).filter(k => k !== "_comment"));
  const rKeys = new Set(Object.keys(runtime));
  const onlyInSuggestion = [...sKeys].filter(k => !rKeys.has(k));
  const onlyInRuntime = [...rKeys].filter(k => !sKeys.has(k));
  const conflicting = [...sKeys].filter(k => rKeys.has(k) && runtime[k] !== suggestion[k]);
  return { onlyInSuggestion, onlyInRuntime, conflicting };
}

function main() {
  const args = process.argv.slice(2);
  const baseDir = __dirname;
  let targets;
  if (args.length > 0) {
    targets = args.map(a => path.isAbsolute(a) ? a : path.join(baseDir, a));
  } else {
    targets = fs.readdirSync(baseDir)
      .filter(f => f.endsWith(".md") && !f.endsWith(".compat-log.md") && f !== "index.md")
      .map(f => path.join(baseDir, f));
  }

  const runtime = loadRuntimeTriggers();
  console.log(`[manifest] ${targets.length} 파일 처리 (runtime 트리거 ${Object.keys(runtime).length}개 참조)`);
  const allEntries = [];
  for (const t of targets) {
    try {
      const r = processFile(t, runtime);
      const auto = r.entries.filter(e => e.triggers && !e.triggersSelective && runtime[e.filename]).length;
      const selective = r.entries.filter(e => e.triggersSelective).length;
      console.log(`  ✓ ${path.basename(t)} → ${path.basename(r.outPath)} (${r.count}개, auto-trig ${auto}, trig? ${selective}, ${r.bytes}B)`);
      allEntries.push(...r.entries);
    } catch (e) {
      console.error(`  ✗ ${path.basename(t)}: ${e.message}`);
    }
  }

  if (args.length === 0) {
    // Full build → also emit suggestion file + diff vs runtime
    const { suggestion, excluded } = writeSuggestionFile(allEntries);
    const diff = diffTriggers(suggestion, runtime);
    const sCount = Object.keys(suggestion).filter(k => k !== "_comment").length;
    console.log("");
    console.log(`[triggers] 자동주입 후보 ${sCount}개 / selective 제외 ${excluded}개 → ${path.relative(REPO_ROOT, SUGGESTION_PATH)}`);
    console.log(`  runtime(lora-triggers.json) 항목: ${Object.keys(runtime).length}개`);
    if (diff.onlyInSuggestion.length > 0) {
      console.log(`  ➕ runtime에 없음 (백필 후보): ${diff.onlyInSuggestion.length}개`);
      diff.onlyInSuggestion.slice(0, 10).forEach(k => console.log(`     - ${k}`));
      if (diff.onlyInSuggestion.length > 10) console.log(`     ... 외 ${diff.onlyInSuggestion.length - 10}개`);
    }
    if (diff.conflicting.length > 0) {
      console.log(`  ⚠️ 값 충돌: ${diff.conflicting.length}개`);
      diff.conflicting.forEach(k => {
        console.log(`     ${k}`);
        console.log(`       runtime    : ${runtime[k]}`);
        console.log(`       cheatsheet : ${suggestion[k]}`);
      });
    }
    if (diff.onlyInRuntime.length > 0) {
      console.log(`  ℹ️ 치트시트에 없음 (runtime 단독): ${diff.onlyInRuntime.length}개`);
    }
    console.log("");
    console.log(`[hint] runtime 백필이 필요하면 ${path.basename(SUGGESTION_PATH)}를 참고해 lora-triggers.json에 수동 머지하라.`);
    console.log(`       (스크립트는 runtime 파일을 자동 덮어쓰지 않는다.)`);
  }
}

main();
