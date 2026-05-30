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
