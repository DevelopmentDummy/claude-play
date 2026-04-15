"use client";

import { useCallback, useRef, useEffect, useState } from "react";

interface PanelResizeHandleProps {
  side: "left" | "right";
  onResize: (newSize: number) => void;
  onResizeEnd: (newSize: number) => void;
  minSize?: number;
  maxSize?: number;
}

export default function PanelResizeHandle({
  side,
  onResize,
  onResizeEnd,
  minSize = 180,
  maxSize = 900,
}: PanelResizeHandleProps) {
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startSize: number } | null>(null);
  const currentSize = useRef(0);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      // Parent wrapper div has the panel width set via inline style
      const handle = e.currentTarget as HTMLElement;
      const wrapper = handle.parentElement;
      const panelWidth = wrapper ? wrapper.offsetWidth : 280;

      dragRef.current = { startX: e.clientX, startSize: panelWidth };
      currentSize.current = panelWidth;
      setDragging(true);
    },
    [side]
  );

  useEffect(() => {
    if (!dragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const dx = e.clientX - dragRef.current.startX;
      // Left panel: drag right = bigger; Right panel: drag left = bigger
      const raw =
        side === "left"
          ? dragRef.current.startSize + dx
          : dragRef.current.startSize - dx;
      const clamped = Math.max(minSize, Math.min(maxSize, raw));
      currentSize.current = clamped;
      onResize(clamped);
    };

    const handleMouseUp = () => {
      setDragging(false);
      onResizeEnd(currentSize.current);
      dragRef.current = null;
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    // Prevent text selection during drag
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [dragging, side, minSize, maxSize, onResize, onResizeEnd]);

  return (
    <div
      onMouseDown={handleMouseDown}
      className={`absolute top-0 bottom-0 z-20 w-[6px] cursor-col-resize group
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
