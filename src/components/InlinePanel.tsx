"use client";

import { useRef, useEffect, useCallback } from "react";

interface InlinePanelProps {
  html: string;
  sessionId?: string;
}

export default function InlinePanel({ html, sessionId }: InlinePanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<ShadowRoot | null>(null);

  useEffect(() => {
    if (containerRef.current && !shadowRef.current) {
      shadowRef.current = containerRef.current.attachShadow({ mode: "open" });
    }
  }, []);

  const renderContent = useCallback(() => {
    const shadow = shadowRef.current;
    if (!shadow) return;

    shadow.innerHTML =
      `<style>:host{display:block;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px;line-height:1.6;color:#e0e0e0;}</style>` +
      html;

    // Execute <script> tags via Function() with shadow reference
    const scripts = Array.from(shadow.querySelectorAll("script"));
    for (const oldScript of scripts) {
      oldScript.remove();
      try {
        // Auto-fix: replace document.currentScript.getRootNode() with shadow parameter
        let code = oldScript.textContent || "";
        code = code.replace(/document\.currentScript\.getRootNode\(\)/g, "shadow");
        const fn = new Function("shadow", code);
        fn(shadow);
      } catch (e) {
        console.warn("[InlinePanel] Script error:", e);
      }
    }
  }, [html]);

  useEffect(() => {
    renderContent();
  }, [renderContent]);

  return (
    <div
      ref={containerRef}
      className="my-2 rounded-xl overflow-hidden border border-white/[0.06] bg-[rgba(15,15,26,0.25)] p-3"
      data-session-id={sessionId}
    />
  );
}
