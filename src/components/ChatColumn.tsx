"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import PanelResizeHandle from "./PanelResizeHandle";
import { CHAT_RAIL_WIDTH, CHAT_WIDTH_MIN, chatWidthMax, clampChatWidth } from "@/lib/stage-layout";

/** 접힘 상태 기억 키 — 세션별 */
export function stageChatCollapsedStorageKey(sessionId: string): string {
  return `stageChatCollapsed:${sessionId}`;
}

export interface ChatColumnState {
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  /** 표시 폭(px) — 접힘이면 CHAT_RAIL_WIDTH */
  width: number;
  /** 펼친 상태의 폭(px) — 저장값/드래그 값을 화면에 맞게 clamp한 결과 */
  expandedWidth: number;
  /** 리사이즈 상한(px) — 무대가 STAGE_MIN_WIDTH 이상 남도록 */
  maxWidth: number;
  /** 현재 창 폭(px) — 무대가 켜져 있을 때만 갱신된다. 사이드바 표시 폭 맞춤(fitStageSides)에 쓴다 */
  viewportWidth: number;
  onResize: (size: number) => void;
  onResizeEnd: (size: number) => void;
}

/**
 * 무대 레이아웃 우측 채팅 컬럼의 폭·접힘 상태 (spec §5.1·§5.2).
 * - 폭: 드래그 중 로컬 override → 종료 시 `PATCH layout { chat: { width } }` → 서버 watch가
 *   `layout:update`로 돌려주면 override 해제 (사이드바 리사이즈와 같은 왕복).
 * - 접힘: `localStorage["stageChatCollapsed:" + sessionId]`.
 * - 창 폭은 `enabled`일 때만 구독한다 — 무대가 없는 세션에서 resize마다 페이지를 다시 그리지 않도록.
 */
export function useChatColumnState(opts: {
  sessionId: string;
  enabled: boolean;
  /** layout.json의 chat.width */
  layoutWidth: number | undefined;
  /** 표시 중인 좌·우 사이드바 폭 합 */
  occupiedSides: number;
}): ChatColumnState {
  const { sessionId, enabled, layoutWidth, occupiedSides } = opts;
  const storageKey = sessionId ? stageChatCollapsedStorageKey(sessionId) : "";

  const [collapsed, setCollapsedState] = useState(false);
  useEffect(() => {
    if (!storageKey) return;
    try {
      setCollapsedState(window.localStorage.getItem(storageKey) === "1");
    } catch { /* localStorage 접근 불가 환경 무시 */ }
  }, [storageKey]);
  const setCollapsed = useCallback((next: boolean) => {
    setCollapsedState(next);
    if (!storageKey) return;
    try {
      if (next) window.localStorage.setItem(storageKey, "1");
      else window.localStorage.removeItem(storageKey);
    } catch { /* 무시 */ }
  }, [storageKey]);

  const [viewportWidth, setViewportWidth] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const update = () => setViewportWidth(window.innerWidth);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [enabled]);
  // 무대가 막 켜진 첫 렌더에는 아직 구독 전이라 0 — 그 한 프레임도 실제 창 폭으로 계산한다.
  const effectiveViewport = viewportWidth > 0
    ? viewportWidth
    : (typeof window !== "undefined" ? window.innerWidth : 0);

  const [override, setOverride] = useState<number | null>(null);
  // 서버에서 새 값이 돌아오면 드래그 override를 해제한다
  useEffect(() => { setOverride(null); }, [layoutWidth]);

  const onResizeEnd = useCallback((size: number) => {
    const width = Math.round(size);
    setOverride(width);
    fetch(`/api/sessions/${sessionId}/layout`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat: { width } }),
    }).catch(() => {});
  }, [sessionId]);

  const maxWidth = chatWidthMax(effectiveViewport, occupiedSides);
  const expandedWidth = clampChatWidth(override ?? layoutWidth, effectiveViewport, occupiedSides);
  return {
    collapsed,
    setCollapsed,
    width: collapsed ? CHAT_RAIL_WIDTH : expandedWidth,
    expandedWidth,
    maxWidth,
    viewportWidth: effectiveViewport,
    onResize: setOverride,
    onResizeEnd,
  };
}

interface ChatColumnProps {
  /** "column" = 데스크톱 우측 컬럼(폭·접기·리사이즈). "fill" = 모바일 전체 화면(무대 뷰와 토글). */
  variant: "column" | "fill";
  state: ChatColumnState;
  /** AI 응답 중 — 접힌 레일에 펄스 점을 띄운다 */
  streaming: boolean;
  /** fill 모드에서 비활성 뷰일 때 true — 마운트는 유지하고 숨긴다 */
  hidden?: boolean;
  /** 기존 채팅 컬럼 JSX (메시지 · dock-bottom · 입력창) */
  children: ReactNode;
}

/**
 * 무대 레이아웃의 채팅 컬럼 (spec §5.2). 두 variant 모두 같은 트리 모양을 유지해
 * 데스크톱↔모바일 전환 때 채팅 내용(입력 중 텍스트·스크롤)이 다시 마운트되지 않게 한다.
 * 접혀도 채팅 내용은 display:none으로 숨길 뿐 언마운트하지 않는다.
 */
export default function ChatColumn({ variant, state, streaming, hidden, children }: ChatColumnProps) {
  const isColumn = variant === "column";
  const collapsed = isColumn && state.collapsed;
  const { setCollapsed, width } = state;

  // 겹침 요소(토스트·최소화 모달)가 입력창을 가리지 않도록 컬럼 폭을 CSS 변수로 알린다 (spec §5.5).
  // 컬럼이 사라지면(무대 해제·모바일·페이지 이탈) 정리 함수가 변수를 지운다.
  useEffect(() => {
    if (!isColumn) return;
    const root = document.documentElement.style;
    root.setProperty("--stage-right-inset", `${width}px`);
    return () => { root.removeProperty("--stage-right-inset"); };
  }, [isColumn, width]);

  // 패널이 입력창을 채우면(fillInput) 접힌 컬럼을 펼쳐 사용자가 입력창을 보게 한다.
  useEffect(() => {
    if (!collapsed) return;
    const handler = () => setCollapsed(false);
    window.addEventListener("__panel_fill_input", handler);
    return () => window.removeEventListener("__panel_fill_input", handler);
  }, [collapsed, setCollapsed]);

  return (
    <div
      className={isColumn ? "absolute top-0 bottom-0 right-0 border-l border-border" : "absolute inset-0"}
      style={isColumn ? { width: `${width}px` } : hidden ? { display: "none" } : undefined}
    >
      <div className="absolute inset-0" style={collapsed ? { display: "none" } : undefined}>
        {children}
      </div>
      {isColumn && !collapsed && (
        <PanelResizeHandle
          side="right"
          placement="inside"
          minSize={CHAT_WIDTH_MIN}
          maxSize={state.maxWidth}
          onResize={state.onResize}
          onResizeEnd={state.onResizeEnd}
        />
      )}
      {isColumn && !collapsed && (
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          aria-label="채팅 접기"
          aria-expanded
          title="채팅 접기"
          className="absolute left-0 top-3 z-30 flex h-6 w-6 -translate-x-1/2 cursor-pointer items-center justify-center rounded-full
            border border-border bg-surface text-text-dim backdrop-blur-[16px] transition-colors duration-fast
            hover:border-accent hover:text-accent focus-visible:border-accent focus-visible:text-accent focus-visible:outline-none"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3" aria-hidden>
            <polyline points="6,3 11,8 6,13" />
          </svg>
        </button>
      )}
      {collapsed && (
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-label={streaming ? "채팅 펼치기 (응답 중)" : "채팅 펼치기"}
          aria-expanded={false}
          title="채팅 펼치기"
          className="group flex h-full w-full cursor-pointer flex-col items-center gap-3 bg-surface pt-3 text-text-dim backdrop-blur-[16px]
            transition-colors duration-fast hover:bg-surface-light hover:text-text focus-visible:bg-surface-light focus-visible:text-text focus-visible:outline-none"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-border/60 transition-colors duration-fast group-hover:border-accent group-hover:text-accent">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3" aria-hidden>
              <polyline points="10,3 5,8 10,13" />
            </svg>
          </span>
          <span className="text-[12px] tracking-[0.2em] [writing-mode:vertical-rl]" aria-hidden>채팅</span>
          {streaming && (
            <span className="relative flex h-2 w-2" aria-hidden>
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60 motion-reduce:animate-none" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
            </span>
          )}
        </button>
      )}
    </div>
  );
}
