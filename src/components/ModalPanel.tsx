"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import ImageModal from "./ImageModal";
import { installImagePolling } from "@/lib/panel-image-polling";
import { usePanelBridge, createLiveBridgeProxy, releaseBridgeSubs, RAW_SEND_KEY } from "@/lib/use-panel-bridge";
import { getPanelActionRegistry, isMountOncePanel, parsePanelActions, stripPanelActions, stripPanelMeta } from "@/lib/panel-action-registry";
import { useEscapeKey } from "@/hooks/useEscapeKey";
import { PANEL_DEFENSIVE_STYLE } from "./PanelSlot";

interface ModalPanelProps {
  name: string;
  html: string;
  dismissible: boolean;
  /** Whether this modal is currently open (visible). When false, rendered with display:none to keep handlers alive. */
  active?: boolean;
  zIndex?: number;
  isTopmost?: boolean;
  maxWidth?: string;
  maxHeight?: string;
  /** When true, render as full-screen panel: opaque backdrop, fills entire viewport, no rounded shell. */
  fullScreen?: boolean;
  sessionId?: string;
  panelData?: Record<string, unknown>;
  /** When true (default), an overlay blocks panel interaction while AI is streaming. */
  lockDuringStreaming?: boolean;
  onClose: () => void;
  onMinimize?: () => void;
  onSendMessage?: (text: string) => void;
}

export default function ModalPanel({
  name,
  html,
  dismissible,
  active = true,
  zIndex = 0,
  isTopmost = true,
  maxWidth = "860px",
  maxHeight = "80vh",
  fullScreen = false,
  sessionId,
  panelData,
  lockDuringStreaming = true,
  onClose,
  onMinimize,
  onSendMessage,
}: ModalPanelProps) {
  const VIEWPORT_INSET_X = 32; // outer p-4 => 16px * 2
  const CONTENT_CHROME_X = 40; // content px-5 => 20px * 2
  // Full-screen panels render above regular modals (which start at 9998)
  const backdropZ = fullScreen ? 19998 + zIndex * 2 : 9998 + zIndex * 2;
  const contentZ = fullScreen ? 19999 + zIndex * 2 : 9999 + zIndex * 2;
  const containerRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<ShadowRoot | null>(null);
  const prevHtmlRef = useRef<string>("");
  // mount-once 패널이 이미 마운트됐는지 — 이후 html 변경·재활성화·maxWidth 변경에도 다시 그리지 않는다 (stage-layout spec §6.2).
  const mountedOnceRef = useRef(false);
  // 패널 스크립트가 __panelBridge.on()으로 건 구독의 해제 함수 — 재렌더·언마운트 때 해제한다
  const bridgeUnsubsRef = useRef<Array<() => void>>([]);
  const [modalSrc, setModalSrc] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [closed, setClosed] = useState(false);
  const [minimizing, setMinimizing] = useState(false);
  // Counter to force shadow re-render when modal becomes active
  const [renderEpoch, setRenderEpoch] = useState(0);
  const [streaming, setStreaming] = useState(false);
  const effectiveMaxWidth = fullScreen
    ? "100vw"
    : `min(calc(100vw - ${VIEWPORT_INSET_X}px), calc(${maxWidth} + ${CONTENT_CHROME_X}px))`;
  const effectiveMaxHeight = fullScreen ? "100vh" : maxHeight;

  // Track streaming state via global event
  useEffect(() => {
    const handler = (e: Event) => setStreaming(!!(e as CustomEvent).detail);
    window.addEventListener("__bridge_streaming_change", handler);
    setStreaming(!!(window as unknown as Record<string, unknown>).__bridgeIsStreaming);
    return () => window.removeEventListener("__bridge_streaming_change", handler);
  }, []);

  // Animate in when active becomes true (or on initial mount if active)
  const prevActiveRef = useRef(active);
  useEffect(() => {
    if (active) {
      setClosed(false);
      setMinimizing(false);
      setVisible(false);
      requestAnimationFrame(() => setVisible(true));
      // Force shadow re-render when modal becomes active again
      // (e.g. competition/adventure panel needs fresh DOM/scripts each time it opens)
      if (!prevActiveRef.current) {
        prevHtmlRef.current = "";
        setRenderEpoch(e => e + 1);
      }
    } else {
      setVisible(false);
      setClosed(true);
    }
    prevActiveRef.current = active;
  }, [active]);

  const handleClose = useCallback(() => {
    if (!dismissible) return;
    setVisible(false);
    setTimeout(() => { setClosed(true); onClose(); }, 200);
  }, [dismissible, onClose]);

  const handleMinimize = useCallback(() => {
    if (!onMinimize) return;
    setMinimizing(true);
    setTimeout(() => { onMinimize(); }, 280);
  }, [onMinimize]);

  // Force close (for sendMessage auto-dismiss — bypasses dismissible check)
  const forceClose = useCallback(() => {
    setVisible(false);
    setTimeout(() => { setClosed(true); onClose(); }, 200);
  }, [onClose]);

  // Install shared bridge + modal-specific sendMessage override that auto-closes
  // ONLY the topmost modal wraps sendMessage to prevent closing all stacked modals
  usePanelBridge(sessionId, panelData);
  useEffect(() => {
    if (!isTopmost) return;
    const bridge = (window as unknown as Record<string, unknown>).__panelBridge as Record<string, unknown> | undefined;
    if (bridge) {
      const origSend = bridge.sendMessage as (text: string, opts?: { silent?: boolean }) => void;
      // 감싸기 전 원본을 남긴다 — 모달이 아닌 패널(사이드바·무대·독·인라인)의 라이브 프록시는 이 원본을 써서
      // 자기 전송이 최상단 모달을 닫아 버리지 않게 한다 (createLiveBridgeProxy의 rawSend 옵션).
      if (typeof bridge[RAW_SEND_KEY] !== "function") {
        Object.defineProperty(bridge, RAW_SEND_KEY, { value: origSend, enumerable: false, configurable: true, writable: true });
      }
      bridge.sendMessage = (text: string, opts?: { silent?: boolean }) => {
        origSend(text, opts);
        window.dispatchEvent(new CustomEvent("__modal_panel_dismiss", { detail: name }));
      };
    }
  }, [sessionId, panelData, isTopmost, name]);

  // Listen for dismiss event — only respond if targeted at this modal or untargeted (legacy)
  useEffect(() => {
    if (!isTopmost) return;
    const handler = (e: Event) => {
      const target = (e as CustomEvent).detail;
      if (!target || target === name) forceClose();
    };
    window.addEventListener("__modal_panel_dismiss", handler);
    return () => window.removeEventListener("__modal_panel_dismiss", handler);
  }, [forceClose, isTopmost, name]);

  // Attach shadow DOM (once)
  useEffect(() => {
    if (containerRef.current && !shadowRef.current) {
      shadowRef.current = containerRef.current.attachShadow({ mode: "open" });
      shadowRef.current.addEventListener("click", (e: Event) => {
        const target = e.target as HTMLElement;
        if (target.tagName === "IMG") {
          if (target.hasAttribute("data-no-zoom") || target.closest("[data-no-zoom]")) return;
          const src = (target as HTMLImageElement).src;
          if (src) {
            e.preventDefault();
            setModalSrc(src);
          }
          return;
        }
        const anchor = target.closest("a");
        if (anchor) {
          if (anchor.hasAttribute("data-no-zoom")) return;
          const href = anchor.getAttribute("href") || "";
          if (/\.(png|jpe?g|webp|gif|bmp|svg)(\?|$)/i.test(href)) {
            e.preventDefault();
            setModalSrc(anchor.href);
          }
        }
      });
    }
  }, []);

  // Render shadow content only when html actually changes (or when prevHtmlRef is reset by active toggle)
  // NOTE: prevHtmlRef is declared above, near other refs
  useEffect(() => {
    const shadow = shadowRef.current;
    if (!shadow) return;
    if (mountedOnceRef.current) return;
    if (html === prevHtmlRef.current) return;
    prevHtmlRef.current = html;
    mountedOnceRef.current = isMountOncePanel(html);

    // 이전 렌더의 스크립트가 건 브리지 구독(on)을 해제한다 — DOM을 갈아끼우면 그 핸들러는 남의 DOM을 만진다
    releaseBridgeSubs(bridgeUnsubsRef.current);

    shadow.innerHTML =
      `<style>:host{display:block;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px;line-height:1.6;color:#e0e0e0;}img{cursor:zoom-in;}</style>` +
      PANEL_DEFENSIVE_STYLE +
      stripPanelMeta(stripPanelActions(html));

    // Box model rule:
    // - modal shell decides the outer size (layout/meta/default)
    // - panel content always fits inside the shell width
    const hostEl = shadow.host as HTMLElement;
    hostEl.style.width = "100%";
    hostEl.style.maxWidth = "100%";
    hostEl.style.minWidth = "0";

    installImagePolling(shadow);

    // Parse <panel-actions> and register metadata
    const actionMetas = parsePanelActions(html);
    if (actionMetas.length > 0) {
      if (sessionId) getPanelActionRegistry(sessionId).registerMeta(name, actionMetas);
    }

    // Set panel name context for registerAction calls in panel scripts
    (window as unknown as Record<string, unknown>).__currentPanelName = name;

    // 스크립트의 __panelBridge는 조회 시점의 브리지를 따른다 (spec §6.3).
    // 모달 스크립트는 rawSend를 쓰지 않는다 — 최상단 모달의 "보내고 닫기" 래핑이 그대로 적용돼야 한다.
    const liveBridge = createLiveBridgeProxy((unsub) => bridgeUnsubsRef.current.push(unsub));
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
        console.warn(`[ModalPanel] Script error in "${name}":`, e);
      }
    }

    // Clear panel name context
    delete (window as unknown as Record<string, unknown>).__currentPanelName;
  }, [html, name, renderEpoch, maxWidth]);

  // 언마운트 시 브리지 구독 해제 (세션 이동 등으로 모달이 사라질 때 다음 세션까지 핸들러가 남지 않게).
  // StrictMode의 모의 언마운트→재마운트에서는 렌더 effect가 처음부터 다시 그리도록 표식도 되돌린다
  // (PanelSlot과 같은 처리 — 안 그러면 방금 해제한 구독이 다시 걸리지 않는다).
  useEffect(() => {
    const subs = bridgeUnsubsRef.current;
    return () => {
      releaseBridgeSubs(subs);
      prevHtmlRef.current = "";
      mountedOnceRef.current = false;
    };
  }, []);

  // No clearPanel on unmount — modal panels stay mounted (hidden via display:none)
  // so that panel action handlers remain alive for choice actions.

  // Close on Escape key (only if dismissible AND topmost in stack)
  useEscapeKey(handleClose, dismissible && isTopmost);

  return createPortal(
    <div style={{ display: closed ? "none" : "contents" }}>
      {/* Backdrop */}
      <div
        className="fixed inset-0 transition-opacity duration-200"
        style={{
          zIndex: backdropZ,
          backgroundColor: fullScreen ? "var(--bg, rgb(10, 10, 18))" : "rgba(0, 0, 0, 0.5)",
          backdropFilter: fullScreen ? undefined : "blur(4px)",
          opacity: visible ? 1 : 0,
        }}
        onClick={dismissible && !fullScreen ? handleClose : undefined}
      />
      {/* Modal container */}
      <div
        className={`fixed inset-0 flex items-center justify-center pointer-events-none ${fullScreen ? "p-0" : "p-4"}`}
        style={{
          zIndex: contentZ,
          opacity: minimizing ? 0 : undefined,
          transition: minimizing ? "opacity 0.25s ease-in" : undefined,
        }}
      >
        <div
          className="relative pointer-events-auto w-full max-w-full"
          style={{
            maxWidth: effectiveMaxWidth,
            maxHeight: effectiveMaxHeight,
            width: fullScreen ? "100vw" : undefined,
            height: fullScreen ? "100vh" : undefined,
            opacity: (visible && !minimizing) ? 1 : 0,
            transform: minimizing
              ? "scale(0.2) translate(60%, 60%)"
              : visible
                ? "scale(1) translateY(0)"
                : fullScreen
                  ? "scale(1) translateY(0)"
                  : "scale(0.95) translateY(10px)",
            transformOrigin: "bottom right",
            transition: minimizing
              ? "transform 0.28s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.25s ease-in"
              : fullScreen
                ? "opacity 0.2s ease"
                : "all 0.2s ease",
          }}
        >
          {/* Panel card */}
          <div
            className={fullScreen
              ? "overflow-hidden h-full flex flex-col"
              : "rounded-2xl overflow-hidden border border-white/[0.1] shadow-[0_8px_40px_rgba(0,0,0,0.5)]"}
            style={{
              backgroundColor: fullScreen ? "transparent" : "var(--surface, rgb(15, 15, 26))",
              width: "100%",
              maxWidth: "100%",
              height: fullScreen ? "100%" : undefined,
            }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06]">
              <span
                className="text-[12px] font-semibold uppercase tracking-wider"
                style={{ color: "var(--accent, #b8a0e8)", opacity: 0.8 }}
              >
                {name}
              </span>
              <div className="flex items-center gap-1">
                {onMinimize && !dismissible && (
                  <button
                    onClick={handleMinimize}
                    className="text-white/40 hover:text-white/80 transition-colors p-1"
                    aria-label="Minimize"
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="4,6 8,10 12,6" />
                    </svg>
                  </button>
                )}
                {dismissible && (
                  <button
                    onClick={handleClose}
                    className="text-white/40 hover:text-white/80 transition-colors p-1"
                    aria-label="Close"
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    >
                      <line x1="4" y1="4" x2="12" y2="12" />
                      <line x1="12" y1="4" x2="4" y2="12" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
            {/* Content */}
            <div
              className={fullScreen
                ? "px-5 py-4 overflow-y-auto overflow-x-hidden relative flex-1 min-h-0"
                : "px-5 py-4 overflow-y-auto overflow-x-hidden relative"}
              style={fullScreen
                ? { width: "100%", maxWidth: "100%" }
                : { maxHeight: `calc(${maxHeight} - 52px)`, width: "100%", maxWidth: "100%" }}
            >
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
        </div>
      </div>
      {modalSrc && (
        <ImageModal src={modalSrc} onClose={() => setModalSrc(null)} />
      )}
    </div>,
    document.body
  );
}
