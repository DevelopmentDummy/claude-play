import * as fs from "fs";
import * as path from "path";
import { AIProvider, providerFromModel, parseModelEffort } from "./ai-provider";

/** 스레드 주기 하한. 저자가 실수로 100ms를 적는 것을 막는다. */
export const MIN_INTERVAL_MS = 5_000;
/** 루프 스레드의 기본 주기. */
export const DEFAULT_INTERVAL_MS = 8_000;
/** 컨텍스트 리셋 전까지의 기본 턴 수. */
export const DEFAULT_RESET_TURNS = 40;
/** 세션당 스레드 상한. 기존 SUBAGENT_MAX(6)를 대체한다. */
export const THREAD_MAX = Number(process.env.THREAD_MAX) > 0 ? Number(process.env.THREAD_MAX) : 12;

/** threadId는 dot을 허용하지 않는다 — $unset dot-path 드레인과 충돌하기 때문 (spec §5.6). */
export const THREAD_ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const ROLE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export type LoopMode = "loop" | "onAssistantTurn" | "none";

export interface LoopConfig {
  mode: LoopMode;
  intervalMs: number;
  resetEveryTurns: number;
  /** true면 컨텍스트 리셋 시 대화 요약 턴을 돌린다. 기본 false = 상태 기반 재prime. */
  summarizeOnReset: boolean;
}

export interface RoleDef {
  name: string;
  /** 지침 파일 경로. v2는 세션 디렉토리 기준, v1 승격분은 subagents/{name}/ 기준. */
  instructions: string;
  /** true면 instructions가 세션 디렉토리 기준 경로다. */
  instructionsFromSessionRoot: boolean;
  provider?: AIProvider;
  model?: string;
  effort?: string;
  /** 엔진이 해석하는 가시 범위 태그. 플랫폼은 전달만 한다. */
  scope?: string;
  loop: LoopConfig;
  emitSummary: boolean;
  delegable: boolean;
  /** 사람이 읽는 역할 설명. v1의 role 필드를 그대로 받는다. */
  description: string;
  /** v1 autoTrigger의 기본 태스크 (하위호환). */
  autoTriggerTask?: string;
}

export interface ThreadDef {
  threadId: string;
  role: string;
  params: Record<string, unknown>;
}

export interface ThreadManifest {
  version: number;
  roles: Map<string, RoleDef>;
  threads: ThreadDef[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseLoop(raw: unknown, fallbackMode: LoopMode): LoopConfig {
  const o = isObject(raw) ? raw : {};
  const mode: LoopMode =
    o.mode === "loop" || o.mode === "onAssistantTurn" || o.mode === "none" ? o.mode : fallbackMode;
  const rawInterval = typeof o.intervalMs === "number" && Number.isFinite(o.intervalMs)
    ? o.intervalMs : DEFAULT_INTERVAL_MS;
  const rawReset = typeof o.resetEveryTurns === "number" && Number.isFinite(o.resetEveryTurns) && o.resetEveryTurns > 0
    ? Math.floor(o.resetEveryTurns) : DEFAULT_RESET_TURNS;
  return {
    mode,
    intervalMs: Math.max(MIN_INTERVAL_MS, Math.floor(rawInterval)),
    resetEveryTurns: rawReset,
    summarizeOnReset: o.summarizeOnReset === true,
  };
}

/** model 문자열에서 provider/effort를 도출한다. 실패하면 pin 전체를 버려 세션 런타임을 따르게 한다
 *  (기존 subagent-manifest v2.1의 폴백 규칙과 동일). */
function resolveRuntime(
  raw: Record<string, unknown>,
  roleName: string,
): Pick<RoleDef, "provider" | "model" | "effort"> {
  const rawModel = typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : undefined;
  const explicitProvider = typeof raw.provider === "string" && raw.provider.trim()
    ? (raw.provider.trim() as AIProvider) : undefined;
  const explicitEffort = typeof raw.effort === "string" && raw.effort.trim() ? raw.effort.trim() : undefined;

  if (!rawModel) return { provider: explicitProvider, model: undefined, effort: explicitEffort };

  const parsed = parseModelEffort(rawModel);
  let provider = explicitProvider;
  if (!provider) {
    try {
      provider = providerFromModel(rawModel);
    } catch {
      console.warn(`[thread-manifest] role "${roleName}": provider 도출 실패 (model="${rawModel}") — 세션 런타임을 따른다`);
      return { provider: undefined, model: undefined, effort: explicitEffort };
    }
  }
  return { provider, model: parsed.model || undefined, effort: explicitEffort ?? parsed.effort };
}

function parseRole(raw: unknown, i: number, fromV1: boolean): RoleDef {
  if (!isObject(raw)) throw new Error(`roles[${i}]: must be an object`);
  const name = String(raw.name ?? "");
  if (!ROLE_NAME_RE.test(name)) throw new Error(`roles[${i}]: invalid name "${name}"`);
  const instructions = typeof raw.instructions === "string" && raw.instructions.trim()
    ? raw.instructions.trim() : "instructions.md";
  if (instructions.includes("..")) throw new Error(`roles[${i}]: instructions must not traverse`);

  const fallbackMode: LoopMode = fromV1
    ? (raw.autoTrigger === "onAssistantTurn" ? "onAssistantTurn" : "none")
    : "none";

  return {
    name,
    instructions,
    instructionsFromSessionRoot: !fromV1,
    ...resolveRuntime(raw, name),
    scope: typeof raw.scope === "string" ? raw.scope : undefined,
    loop: parseLoop(raw.loop, fallbackMode),
    emitSummary: raw.emitSummary !== false,
    delegable: raw.delegable !== false,
    description: typeof raw.role === "string" && raw.role.trim() ? raw.role.trim() : name,
    autoTriggerTask: typeof raw.autoTriggerTask === "string" ? raw.autoTriggerTask : undefined,
  };
}

/** subagents.json(raw)을 v2 형태로 파싱한다. v1 `subagents[]`는 스레드 하나짜리 역할로 승격. */
export function parseThreadManifest(raw: unknown): ThreadManifest {
  if (!isObject(raw)) throw new Error("subagents.json: root must be an object");

  const roles = new Map<string, RoleDef>();
  const threads: ThreadDef[] = [];

  // v1 경로: subagents[] → 역할 1 + 스레드 1
  const v1 = Array.isArray(raw.subagents) ? raw.subagents : null;
  if (v1) {
    v1.forEach((entry, i) => {
      const role = parseRole(entry, i, true);
      if (roles.has(role.name)) throw new Error(`subagents[${i}]: duplicate name "${role.name}"`);
      roles.set(role.name, role);
      threads.push({ threadId: role.name, role: role.name, params: {} });
    });
  }

  // v2 경로: roles[] + threads[]
  const v2Roles = Array.isArray(raw.roles) ? raw.roles : [];
  v2Roles.forEach((entry, i) => {
    const role = parseRole(entry, i, false);
    if (roles.has(role.name)) throw new Error(`roles[${i}]: duplicate name "${role.name}"`);
    roles.set(role.name, role);
  });

  const v2Threads = Array.isArray(raw.threads) ? raw.threads : [];
  const seen = new Set<string>(threads.map((t) => t.threadId));
  v2Threads.forEach((entry, i) => {
    if (!isObject(entry)) throw new Error(`threads[${i}]: must be an object`);
    const threadId = String(entry.threadId ?? "");
    if (!THREAD_ID_RE.test(threadId)) throw new Error(`threads[${i}]: invalid threadId "${threadId}"`);
    if (seen.has(threadId)) throw new Error(`threads[${i}]: duplicate threadId "${threadId}"`);
    const role = String(entry.role ?? "");
    if (!roles.has(role)) throw new Error(`threads[${i}]: unknown role "${role}"`);
    seen.add(threadId);
    threads.push({ threadId, role, params: isObject(entry.params) ? entry.params : {} });
  });

  if (threads.length > THREAD_MAX) {
    throw new Error(`subagents.json: too many threads (${threads.length} > cap ${THREAD_MAX})`);
  }

  return { version: Array.isArray(raw.roles) ? 2 : 1, roles, threads };
}

/** 디렉토리에서 subagents.json을 읽어 파싱한다. 없으면 빈 매니페스트. */
export function loadThreadManifest(dir: string): ThreadManifest {
  const fp = path.join(dir, "subagents.json");
  if (!fs.existsSync(fp)) return { version: 2, roles: new Map(), threads: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(fp, "utf-8"));
  } catch (err) {
    throw new Error(`subagents.json parse error: ${(err as Error).message}`);
  }
  return parseThreadManifest(raw);
}
