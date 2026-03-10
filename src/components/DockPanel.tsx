"use client";

import { useRef, useEffect, useState } from "react";
import ImageModal from "./ImageModal";
import { installImagePolling } from "@/lib/panel-image-polling";

export interface DockPanelEntry {
  name: string;
  html: string;
  dismissible: boolean;
}

interface DockPanelProps {
  panels: DockPanelEntry[];
  direction?: "bottom" | "left" | "right";
  maxSize?: number;
  sessionId?: string;
  panelData?: Record<string, unknown>;
  onClose: (name: string) => void;
  floating?: boolean;
}

export default function DockPanel({
  panels,
  direction = "bottom",
  maxSize,
  sessionId,
  panelData,
  onClose,
  floating,
}: DockPanelProps) {
  const [activeTab, setActiveTab] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<ShadowRoot | null>(null);
  const [modalSrc, setModalSrc] = useState<string | null>(null);

  // Clamp activeTab if panels shrink
  useEffect(() => {
    if (activeTab >= panels.length && panels.length > 0) {
      setActiveTab(panels.length - 1);
    }
  }, [panels.length, activeTab]);

  const current = panels[activeTab] || panels[0];

  // Install bridge (same as PanelSlot/ModalPanel)
  useEffect(() => {
    if (!current) return;
    const bridge = {
      sendMessage(text: string) {
        window.dispatchEvent(new CustomEvent("__panel_send_message", { detail: text }));
      },
      fillInput(text: string) {
        window.dispatchEvent(new CustomEvent("__panel_fill_input", { detail: text }));
      },
      async updateVariables(patch: Record<string, unknown>) {
        if (!sessionId) return;
        const res = await fetch(`/api/sessions/${sessionId}/variables`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        return res.json();
      },
      sessionId,
      data: panelData || {},
    };
    (window as unknown as Record<string, unknown>).__panelBridge = bridge;
  }, [sessionId, panelData, current]);

  // Attach shadow DOM (once)
  useEffect(() => {
    if (containerRef.current && !shadowRef.current) {
      shadowRef.current = containerRef.current.attachShadow({ mode: "open" });
      shadowRef.current.addEventListener("click", (e: Event) => {
        const target = e.target as HTMLElement;
        if (target.tagName === "IMG") {
          const src = (target as HTMLImageElement).src;
          if (src) { e.preventDefault(); setModalSrc(src); }
          return;
        }
        const anchor = target.closest("a");
        if (anchor) {
          const href = anchor.getAttribute("href") || "";
          if (/\.(png|jpe?g|webp|gif|bmp|svg)(\?|$)/i.test(href)) {
            e.preventDefault();
            setModalSrc(anchor.href);
          }
        }
      });
    }
  }, []);

  // Re-render shadow content when active panel changes
  useEffect(() => {
    const shadow = shadowRef.current;
    if (!shadow || !current) return;
    shadow.innerHTML =
      `<style>:host{display:block;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px;line-height:1.6;color:#e0e0e0;}img{cursor:zoom-in;}</style>` +
      current.html;

    installImagePolling(shadow);

    const scripts = Array.from(shadow.querySelectorAll("script"));
    for (const oldScript of scripts) {
      oldScript.remove();
      try {
        let code = oldScript.textContent || "";
        code = code.replace(/document\.currentScript\.getRootNode\(\)/g, "shadow");
        const fn = new Function("shadow", code);
        fn(shadow);
      } catch (e) {
        console.warn(`[DockPanel] Script error in "${current.name}":`, e);
      }
    }
  }, [current?.html, current?.name, panelData]);

  if (!current) return null;

  const showTabs = panels.length > 1;
  const isSide = direction === "left" || direction === "right";

  const borderClass = floating
    ? "border border-border/50 rounded-lg shadow-lg"
    : isSide
      ? direction === "left" ? "border-r border-border" : "border-l border-border"
      : "border-t border-border";

  const sizeStyle = floating
    ? { maxHeight: maxSize ? `${maxSize}px` : "80vh" }
    : isSide
      ? { width: "380px", maxHeight: maxSize ? `${maxSize}px` : "50vh" }
      : { maxHeight: maxSize ? `${maxSize}px` : "50vh" };

  const tabBar = showTabs && (
    <div className={`flex items-center gap-0 ${isSide ? "border-b" : "border-b"} border-border/50 px-2 shrink-0`}>
      {panels.map((p, i) => (
        <button
          key={p.name}
          onClick={() => setActiveTab(i)}
          className={`relative flex items-center gap-1.5 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider cursor-pointer transition-colors
            ${i === activeTab
              ? "text-accent"
              : "text-text-dim/50 hover:text-text-dim/80"
            }`}
        >
          {p.name}
          {p.dismissible && (
            <span
              onClick={(e) => { e.stopPropagation(); onClose(p.name); }}
              className="ml-1 text-text-dim/30 hover:text-text-dim/70 text-[10px]"
            >
              ×
            </span>
          )}
          {i === activeTab && (
            <span className="absolute bottom-0 left-2 right-2 h-[2px] bg-accent rounded-full" />
          )}
        </button>
      ))}
    </div>
  );

  const singleHeader = !showTabs && (
    <div className="flex items-center justify-between px-4 py-2 border-b border-border/50 shrink-0">
      <span
        className="text-[11px] font-semibold uppercase tracking-wider"
        style={{ color: "var(--accent, #b8a0e8)", opacity: 0.8 }}
      >
        {current.name}
      </span>
      {current.dismissible && (
        <button
          onClick={() => onClose(current.name)}
          className="text-text-dim/30 hover:text-text-dim/70 transition-colors text-sm cursor-pointer"
        >
          ×
        </button>
      )}
    </div>
  );

  return (
    <>
      <div
        className={`${borderClass} bg-surface/80 backdrop-blur-[16px] shrink-0 flex flex-col ${floating ? "overflow-hidden" : ""}`}
        style={sizeStyle}
      >
        {tabBar}
        {singleHeader}
        {/* Content */}
        <div className="overflow-y-auto px-4 py-3 flex-1 min-h-0">
          <div ref={containerRef} />
        </div>
      </div>
      {modalSrc && <ImageModal src={modalSrc} onClose={() => setModalSrc(null)} />}
    </>
  );
}
