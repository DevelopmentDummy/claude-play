"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import ImageModal from "./ImageModal";
import { installImagePolling } from "@/lib/panel-image-polling";
import { usePanelBridge } from "@/lib/use-panel-bridge";

interface ModalPanelProps {
  name: string;
  html: string;
  dismissible: boolean;
  zIndex?: number;
  isTopmost?: boolean;
  maxWidth?: string;
  maxHeight?: string;
  sessionId?: string;
  panelData?: Record<string, unknown>;
  onClose: () => void;
  onSendMessage?: (text: string) => void;
}

export default function ModalPanel({
  name,
  html,
  dismissible,
  zIndex = 0,
  isTopmost = true,
  maxWidth = "860px",
  maxHeight = "80vh",
  sessionId,
  panelData,
  onClose,
  onSendMessage,
}: ModalPanelProps) {
  const backdropZ = 9998 + zIndex * 2;
  const contentZ = 9999 + zIndex * 2;
  const containerRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<ShadowRoot | null>(null);
  const [modalSrc, setModalSrc] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [closed, setClosed] = useState(false);

  // Animate in on mount
  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
  }, []);

  const handleClose = useCallback(() => {
    if (!dismissible) return;
    setVisible(false);
    setTimeout(() => { setClosed(true); onClose(); }, 200);
  }, [dismissible, onClose]);

  // Force close (for sendMessage auto-dismiss — bypasses dismissible check)
  const forceClose = useCallback(() => {
    setVisible(false);
    setTimeout(() => { setClosed(true); onClose(); }, 200);
  }, [onClose]);

  // Install shared bridge + modal-specific sendMessage override that auto-closes
  usePanelBridge(sessionId, panelData);
  useEffect(() => {
    const bridge = (window as unknown as Record<string, unknown>).__panelBridge as Record<string, unknown> | undefined;
    if (bridge) {
      const origSend = bridge.sendMessage as (text: string) => void;
      bridge.sendMessage = (text: string) => {
        origSend(text);
        window.dispatchEvent(new CustomEvent("__modal_panel_dismiss"));
      };
    }
  }, [sessionId, panelData]);

  // Listen for dismiss event (fired by bridge.sendMessage — always force-closes)
  useEffect(() => {
    const handler = () => forceClose();
    window.addEventListener("__modal_panel_dismiss", handler);
    return () => window.removeEventListener("__modal_panel_dismiss", handler);
  }, [forceClose]);

  // Attach shadow DOM (once)
  useEffect(() => {
    if (containerRef.current && !shadowRef.current) {
      shadowRef.current = containerRef.current.attachShadow({ mode: "open" });
      shadowRef.current.addEventListener("click", (e: Event) => {
        const target = e.target as HTMLElement;
        if (target.tagName === "IMG") {
          const src = (target as HTMLImageElement).src;
          if (src) {
            e.preventDefault();
            setModalSrc(src);
          }
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

  // Render shadow content only when html actually changes
  const prevHtmlRef = useRef<string>("");
  useEffect(() => {
    const shadow = shadowRef.current;
    if (!shadow) return;
    if (html === prevHtmlRef.current) return;
    prevHtmlRef.current = html;

    shadow.innerHTML =
      `<style>:host{display:block;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px;line-height:1.6;color:#e0e0e0;}img{cursor:zoom-in;}</style>` +
      html;

    installImagePolling(shadow);

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
  }, [html, name]);

  // Close on Escape key (only if dismissible AND topmost in stack)
  useEffect(() => {
    if (!dismissible || !isTopmost) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [dismissible, isTopmost, handleClose]);

  if (closed) return null;

  return createPortal(
    <>
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
        style={{ zIndex: contentZ }}
      >
        <div
          className="relative pointer-events-auto w-full transition-all duration-200"
          style={{
            maxWidth,
            maxHeight,
            opacity: visible ? 1 : 0,
            transform: visible
              ? "scale(1) translateY(0)"
              : "scale(0.95) translateY(10px)",
          }}
        >
          {/* Panel card */}
          <div
            className="rounded-2xl overflow-hidden border border-white/[0.08] shadow-2xl"
            style={{
              backgroundColor: "var(--surface, rgba(15, 15, 26, 0.95))",
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
    </>,
    document.body
  );
}
