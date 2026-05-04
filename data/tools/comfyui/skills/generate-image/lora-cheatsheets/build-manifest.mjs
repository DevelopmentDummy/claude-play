#!/usr/bin/env node
// build-manifest.mjs — LoRA 치트시트 .md → .manifest.txt 변환기 (v3: lora-triggers.json SSOT)
//
// 사용법:
//   node build-manifest.mjs                  # 모든 *.md → *.manifest.txt
//   node build-manifest.mjs illustrious.md   # 단일 파일
//
// 책임 분담 (2026-05-04 개편):
//   - data/tools/comfyui/lora-triggers.json  : 트리거 SSOT (auto / options 분리)
//   - 치트시트 .md                            : 사람용 문서 (트리거 컬럼은 참고 표시)
//   - .manifest.txt (이 스크립트 출력)        : 에이전트용 압축 카탈로그
//
// 매니페스트 한 줄 포맷:
//   filename [cat,flags] use │ strength                       (트리거 미등록)
//   filename [cat,flags,auto-trig] use │ strength             (auto만, string 또는 {auto: "..."})
//   filename [cat,flags,auto-trig] use │ strength │ trig?: ... (auto + options)
//   filename [cat,flags] use │ strength │ trig?: ...          (options만, pure selective)
//
// lora-triggers.json 스키마:
//   "filename.safetensors": "trigger string"           // 전부 auto (backward-compat)
//   "filename.safetensors": { "auto": "..." }          // auto만 (1번과 등가)
//   "filename.safetensors": { "auto": "...", "options": "..." }
//   "filename.safetensors": { "options": "..." }       // pure selective, 자동 주입 없음
//
// 더 이상 휴리스틱(토큰 수, 슬래시 등)으로 selective를 결정하지 않는다.
// 분류는 사용자가 lora-triggers.json에서 명시한 구조에 따른다.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../../../..");
const RUNTIME_TRIGGERS_PATH = path.join(REPO_ROOT, "data/tools/comfyui/lora-triggers.json");

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
  "오럴/페라": "oral",
  "파이즈리": "paizuri",
  "착유/수유": "lactation",
  "컨셉/상황": "concept",
  "구속/본디지 장비": "bdsm",
  "최면/정신조작": "mindcontrol",
  "난교/멀티": "group",
  "특수 체위/장비": "pose",
  "X-ray/내부 묘사": "xray",
  "사정/정액": "cum",
  "NSFW 해부학": "anatomy",
  "유두/가슴 특화": "breast",
  "분위기/배경": "background",
  "임신/번식": "pregnancy",
  "노출/NTR": "ntr",
  "촉수/부패 시퀀스": "tentacle",
  "마법/이펙트": "effect",
  "변신/상태이상": "transformation",
  "풋잡/페티시": "footjob",
  "자위": "masturbation",
  "장소/가구 특화": "location",
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

function detectFlags(category, notesCell, nameCell) {
  const flags = [];
  const allText = `${notesCell} ${nameCell}`;
  if (/\[BASE\]/.test(allText) || /\[ANIMA-BASE\]/.test(allText)) flags.push("base");
  if (/\[NSFW-BASE\]/.test(allText)) flags.push("nsfw-base");
  if (/nsfw|체위|exposure|bdsm|밈|cum|ntr|oral|footjob|masturbation/i.test(category)) flags.push("nsfw");
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
      if (/^##\s+(LoRA 목록|사용 방법|프롬프트 운영 원칙|운영 노트|baseLoras|운영 추천|규칙)/.test(line)) {
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

    const [nameCell, strengthCell, useCell, , notesCell = ""] = cells;
    const filename = extractFilename(nameCell);
    if (!filename) continue;

    const flags = detectFlags(currentCategory, notesCell, nameCell);
    const flagStr = [currentCategory, ...flags].join(",");
    const strength = compactStrength(strengthCell);
    const use = shortenUse(useCell);

    entries.push({ filename, flags: flagStr, use, strength });
  }
  return entries;
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

/** lora-triggers.json 엔트리 → 매니페스트 표기 결정
 * 반환: { hasAuto: boolean, options: string|null, registered: boolean }
 *  - registered=false: undefined (json에 없음, 진짜 미등록)
 *  - registered=true + hasAuto=false + options=null: 빈 문자열 또는 {auto:""} (의도적 트리거-없음)
 */
function classifyTrigger(entry) {
  if (entry === undefined) return { hasAuto: false, options: null, registered: false };
  if (typeof entry === "string") {
    return { hasAuto: entry.trim().length > 0, options: null, registered: true };
  }
  if (entry && typeof entry === "object") {
    const auto = typeof entry.auto === "string" ? entry.auto.trim() : "";
    const opts = typeof entry.options === "string" ? entry.options.trim() : "";
    return { hasAuto: auto.length > 0, options: opts || null, registered: true };
  }
  return { hasAuto: false, options: null, registered: false };
}

function formatManifest(entries, sourcePath, runtimeTriggers) {
  const header = [
    `# 자동 생성된 LoRA 매니페스트 — 직접 편집 금지`,
    `# 원본: ${path.basename(sourcePath)}`,
    `# 생성: ${new Date().toISOString()}`,
    `# 포맷: 파일명 [카테고리,플래그] 짧은 용도 │ 강도 [│ trig?: 후보 태그]`,
    `# 플래그: base, nsfw-base, nsfw, warn(⚠️), broken(❌), auto-trig, no-trigger`,
    `# auto-trig:  lora-triggers.json의 auto 토큰이 서버에서 자동 주입됨 (값은 매니페스트에 표시 안 함)`,
    `# no-trigger: lora-triggers.json에 등록되어 있지만 의도적으로 트리거 없음 (quality/style 부스터)`,
    `# trig?:    selective — 매번 사용자가 골라 직접 박을 후보 토큰`,
    `# 분류는 lora-triggers.json의 스키마에 따른다 (string=auto / {auto,options} 객체)`,
    ``,
  ].join("\n");

  const body = entries
    .map(e => {
      const cls = classifyTrigger(runtimeTriggers[e.filename]);
      const flags = e.flags.split(",");
      if (cls.hasAuto) flags.push("auto-trig");
      else if (cls.registered && !cls.options) flags.push("no-trigger");
      const base = `${e.filename} [${flags.join(",")}] ${e.use} │ ${e.strength}`;
      if (cls.options) {
        return `${base} │ trig?: ${cls.options}`;
      }
      return base;
    })
    .join("\n");

  return header + body + "\n";
}

function processFile(mdPath, runtimeTriggers) {
  const md = fs.readFileSync(mdPath, "utf-8");
  const entries = parseMarkdown(md);
  const outPath = mdPath.replace(/\.md$/, ".manifest.txt");
  const manifest = formatManifest(entries, mdPath, runtimeTriggers);
  fs.writeFileSync(outPath, manifest, "utf-8");
  return { outPath, count: entries.length, bytes: manifest.length, entries };
}

function summarize(entries, runtimeTriggers) {
  let auto = 0, autoPlus = 0, opt = 0, noTrig = 0, none = 0;
  for (const e of entries) {
    const cls = classifyTrigger(runtimeTriggers[e.filename]);
    if (cls.hasAuto && cls.options) autoPlus++;
    else if (cls.hasAuto) auto++;
    else if (cls.options) opt++;
    else if (cls.registered) noTrig++;
    else none++;
  }
  return { auto, autoPlus, opt, noTrig, none };
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
  // For classification we need raw values (string|object), not the post-load extraction.
  // Strip _comment but keep raw structure.
  const rawTriggers = { ...runtime };

  console.log(`[manifest] ${targets.length} 파일 처리 (lora-triggers ${Object.keys(rawTriggers).length}개 항목 참조)`);
  for (const t of targets) {
    try {
      const r = processFile(t, rawTriggers);
      const s = summarize(r.entries, rawTriggers);
      console.log(`  ✓ ${path.basename(t)} → ${path.basename(r.outPath)}`);
      console.log(`      LoRA ${r.count}개 — auto ${s.auto} / auto+옵션 ${s.autoPlus} / 옵션만 ${s.opt} / no-trigger ${s.noTrig} / 미등록 ${s.none} (${r.bytes}B)`);
    } catch (e) {
      console.error(`  ✗ ${path.basename(t)}: ${e.message}`);
    }
  }
  console.log("");
  console.log(`[hint] 새 LoRA 추가 / selective 분류는 lora-triggers.json 직접 편집:`);
  console.log(`       "file.safetensors": "trigger"                              // 전부 auto`);
  console.log(`       "file.safetensors": { "auto": "core", "options": "..." }   // 분리`);
  console.log(`       "file.safetensors": { "options": "..." }                   // pure selective`);
}

main();
