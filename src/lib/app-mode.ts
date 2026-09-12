/** layout.json의 앱 모드 설정. `app`이 없으면 세션은 기존(채팅 중심) 셸로 동작한다. */
export interface AppModeConfig {
  /** 세션 디렉토리 기준 앱 진입 HTML 경로 */
  entry: string;
  /** tools/{engine}.js — 월드 엔진 모듈 이름 */
  engine: string;
  /** 세션 디렉토리 직하의 월드 상태 파일명 */
  worldFile: string;
  /** 월드 시계 간격(ms). AI 턴과 무관하게 이 주기로 step()이 돈다. */
  worldTickMs: number;
  chatMode: ChatMode;
}

export type ChatMode = "normal" | "dock" | "hidden";

const CHAT_MODES = new Set<string>(["normal", "dock", "hidden"]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 경로 구분자·traversal을 포함하면 안 되는 단일 세그먼트 이름인지. */
function isSafeSegment(name: string): boolean {
  return name.length > 0 && !name.includes("/") && !name.includes("\\") && !name.includes("..");
}

/**
 * layout.json에서 앱 모드 설정을 해석한다. 설정이 없거나 유효하지 않으면 null —
 * 호출부는 null을 "기존 셸"로 취급하므로 기존 페르소나는 이 경로를 전혀 타지 않는다.
 */
export function resolveAppMode(layout: unknown): AppModeConfig | null {
  if (!isObject(layout) || !isObject(layout.app)) return null;
  const app = layout.app;

  const entry = typeof app.entry === "string" ? app.entry.trim() : "";
  if (!entry || entry.includes("..") || entry.startsWith("/") || entry.startsWith("\\")) return null;

  const engine = typeof app.engine === "string" && app.engine.trim() ? app.engine.trim() : "world";
  if (!isSafeSegment(engine)) return null;

  let worldFile = typeof app.worldFile === "string" && app.worldFile.trim() ? app.worldFile.trim() : "world.json";
  if (!worldFile.endsWith(".json")) worldFile = `${worldFile}.json`;
  if (!isSafeSegment(worldFile)) return null;

  // 월드 시계. 100ms 하한 — 엔진 호출이 tool 라우트를 타므로 그보다 촘촘하면 의미가 없다.
  const rawTick = typeof app.worldTickMs === "number" && Number.isFinite(app.worldTickMs)
    ? app.worldTickMs : 1000;
  const worldTickMs = Math.max(100, Math.floor(rawTick));

  const rawMode = isObject(layout.chat) && typeof layout.chat.mode === "string" ? layout.chat.mode : "normal";
  const chatMode = (CHAT_MODES.has(rawMode) ? rawMode : "normal") as ChatMode;

  return { entry, engine, worldFile, worldTickMs, chatMode };
}
