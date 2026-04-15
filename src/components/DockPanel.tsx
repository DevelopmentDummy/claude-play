"use client";

import { useRef, useEffect, useState } from "react";
import ImageModal from "./ImageModal";
import { installImagePolling } from "@/lib/panel-image-polling";
import { usePanelBridge } from "@/lib/use-panel-bridge";
import { getPanelActionRegistry, parsePanelActions, stripPanelActions } from "@/lib/panel-action-registry";

export interface DockPanelEntry {
  name: string;
  html: string;
  dismissible: boolean;
}

interface DockPanelProps {
  panels: DockPanelEntry[];
  direction?: "bottom" | "left" | "right";
  maxSize?: number | string;
  sessionId?: string;
  panelData?: Record<string, unknown>;
  onClose: (name: string) => void;
  floating?: boolean;
  open?: boolean;
}

export default function DockPanel({
  panels,
  direction = "bottom",
  maxSize,
  sessionId,
  panelData,
  onClose,
  floating,
  open = true,
}: DockPanelProps) {
  const [activeTab, setActiveTab] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<ShadowRoot | null>(null);
  const [modalSrc, setModalSrc] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [streaming, setStreaming] = useState(false);

  // Track streaming state via global event
  useEffect(() => {
    const handler = (e: Event) => setStreaming(!!(e as CustomEvent).detail);
    window.addEventListener("__bridge_streaming_change", handler);
    setStreaming(!!(window as unknown as Record<string, unknown>).__bridgeIsStreaming);
    return () => window.removeEventListener("__bridge_streaming_change", handler);
  }, []);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Animate open/close
  useEffect(() => {
    if (open) {
      // Delay to allow mount before animating in
      requestAnimationFrame(() => setVisible(true));
    } else {
      setVisible(false);
    }
  }, [open]);

  // Clamp activeTab if panels shrink
  useEffect(() => {
    if (activeTab >= panels.length && panels.length > 0) {
      setActiveTab(panels.length - 1);
    }
  }, [panels.length, activeTab]);

  const current = panels[activeTab] || panels[0];

  usePanelBridge(sessionId, panelData);

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

  // Re-render shadow content only when html actually changes
  const prevHtmlRef = useRef<string>("");
  useEffect(() => {
    const shadow = shadowRef.current;
    if (!shadow || !current) return;
    if (current.html === prevHtmlRef.current) return;
    prevHtmlRef.current = current.html;

    shadow.innerHTML =
      `<style>:host{display:block;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px;line-height:1.6;color:#e0e0e0;}img{cursor:zoom-in;}</style>` +
      stripPanelActions(current.html);

    installImagePolling(shadow);

    // Parse <panel-actions> and register metadata
    const actionMetas = parsePanelActions(current.html);
    if (actionMetas.length > 0) {
      getPanelActionRegistry().registerMeta(current.name, actionMetas);
    }

    // Set panel name context for registerAction calls in panel scripts
    (window as unknown as Record<string, unknown>).__currentPanelName = current.name;

    const scripts = Array.from(shadow.querySelectorAll("script:not([type]), script[type='text/javascript']"));
    for (const oldScript of scripts) {
      oldScript.remove();
      try {
        let code = oldScript.textContent || "";
        // Remove full declaration to avoid TDZ collision with Function("shadow", ...) parameter
        code = code.replace(/(?:const|let|var)\s+shadow\s*=\s*document\.currentScript\??\.getRootNode\??\(\)\s*;?/g, "");
        code = code.replace(/document\.currentScript\??\.getRootNode\??\(\)/g, "shadow");
        const fn = new Function("shadow", code);
        fn(shadow);
      } catch (e) {
        console.warn(`[DockPanel] Script error in "${current.name}":`, e);
      }
    }

    // Clear panel name context
    delete (window as unknown as Record<string, unknown>).__currentPanelName;
  }, [current?.html, current?.name]);

  // Cleanup panel action registry entries on unmount
  useEffect(() => {
    return () => {
      for (const p of panels) {
        getPanelActionRegistry().clearPanel(p.name);
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const showTabs = panels.length > 1;
  const isSide = direction === "left" || direction === "right";
  const maxSizeCss =
    typeof maxSize === "number"
      ? `${maxSize}px`
      : (typeof maxSize === "string" && maxSize.trim() ? maxSize : undefined);

  const borderClass = floating
    ? "border border-border/50 rounded-lg shadow-lg"
    : isSide
      ? direction === "left" ? "border-r border-border" : "border-l border-border"
      : "border-t border-border";

  const sizeStyle = floating
    ? { maxHeight: maxSizeCss || "80vh" }
    : isSide
      ? { width: "380px", maxHeight: maxSizeCss || "50vh" }
      : { maxHeight: maxSizeCss || "50vh" };

  const tabBar = showTabs && current && (
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

  const singleHeader = !showTabs && current && (
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
        ref={wrapperRef}
        className={`${borderClass} bg-surface/80 backdrop-blur-[16px] shrink-0 flex flex-col ${floating ? "overflow-hidden" : ""} transition-all duration-200 ease-out`}
        style={{
          ...sizeStyle,
          ...(visible
            ? { opacity: 1, transform: "translateY(0)" }
            : {
                opacity: 0,
                transform: isSide ? (direction === "left" ? "translateX(-8px)" : "translateX(8px)") : "translateY(8px)",
                maxHeight: "0px",
                overflow: "hidden",
                borderWidth: 0,
                padding: 0,
              }),
        }}
      >
        {tabBar}
        {singleHeader}
        {/* Content */}
        <div className="overflow-y-auto px-4 py-3 flex-1 min-h-0 relative">
          <div ref={containerRef} />
          {streaming && (
            <div
              className="absolute inset-0 z-10"
              style={{ cursor: "not-allowed" }}
              title="AI 응답 중..."
            />
          )}
        </div>
      </div>
      {modalSrc && <ImageModal src={modalSrc} onClose={() => setModalSrc(null)} />}
    </>
  );
}
