/**
 * 무대 레이아웃(Stage Layout) 판정·치수 계산 — 순수 함수만 둔다 (spec 2026-10-02 §4).
 *
 * `panels.placement`에 `"main"`이 하나라도 있으면 세션 화면이
 * `[좌측 사이드바] [중앙 무대(main 패널 탭)] [우측 채팅 컬럼]`으로 바뀐다.
 * main이 없으면 `resolveStage()`가 inactive를 돌려주므로 기존 레이아웃 경로가 그대로 유지된다.
 */

export const CHAT_WIDTH_DEFAULT = 420;
export const CHAT_WIDTH_MIN = 320;
export const STAGE_MIN_WIDTH = 480;
export const CHAT_RAIL_WIDTH = 44;

/** placement 키에서 숫자 prefix 제거 ("01-원고" → "원고") — page.tsx 정규화와 동일 규칙 */
export function normalizePanelKey(key: string): string {
  return key.replace(/^\d+-/, "");
}

/** 무대 레이아웃 판정. appModeActive면 항상 inactive. */
export function resolveStage(input: {
  panelNames: string[];
  placement: Record<string, string>;
  appModeActive: boolean;
}): { active: boolean; mainPanelNames: string[] } {
  if (input.appModeActive) return { active: false, mainPanelNames: [] };
  const mainPanelNames = input.panelNames.filter(
    (name) => (input.placement[name] ?? input.placement[normalizePanelKey(name)]) === "main",
  );
  return { active: mainPanelNames.length > 0, mainPanelNames };
}

/** 채팅 폭 상한 — 남는 무대 폭이 STAGE_MIN_WIDTH 이상이 되도록. 최소 CHAT_WIDTH_MIN. */
export function chatWidthMax(viewportWidth: number, occupiedSides: number): number {
  const room = Math.floor(viewportWidth - occupiedSides - STAGE_MIN_WIDTH);
  return Math.max(CHAT_WIDTH_MIN, Number.isFinite(room) ? room : CHAT_WIDTH_MIN);
}

/** 채팅 폭 범위 제한. 남는 무대 폭이 STAGE_MIN_WIDTH 이상이 되도록 상한을 잡는다. */
export function clampChatWidth(
  requested: number | undefined | null,
  viewportWidth: number,
  occupiedSides: number,
): number {
  const base = typeof requested === "number" && Number.isFinite(requested) ? requested : CHAT_WIDTH_DEFAULT;
  const max = chatWidthMax(viewportWidth, occupiedSides);
  return Math.round(Math.min(max, Math.max(CHAT_WIDTH_MIN, base)));
}

/** 무대를 살리려고 사이드바를 줄일 때의 하한(px) — 원래 폭이 이보다 작으면 원래 폭 */
export const SIDEBAR_FIT_MIN = 200;

/**
 * 무대 데스크톱에서 좌·우 사이드바의 **표시** 폭을 창에 맞춘다 (저장값은 건드리지 않는다).
 * 채팅 폭은 이미 정해졌다고 보고(clampChatWidth가 먼저 CHAT_WIDTH_MIN까지 양보한다),
 * 무대가 STAGE_MIN_WIDTH 이상 남도록 두 사이드바를 같은 비율로 줄이되 각자 SIDEBAR_FIT_MIN 아래로는 줄이지 않는다.
 * 그래도 모자랄 만큼 창이 좁으면 무대 폭이 음수가 되어 사이드바가 겹치지 않도록 남은 폭까지 비율대로 줄인다.
 */
export function fitStageSides(
  viewportWidth: number,
  left: number,
  right: number,
  chatWidth: number,
): { left: number; right: number } {
  const L = Number.isFinite(left) ? Math.max(0, left) : 0;
  const R = Number.isFinite(right) ? Math.max(0, right) : 0;
  const total = L + R;
  if (total === 0 || !Number.isFinite(viewportWidth) || viewportWidth <= 0) return { left: L, right: R };
  const budget = viewportWidth - Math.max(0, chatWidth) - STAGE_MIN_WIDTH;
  if (total <= budget) return { left: L, right: R };
  // 1단계: 하한까지 같은 비율로 줄인다
  const floorL = Math.min(L, SIDEBAR_FIT_MIN);
  const floorR = Math.min(R, SIDEBAR_FIT_MIN);
  const k = Math.max(budget, floorL + floorR) / total;
  let nl = Math.max(floorL, L * k);
  let nr = Math.max(floorR, R * k);
  // 2단계: 그래도 채팅 컬럼까지 침범하면 남은 폭 안으로 비율 축소 (무대 폭 ≥ 0, 겹침 없음)
  const hardMax = Math.max(0, viewportWidth - Math.max(0, chatWidth));
  if (nl + nr > hardMax) {
    const k2 = hardMax / (nl + nr);
    nl *= k2;
    nr *= k2;
  }
  return { left: Math.floor(nl), right: Math.floor(nr) };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function lookupPlacement(map: unknown, panelName: string): string | undefined {
  if (!isRecord(map)) return undefined;
  const target = normalizePanelKey(panelName);
  const direct = map[panelName];
  if (typeof direct === "string") return direct;
  for (const [key, val] of Object.entries(map)) {
    if (typeof val === "string" && normalizePanelKey(key) === target) return val;
  }
  return undefined;
}

/**
 * layout.json 원본에서 패널의 placement를 찾는다 (spec §8).
 * `panels.placement`가 정식 위치이고, 구형 최상위 `placement`는 폴백이다. 키의 숫자 prefix는 무시한다.
 */
export function resolvePanelPlacement(layout: unknown, panelName: string): string | undefined {
  if (!isRecord(layout) || !panelName) return undefined;
  const panels = layout.panels;
  return lookupPlacement(isRecord(panels) ? panels.placement : undefined, panelName)
    ?? lookupPlacement(layout.placement, panelName);
}

/** 화면에 상주하는 배치(사이드바·무대) — 모달 열기 대상이 아니다. */
export function isResidentPlacement(placement: string | undefined): boolean {
  return placement === "left" || placement === "right" || placement === "main";
}

/** `__panelBridge.focusPanel(name)`이 무엇을 할지 — 탭 전환·모달 열기·무시 */
export type FocusTarget =
  | { kind: "tab"; name: string }
  | { kind: "modal"; name: string }
  | null;

/**
 * focusPanel 대상 해석. 패널 이름은 숫자 prefix를 무시하고 비교한다.
 * main 패널이면 탭, modal/modal-dismissible/full-screen 배치면 모달, 그 외(사이드바·독·인라인)는 무시.
 */
export function resolveFocusTarget(
  requested: string,
  panelNames: string[],
  placement: Record<string, string>,
  mainPanelNames: string[],
): FocusTarget {
  if (!requested) return null;
  const key = normalizePanelKey(requested);
  const name = panelNames.find((n) => n === requested) ?? panelNames.find((n) => normalizePanelKey(n) === key);
  if (!name) return null;
  if (mainPanelNames.includes(name)) return { kind: "tab", name };
  const p = placement[name] ?? placement[normalizePanelKey(name)];
  if (p === "modal" || p === "modal-dismissible" || p === "full-screen") return { kind: "modal", name };
  return null;
}
