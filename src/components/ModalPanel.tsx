"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import ImageModal from "./ImageModal";
import { installImagePolling } from "@/lib/panel-image-polling";
import { usePanelBridge } from "@/lib/use-panel-bridge";
import { getPanelActionRegistry, parsePanelActions, stripPanelActions } from "@/lib/panel-action-registry";

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
  sessionId?: string;
  panelData?: Record<string, unknown>;
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
  sessionId,
  panelData,
  onClose,
  onMinimize,
  onSendMessage,
}: ModalPanelProps) {
  const backdropZ = 9998 + zIndex * 2;
  const contentZ = 9999 + zIndex * 2;
  const containerRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<ShadowRoot | null>(null);
  const [modalSrc, setModalSrc] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [closed, setClosed] = useState(false);
  const [minimizing, setMinimizing] = useState(false);

  // Animate in when active becomes true (or on initial mount if active)
  useEffect(() => {
    if (active) {
      setClosed(false);
      setVisible(false);
      requestAnimationFrame(() => setVisible(true));
    } else {
      setVisible(false);
      setClosed(true);
    }
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
      const origSend = bridge.sendMessage as (text: string) => void;
      bridge.sendMessage = (text: string) => {
        origSend(text);
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

  // Render shadow content only when html actually changes
  const prevHtmlRef = useRef<string>("");
  useEffect(() => {
    const shadow = shadowRef.current;
    if (!shadow) return;
    if (html === prevHtmlRef.current) return;
    prevHtmlRef.current = html;

    shadow.innerHTML =
      `<style>:host{display:block;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px;line-height:1.6;color:#e0e0e0;}img{cursor:zoom-in;}</style>` +
      stripPanelActions(html);

    installImagePolling(shadow);

    // Parse <panel-actions> and register metadata
    const actionMetas = parsePanelActions(html);
    if (actionMetas.length > 0) {
      getPanelActionRegistry().registerMeta(name, actionMetas);
    }

    // Set panel name context for registerAction calls in panel scripts
    (window as unknown as Record<string, unknown>).__currentPanelName = name;

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
        console.warn(`[ModalPanel] Script error in "${name}":`, e);
      }
    }

    // Clear panel name context
    delete (window as unknown as Record<string, unknown>).__currentPanelName;
  }, [html, name]);

  // No clearPanel on unmount — modal panels stay mounted (hidden via display:none)
  // so that panel action handlers remain alive for choice actions.

  // Close on Escape key (only if dismissible AND topmost in stack)
  useEffect(() => {
    if (!dismissible || !isTopmost) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [dismissible, isTopmost, handleClose]);

  return createPortal(
    <div style={{ display: closed ? "none" : "contents" }}>
      {/* Backdrop */}
      <div
        className="fixed inset-0 transition-opacity duration-200"
        style={{
          zIndex: backdropZ,
          backgroundColor: "rgba(0, 0, 0, 0.5)",
          backdropFilter: "blur(4px)",
          opacity: visible ? 1 : 0,
        }}
        onClick={dismissible ? handleClose : undefined}
      />
      {/* Modal container */}
      <div
        className="fixed inset-0 flex items-center justify-center p-4 pointer-events-none"
        style={{
          zIndex: contentZ,
          opacity: minimizing ? 0 : undefined,
          transition: minimizing ? "opacity 0.25s ease-in" : undefined,
        }}
      >
        <div
          className="relative pointer-events-auto w-full"
          style={{
            maxWidth,
            maxHeight,
            opacity: (visible && !minimizing) ? 1 : 0,
            transform: minimizing
              ? "scale(0.2) translate(60%, 60%)"
              : visible
                ? "scale(1) translateY(0)"
                : "scale(0.95) translateY(10px)",
            transformOrigin: "bottom right",
            transition: minimizing
              ? "transform 0.28s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.25s ease-in"
              : "all 0.2s ease",
          }}
        >
          {/* Panel card */}
          <div
            className="rounded-2xl overflow-hidden border border-white/[0.1] shadow-[0_8px_40px_rgba(0,0,0,0.5)]"
            style={{
              backgroundColor: "var(--surface, rgb(15, 15, 26))",
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
              className="px-5 py-4 overflow-y-auto"
              style={{ maxHeight: `calc(${maxHeight} - 52px)` }}
            >
              <div ref={containerRef} />
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
