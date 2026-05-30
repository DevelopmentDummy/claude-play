import * as fs from "fs";
import * as path from "path";
import { retryOnWindowsLock } from "./fs-retry";

type Dict = Record<string, unknown>;

// ── SSOT 상수 ────────────────────────────────────────────────
/** 세션 디렉터리에서 페르소나 "데이터"가 아닌 시스템 JSON 파일 (union, 17). */
export const SYSTEM_JSON: ReadonlySet<string> = new Set([
  "variables.json", "session.json", "builder-session.json", "layout.json",
  "chat-history.json", "pending-events.json", "pending-actions.json",
  "package.json", "tsconfig.json", "voice.json", "chat-options.json",
  "comfyui-config.json", "character-tags.json", ".mcp.json", "style.json",
  "policy-context.json", "style-check.json",
]);

/** buildJsonLint 전용 스킵 (현행 9 — SYSTEM_JSON과 의도적으로 별개). */
export const LINT_SKIP_JSON: ReadonlySet<string> = new Set([
  "session.json", "builder-session.json", "layout.json", "chat-history.json",
  "pending-events.json", "pending-actions.json", "package.json",
  "tsconfig.json", "chat-options.json",
]);

// ── 순수 패치 의미론 ─────────────────────────────────────────
function isPlainObject(v: unknown): v is Dict {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge(target: Dict, source: Dict): Dict {
  const out: Dict = { ...target };
  for (const [k, v] of Object.entries(source)) {
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k] as Dict, v);
    else out[k] = v; // 배열·원시값·null → 교체
  }
  return out;
}

function unsetPath(obj: Dict, dotPath: string): void {
  const parts = dotPath.split(".");
  let cur: unknown = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isPlainObject(cur)) return;
    cur = (cur as Dict)[parts[i]];
  }
  if (isPlainObject(cur)) delete (cur as Dict)[parts[parts.length - 1]];
}

/**
 * shallow(기본) / $merge:'deep' / $unset(dot-path) 적용. 순수 함수.
 * 디렉티브 키($merge,$unset)는 결과에 영속되지 않는다.
 */
export function applyPatch(current: Dict, patch: Dict): Dict {
  const mode = patch.$merge === "deep" ? "deep" : "shallow";
  const unset = Array.isArray(patch.$unset) ? (patch.$unset as unknown[]) : [];

  const rest: Dict = {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === "$merge" || k === "$unset") continue;
    rest[k] = v;
  }

  let next: Dict = mode === "deep" ? deepMerge(current, rest) : { ...current, ...rest };
  if (unset.length) {
    next = structuredClone(next) as Dict;
    for (const p of unset) if (typeof p === "string" && p) unsetPath(next, p);
  }
  return next;
}

// ── 타입 ─────────────────────────────────────────────────────
export interface PatchResult {
  ok: boolean;
  value?: Dict;
  error?: unknown;
}

// ── 읽기 헬퍼 ────────────────────────────────────────────────
/** 단일 세션 JSON 관용 읽기(BOM strip). 없으면 null, parse 실패 시 throw. */
export function readSessionJson<T = Dict>(filePath: string): T | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  return JSON.parse(raw) as T;
}

/** variables.json + 비시스템 *.json 데이터 맵 로드(parse 관용). 동기. */
export function loadSessionData(sessionDir: string): { variables: Dict; data: Dict } {
  let variables: Dict = {};
  try {
    variables = (readSessionJson<Dict>(path.join(sessionDir, "variables.json")) as Dict) || {};
  } catch {
    variables = {};
  }
  const data: Dict = {};
  try {
    for (const f of fs.readdirSync(sessionDir)) {
      if (!f.endsWith(".json") || SYSTEM_JSON.has(f)) continue;
      try {
        const parsed = readSessionJson(path.join(sessionDir, f));
        if (parsed !== null) data[f.replace(/\.json$/, "")] = parsed;
      } catch { /* 파싱 불가 — 스킵 */ }
    }
  } catch { /* 디렉터리 읽기 오류 */ }
  return { variables, data };
}

// ── 경로 헬퍼 ────────────────────────────────────────────────
/** sessionDir + fileName → 절대경로. .json 부착, traversal 차단. 위반 시 null. */
export function resolveSessionFilePath(sessionDir: string, fileName: string): string | null {
  const name = fileName.endsWith(".json") ? fileName : `${fileName}.json`;
  if (name.includes("/") || name.includes("\\") || name.includes("..")) return null;
  return path.join(sessionDir, name);
}

// ── 원자적 쓰기 ──────────────────────────────────────────────
let tmpSeq = 0;

/** tmp+rename 원자적 쓰기(동기). 실패 시 tmp 정리 후 throw. */
function atomicWriteJsonSync(filePath: string, value: unknown): void {
  const tmp = `${filePath}.${process.pid}.${tmpSeq++}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/** read + transform 준비(읽기 관용·corrupt abort·transform throw 처리). */
function prepareMutation(
  filePath: string,
  transform: (current: Dict) => Dict,
): { ok: true; next: Dict } | { ok: false; error: unknown } {
  let current: Dict;
  try {
    const v = readSessionJson<Dict>(filePath);
    current = v === null ? {} : v;
  } catch (err) {
    console.error(`[session-state] read/parse failed (not overwriting) ${filePath}:`, err);
    return { ok: false, error: err };
  }
  try {
    return { ok: true, next: transform(current) };
  } catch (err) {
    console.error(`[session-state] transform threw ${filePath}:`, err);
    return { ok: false, error: err };
  }
}

/** 동기 원자적 read-modify-write. 훅 경로용(동기 완료 보장). */
export function mutateSessionJsonSync(
  filePath: string,
  transform: (current: Dict) => Dict,
): PatchResult {
  const p = prepareMutation(filePath, transform);
  if (!p.ok) return { ok: false, error: p.error };
  try {
    atomicWriteJsonSync(filePath, p.next);
  } catch (err) {
    console.error(`[session-state] write failed ${filePath}:`, err);
    return { ok: false, error: err };
  }
  return { ok: true, value: p.next };
}

/** 비동기 원자적 read-modify-write(Windows lock 재시도). 라우트 경로용. */
export async function mutateSessionJson(
  filePath: string,
  transform: (current: Dict) => Dict,
): Promise<PatchResult> {
  const p = prepareMutation(filePath, transform);
  if (!p.ok) return { ok: false, error: p.error };
  try {
    await retryOnWindowsLock(() => atomicWriteJsonSync(filePath, p.next));
  } catch (err) {
    console.error(`[session-state] write failed ${filePath}:`, err);
    return { ok: false, error: err };
  }
  return { ok: true, value: p.next };
}
