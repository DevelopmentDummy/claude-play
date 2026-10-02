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
  /**
   * 세로 스트립 위치. "edge"(기본) = 박스 경계에 걸쳐 바깥쪽 이웃 위로 반쯤 나간다(기존 동작).
   * "inside" = 박스 안쪽 가장자리에 붙는다 — 이웃 영역의 스크롤바를 가리면 안 될 때(무대 옆 채팅 컬럼).
   */
  placement?: "edge" | "inside";
}

export default function PanelResizeHandle({
  side,
  onResize,
  onResizeEnd,
  minSize = 180,
  maxSize = 900,
  onResetDefault,
  placement = "edge",
}: PanelResizeHandleProps) {
  const vertical = side === "top";
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ start: number; startSize: number } | null>(null);
  const currentSize = useRef(0);
  // 포인터가 실제로 움직였는지 — 클릭만 하고 놓으면 onResizeEnd(저장)를 부르지 않는다.
  // (표시 폭이 창에 맞게 줄어 있는 상태에서 클릭만으로 저장값이 덮어써지는 것을 막는다)
  const movedRef = useRef(false);
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

      movedRef.current = false;
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
      if (delta !== 0) movedRef.current = true;
      currentSize.current = clamped;
      onResize(clamped);
    };

    const handlePointerUp = () => {
      setDragging(false);
      if (movedRef.current) onResizeEnd(currentSize.current);
      movedRef.current = false;
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
        ${placement === "inside" ? (side === "left" ? "right-0" : "left-0") : side === "left" ? "left-full" : "right-full"}
      `}
      style={placement === "inside" ? undefined : { transform: "translateX(-50%)" }}
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
