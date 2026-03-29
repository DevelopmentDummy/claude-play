"use client";

import { useRef, useEffect, useCallback, useState } from "react";
import ImageModal from "./ImageModal";
import { installImagePolling } from "@/lib/panel-image-polling";
import { usePanelBridge } from "@/lib/use-panel-bridge";
import { getPanelActionRegistry, parsePanelActions, stripPanelActions } from "@/lib/panel-action-registry";

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
          if (target.hasAttribute("data-no-zoom") || target.closest("[data-no-zoom]")) return;
          const src = (target as HTMLImageElement).src;
          if (src) { e.preventDefault(); setModalSrc(src); }
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

  // Re-render shadow content only when html actually changes
  const prevHtmlRef = useRef<string>("");
  useEffect(() => {
    const shadow = shadowRef.current;
    if (!shadow) return;
    if (html === prevHtmlRef.current) return;
    prevHtmlRef.current = html;

    shadow.innerHTML =
      `<style>:host{display:block;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px;line-height:1.6;color:#e0e0e0;}img{cursor:zoom-in;}</style>` +
      stripPanelActions(html);

    // Auto-poll images that haven't loaded yet (deferred generation)
    installImagePolling(shadow);

    // Parse <panel-actions> and register metadata
    const actionMetas = parsePanelActions(html);
    if (actionMetas.length > 0) {
      getPanelActionRegistry().registerMeta(name, actionMetas);
    }

    // Set panel name context for registerAction calls in panel scripts
    (window as unknown as Record<string, unknown>).__currentPanelName = name;

    // Execute <script> tags manually via Function() to avoid DOM insertion issues
    // Skip non-JS scripts (e.g. type="application/json" used as embedded data)
    const scripts = Array.from(shadow.querySelectorAll("script:not([type]), script[type='text/javascript']"));
    for (const oldScript of scripts) {
      oldScript.remove();
      try {
        let code = oldScript.textContent || "";
        // Remove full declaration (e.g. `const shadow = document.currentScript.getRootNode();`)
        // to avoid TDZ collision with the Function("shadow", ...) parameter
        code = code.replace(/(?:const|let|var)\s+shadow\s*=\s*document\.currentScript\??\.getRootNode\??\(\)\s*;?/g, "");
        // Replace remaining standalone calls
        code = code.replace(/document\.currentScript\??\.getRootNode\??\(\)/g, "shadow");
        const fn = new Function("shadow", code);
        fn(shadow);
      } catch (e) {
        console.warn(`[PanelSlot] Script error in "${name}":`, e);
      }
    }

    // Clear panel name context
    delete (window as unknown as Record<string, unknown>).__currentPanelName;
  }, [html, name]);

  // Cleanup panel action registry on unmount
  useEffect(() => {
    return () => { getPanelActionRegistry().clearPanel(name); };
  }, [name]);

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
