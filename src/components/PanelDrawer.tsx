"use client";

import { useEffect, useRef } from "react";
import PanelArea from "./PanelArea";

interface Panel {
  name: string;
  html: string;
}

interface PanelDrawerProps {
  open: boolean;
  onClose: () => void;
  panels: Panel[];
  panelPosition: "right" | "left" | "bottom" | "hidden";
  panelSize: number;
  profileImageUrl?: string | null;
  sessionId?: string;
  panelData?: Record<string, unknown>;
  onSendMessage?: (text: string) => void;
}

export default function PanelDrawer({
  open,
  onClose,
  panels,
  panelPosition,
  panelSize,
  profileImageUrl,
  sessionId,
  panelData,
  onSendMessage,
}: PanelDrawerProps) {
  const drawerRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 transition-opacity duration-300"
        style={{
          backgroundColor: "rgba(0,0,0,0.5)",
          opacity: open ? 1 : 0,
          pointerEvents: open ? "auto" : "none",
        }}
        onClick={onClose}
      />
      {/* Drawer */}
      <div
        ref={drawerRef}
        className="fixed top-0 right-0 bottom-0 z-50 transition-transform duration-300 ease-out"
        style={{
          width: `min(${panelSize + 40}px, 85vw)`,
          transform: open ? "translateX(0)" : "translateX(100%)",
        }}
      >
        <div className="h-full flex flex-col bg-surface border-l border-border">
          {/* Drawer header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
            <span className="text-xs font-semibold text-accent/80 uppercase tracking-wider">Info</span>
            <button
              onClick={onClose}
              className="w-7 h-7 flex items-center justify-center rounded-md text-text-dim hover:text-text hover:bg-surface-light transition-colors duration-150 text-sm"
            >
              ✕
            </button>
          </div>
          {/* Panel content */}
          <div className="flex-1 overflow-y-auto">
            <PanelArea
              panels={panels}
              position={panelPosition === "hidden" ? "right" : panelPosition}
              size={panelSize}
              profileImageUrl={profileImageUrl}
              sessionId={sessionId}
              panelData={panelData}
              onSendMessage={onSendMessage}
            />
          </div>
        </div>
      </div>
    </>
  );
}
