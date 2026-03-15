"use client";

import { useRef, useEffect, useCallback, useState } from "react";
import ImageModal from "./ImageModal";
import { installImagePolling } from "@/lib/panel-image-polling";
import { usePanelBridge } from "@/lib/use-panel-bridge";

interface PanelSlotProps {
  name: string;
  html: string;
  sessionId?: string;
  panelData?: Record<string, unknown>;
  onSendMessage?: (text: string) => void;
}

export default function PanelSlot({ name, html, sessionId, panelData, onSendMessage }: PanelSlotProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<ShadowRoot | null>(null);
  const onSendRef = useRef(onSendMessage);
  onSendRef.current = onSendMessage;
  const [modalSrc, setModalSrc] = useState<string | null>(null);

  usePanelBridge(sessionId, panelData);

  // Attach shadow DOM and install click handler (once)
  useEffect(() => {
    if (containerRef.current && !shadowRef.current) {
      shadowRef.current = containerRef.current.attachShadow({ mode: "open" });
      // Intercept image clicks inside shadow DOM
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

  // Re-render shadow content when html or panelData changes
  useEffect(() => {
    const shadow = shadowRef.current;
    if (!shadow) return;

    shadow.innerHTML =
      `<style>:host{display:block;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px;line-height:1.6;color:#e0e0e0;}img{cursor:zoom-in;}</style>` +
      html;

    // Auto-poll images that haven't loaded yet (deferred generation)
    installImagePolling(shadow);

    // Execute <script> tags manually via Function() to avoid DOM insertion issues
    const scripts = Array.from(shadow.querySelectorAll("script"));
    for (const oldScript of scripts) {
      oldScript.remove();
      try {
        let code = oldScript.textContent || "";
        code = code.replace(/document\.currentScript\??\.getRootNode\??\(\)/g, "shadow");
        const fn = new Function("shadow", code);
        fn(shadow);
      } catch (e) {
        console.warn(`[PanelSlot] Script error in "${name}":`, e);
      }
    }
  }, [html, panelData, name]);

  return (
    <>
      <div className="bg-[rgba(15,15,26,0.25)] rounded-xl overflow-hidden border border-white/[0.06] shrink-0">
        <div className="px-4 py-2.5 text-[11px] font-semibold text-accent/80 uppercase tracking-wider">
          {name}
        </div>
        <div ref={containerRef} className="px-4 pb-4" />
      </div>
      {modalSrc && <ImageModal src={modalSrc} onClose={() => setModalSrc(null)} />}
    </>
  );
}
