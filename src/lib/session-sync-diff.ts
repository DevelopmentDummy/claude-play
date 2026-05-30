// SessionManager sync/diff 술어 — persona↔session 비교(read-only). 추출(Wave 12 cluster 1).
import * as fs from "fs";
import * as path from "path";
import { SYSTEM_JSON } from "./session-state";

export function fileDiffers(src: string, dst: string): boolean {
  if (!fs.existsSync(src)) return false;
  if (!fs.existsSync(dst)) return true;
  try {
    const a = fs.readFileSync(src);
    const b = fs.readFileSync(dst);
    return !a.equals(b);
  } catch { return true; }
}

/** Compare only persona skill subdirs against their counterparts in a CLI skill dir (ignoring global tool skills) */
export function personaSkillsDiffer(src: string, dst: string): boolean {
  if (!fs.existsSync(src)) return false;
  if (!fs.existsSync(dst)) return true;
  try {
    const srcEntries = fs.readdirSync(src, { withFileTypes: true }).filter(e => e.isDirectory());
    for (const entry of srcEntries) {
      const srcSkill = path.join(src, entry.name);
      const dstSkill = path.join(dst, entry.name);
      if (!fs.existsSync(dstSkill)) return true;
      if (dirDiffers(srcSkill, dstSkill)) return true;
    }
    return false;
  } catch { return true; }
}

export function dirDiffers(src: string, dst: string): boolean {
  if (!fs.existsSync(src)) return false;
  if (!fs.existsSync(dst)) return true;
  try {
    const srcFiles = fs.readdirSync(src).filter(f => {
      try { return fs.statSync(path.join(src, f)).isFile(); } catch { return false; }
    });
    for (const file of srcFiles) {
      if (fileDiffers(path.join(src, file), path.join(dst, file))) return true;
    }
    return false;
  } catch { return true; }
}

/** Compare tools/ directories (*.js files only) */
export function toolsDiffer(dir1: string, dir2: string): boolean {
  if (!fs.existsSync(dir1) && !fs.existsSync(dir2)) return false;
  if (!fs.existsSync(dir1) || !fs.existsSync(dir2)) return true;
  const jsFiles1 = fs.readdirSync(dir1).filter(f => f.endsWith(".js")).sort();
  const jsFiles2 = fs.readdirSync(dir2).filter(f => f.endsWith(".js")).sort();
  if (jsFiles1.length !== jsFiles2.length) return true;
  for (let i = 0; i < jsFiles1.length; i++) {
    if (jsFiles1[i] !== jsFiles2[i]) return true;
    if (fileDiffers(path.join(dir1, jsFiles1[i]), path.join(dir2, jsFiles2[i]))) return true;
  }
  return false;
}

export function variablesDiffer(src: string, dst: string): boolean {
  if (!fs.existsSync(src)) return false;
  try {
    const personaVars = JSON.parse(fs.readFileSync(src, "utf-8"));
    const sessionVars = fs.existsSync(dst) ? JSON.parse(fs.readFileSync(dst, "utf-8")) : {};
    for (const key of Object.keys(personaVars)) {
      if (!(key in sessionVars)) return true;
    }
    return false;
  } catch { return false; }
}

/** Strip assembled sections (user info, opening, writing style) that are injected at session creation */
export function stripAssembledSections(text: string): string {
  let s = text;
  // Remove all occurrences of assembled sections (may be duplicated from bad syncs)
  s = s.replace(/\n\n## __문체 \(Writing Style\)__\n[\s\S]*?(?=\n\n## __|\s*$)/g, "");
  s = s.replace(/\n\n## __사용자 정보__\n[\s\S]*?(?=\n\n## __|\s*$)/g, "");
  s = s.replace(/\n\n## __오프닝 메시지__\n[\s\S]*?(?=\n\n## __|\s*$)/g, "");
  // Final pass: if __오프닝 메시지__ is the last section, the above won't catch it
  s = s.replace(/\n\n## __오프닝 메시지__\n[\s\S]*$/g, "");
  return s.trimEnd() + "\n";
}

/** Compare live instruction file (with assembled sections stripped) against raw persona file */
export function liveInstructionsDiffer(livePath: string, rawPath: string): boolean {
  if (!fs.existsSync(livePath)) return false;
  if (!fs.existsSync(rawPath)) return true;
  try {
    const live = stripAssembledSections(fs.readFileSync(livePath, "utf-8"));
    const raw = stripAssembledSections(fs.readFileSync(rawPath, "utf-8"));
    return live !== raw;
  } catch { return true; }
}

/** List custom data file names (*.json excluding system files) in a directory */
export function getCustomDataFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir).filter(f => {
      if (!f.endsWith(".json") || SYSTEM_JSON.has(f)) return false;
      try { return fs.statSync(path.join(dir, f)).isFile(); } catch { return false; }
    });
  } catch { return []; }
}
