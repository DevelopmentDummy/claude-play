"use client";

import { useRef, useEffect, useState } from "react";
import ImageModal from "./ImageModal";
import { installImagePolling } from "@/lib/panel-image-polling";
import { usePanelBridge, createLiveBridgeProxy, releaseBridgeSubs } from "@/lib/use-panel-bridge";
import { getPanelActionRegistry, isMountOncePanel, parsePanelActions, stripPanelActions, stripPanelMeta } from "@/lib/panel-action-registry";
import { PANEL_DEFENSIVE_STYLE } from "./PanelSlot";

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
  /** When true (default), an overlay blocks panel interaction while AI is streaming. */
  lockDuringStreaming?: boolean;
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
  lockDuringStreaming = true,
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
  // 지금 shadow에 마운트된 mount-once 패널 이름. 독은 탭이 shadow 하나를 공유하므로
  // 같은 패널의 html 변경만 건너뛰고, 탭을 바꾸면 그 패널을 새로 마운트한다 (stage-layout spec §6.2).
  const mountedOnceNameRef = useRef<string | null>(null);
  // 패널 스크립트가 __panelBridge.on()으로 건 구독의 해제 함수. 독은 탭들이 shadow 하나를 공유하므로
  // 다른 탭으로 갈아끼우기 전에 반드시 해제한다 — 안 그러면 이전 탭의 핸들러가 새 탭의 DOM을 만지고,
  // 탭을 오갈 때마다 구독이 쌓인다.
  const bridgeUnsubsRef = useRef<Array<() => void>>([]);
  useEffect(() => {
    const shadow = shadowRef.current;
    if (!shadow || !current) return;
    if (mountedOnceNameRef.current === current.name) return;
    if (current.html === prevHtmlRef.current) return;
    prevHtmlRef.current = current.html;
    mountedOnceNameRef.current = isMountOncePanel(current.html) ? current.name : null;

    releaseBridgeSubs(bridgeUnsubsRef.current);
    shadow.innerHTML =
      `<style>:host{display:block;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px;line-height:1.6;color:#e0e0e0;}img{cursor:zoom-in;}</style>` +
      PANEL_DEFENSIVE_STYLE +
      stripPanelMeta(stripPanelActions(current.html));

    installImagePolling(shadow);

    // Parse <panel-actions> and register metadata
    const actionMetas = parsePanelActions(current.html);
    if (actionMetas.length > 0 && sessionId) {
      getPanelActionRegistry(sessionId).registerMeta(current.name, actionMetas);
    }

    // Set panel name context for registerAction calls in panel scripts
    (window as unknown as Record<string, unknown>).__currentPanelName = current.name;

    // 스크립트의 __panelBridge는 조회 시점의 브리지를 따른다 (spec §6.3). 독은 모달이 아니므로
    // sendMessage는 모달 래핑 전 원본을 쓴다(rawSend) — 독 패널의 전송이 위에 뜬 모달을 닫지 않게.
    const liveBridge = createLiveBridgeProxy((unsub) => bridgeUnsubsRef.current.push(unsub), { rawSend: true });
    const scripts = Array.from(shadow.querySelectorAll("script:not([type]), script[type='text/javascript']"));
    for (const oldScript of scripts) {
      oldScript.remove();
      try {
        let code = oldScript.textContent || "";
        // Remove full declaration to avoid TDZ collision with Function("shadow", ...) parameter
        code = code.replace(/(?:const|let|var)\s+shadow\s*=\s*document\.currentScript\??\.getRootNode\??\(\)\s*;?/g, "");
        code = code.replace(/document\.currentScript\??\.getRootNode\??\(\)/g, "shadow");
        const fn = new Function("shadow", "__panelBridge", code);
        fn(shadow, liveBridge);
      } catch (e) {
        console.warn(`[DockPanel] Script error in "${current.name}":`, e);
      }
    }

    // Clear panel name context
    delete (window as unknown as Record<string, unknown>).__currentPanelName;
  }, [current?.html, current?.name]);

  // Cleanup panel action registry entries on unmount
  useEffect(() => {
    const subs = bridgeUnsubsRef.current;
    return () => {
      releaseBridgeSubs(subs);
      if (sessionId) {
        for (const p of panels) {
          getPanelActionRegistry(sessionId).clearPanel(p.name);
        }
      }
      // StrictMode의 모의 언마운트→재마운트에서 렌더 effect가 처음부터 다시 그리도록 표식을 되돌린다
      // (방금 해제한 구독·액션 핸들러가 다시 걸리게 — PanelSlot과 같은 처리. 실제 언마운트에서는 무해)
      prevHtmlRef.current = "";
      mountedOnceNameRef.current = null;
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
              : "text-text-dim/70 hover:text-text-dim/80"
            }`}
        >
          {p.name}
          {p.dismissible && (
            <span
              role="button"
              aria-label="탭 닫기"
              onClick={(e) => { e.stopPropagation(); onClose(p.name); }}
              className="ml-1 text-text-dim/70 hover:text-text-dim/70 text-[10px]"
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
          aria-label="패널 닫기"
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
          {streaming && lockDuringStreaming && (
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
