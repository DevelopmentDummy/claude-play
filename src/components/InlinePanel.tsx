"use client";

import { useRef, useEffect, useCallback, useState } from "react";
import ImageModal from "./ImageModal";
import { installImagePolling } from "@/lib/panel-image-polling";

interface InlinePanelProps {
  html: string;
  sessionId?: string;
}

export default function InlinePanel({ html, sessionId }: InlinePanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<ShadowRoot | null>(null);
  const [modalSrc, setModalSrc] = useState<string | null>(null);

  useEffect(() => {
    if (containerRef.current && !shadowRef.current) {
      shadowRef.current = containerRef.current.attachShadow({ mode: "open" });
    }
  }, []);

  const renderContent = useCallback(() => {
    const shadow = shadowRef.current;
    if (!shadow) return;

    shadow.innerHTML =
      `<style>:host{display:block;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px;line-height:1.6;color:#e0e0e0;}img{cursor:zoom-in;}</style>` +
      html;

    // Execute <script> tags via Function() with shadow reference
    const scripts = Array.from(shadow.querySelectorAll("script"));
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
        console.warn("[InlinePanel] Script error:", e);
      }
    }

    // Auto-poll images that haven't loaded yet (deferred generation)
    installImagePolling(shadow);

    // Intercept image clicks inside shadow DOM
    shadow.addEventListener("click", (e: Event) => {
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
  }, [html]);

  useEffect(() => {
    renderContent();
  }, [renderContent]);

  return (
    <>
      <div
        ref={containerRef}
        className="my-2 rounded-xl overflow-hidden border border-white/[0.06] bg-[rgba(15,15,26,0.25)] p-3"
        data-session-id={sessionId}
      />
      {modalSrc && <ImageModal src={modalSrc} onClose={() => setModalSrc(null)} />}
    </>
  );
}
