"use client";

import { useCallback, useRef, useEffect, useState } from "react";

interface PanelResizeHandleProps {
  /** left/right = 세로 스트립(가로 크기 조절), top = 가로 스트립(아래쪽 영역의 높이 조절) */
  side: "left" | "right" | "top";
  onResize: (newSize: number) => void;
  onResizeEnd: (newSize: number) => void;
  minSize?: number;
  maxSize?: number;
  /** top 모드에서 핸들 더블클릭 시 기본 크기로 되돌리는 콜백 */
  onResetDefault?: () => void;
}

export default function PanelResizeHandle({
  side,
  onResize,
  onResizeEnd,
  minSize = 180,
  maxSize = 900,
  onResetDefault,
}: PanelResizeHandleProps) {
  const vertical = side === "top";
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ start: number; startSize: number } | null>(null);
  const currentSize = useRef(0);
  // top 모드는 부모 컨테이너 높이에 맞춰 최대치를 동적으로 잡는다 (앱 영역이 최소 120px는 남도록)
  const maxRef = useRef(maxSize);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const handle = e.currentTarget as HTMLElement;
      const wrapper = handle.parentElement;

      if (vertical) {
        const h = wrapper ? wrapper.offsetHeight : 260;
        const container = wrapper?.parentElement;
        maxRef.current = container
          ? Math.max(minSize, container.offsetHeight - 120)
          : maxSize;
        dragRef.current = { start: e.clientY, startSize: h };
        currentSize.current = h;
      } else {
        const w = wrapper ? wrapper.offsetWidth : 280;
        maxRef.current = maxSize;
        dragRef.current = { start: e.clientX, startSize: w };
        currentSize.current = w;
      }

      // Keep move/up events firing even if the pointer leaves the 6px strip
      e.currentTarget.setPointerCapture(e.pointerId);
      setDragging(true);
    },
    [vertical, minSize, maxSize]
  );

  useEffect(() => {
    if (!dragging) return;

    const handlePointerMove = (e: PointerEvent) => {
      if (!dragRef.current) return;
      // Left panel: drag right = bigger; Right panel: drag left = bigger; Top handle: drag up = bigger
      const delta = vertical
        ? e.clientY - dragRef.current.start
        : e.clientX - dragRef.current.start;
      const raw =
        side === "left"
          ? dragRef.current.startSize + delta
          : dragRef.current.startSize - delta;
      const clamped = Math.max(minSize, Math.min(maxRef.current, raw));
      currentSize.current = clamped;
      onResize(clamped);
    };

    const handlePointerUp = () => {
      setDragging(false);
      onResizeEnd(currentSize.current);
      dragRef.current = null;
    };

    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", handlePointerUp);
    document.addEventListener("pointercancel", handlePointerUp);
    // Prevent text selection during drag
    document.body.style.userSelect = "none";
    document.body.style.cursor = vertical ? "row-resize" : "col-resize";
    document.body.style.touchAction = "none";

    return () => {
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", handlePointerUp);
      document.removeEventListener("pointercancel", handlePointerUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      document.body.style.touchAction = "";
    };
  }, [dragging, side, vertical, minSize, onResize, onResizeEnd]);

  if (vertical) {
    return (
      <div
        onPointerDown={handlePointerDown}
        onDoubleClick={onResetDefault}
        className="absolute left-0 right-0 top-0 z-20 h-[14px] cursor-row-resize group touch-none flex items-center justify-center"
        role="separator"
        aria-orientation="horizontal"
        aria-label="채팅 영역 높이 조절 (더블클릭: 기본 크기)"
        title="드래그해서 채팅 영역 높이 조절 · 더블클릭하면 기본 크기"
      >
        {/* 전체 폭 라인 — 호버/드래그 시에만 */}
        <div
          className={`absolute inset-x-0 top-1/2 -translate-y-1/2 h-[3px] transition-opacity duration-150
            ${dragging ? "opacity-100 bg-accent" : "opacity-0 group-hover:opacity-50 bg-accent"}
          `}
        />
        {/* 그립 — 항상 보인다 */}
        <div
          className={`relative flex gap-[3px] px-3 py-[3px] rounded-full border transition-colors duration-150
            ${dragging
              ? "bg-accent border-accent"
              : "bg-surface border-border group-hover:border-accent"}
          `}
        >
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className={`block w-[3px] h-[3px] rounded-full ${dragging ? "bg-bg" : "bg-text-dim group-hover:bg-accent"}`}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      onPointerDown={handlePointerDown}
      className={`absolute top-0 bottom-0 z-20 w-[6px] cursor-col-resize group touch-none
        ${side === "left" ? "left-full" : "right-full"}
      `}
      style={{ transform: "translateX(-50%)" }}
    >
      {/* Visible indicator on hover / drag */}
      <div
        className={`absolute inset-y-0 left-1/2 -translate-x-1/2 w-[3px] rounded-full transition-opacity duration-150
          ${dragging ? "opacity-100 bg-accent" : "opacity-0 group-hover:opacity-60 bg-text-dim"}
        `}
      />
    </div>
  );
}
