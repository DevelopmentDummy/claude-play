"use client";

import { useRef, useEffect, useCallback } from "react";

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

  // Install the bridge on window (shared across all panels)
  useEffect(() => {
    const bridge = {
      sendMessage(text: string) {
        window.dispatchEvent(new CustomEvent("__panel_send_message", { detail: text }));
      },
      async updateVariables(patch: Record<string, unknown>) {
        if (!sessionId) return;
        const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/variables`, {
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
  }, [sessionId, panelData]);

  useEffect(() => {
    if (containerRef.current && !shadowRef.current) {
      shadowRef.current = containerRef.current.attachShadow({ mode: "open" });
    }
  }, []);

  const renderContent = useCallback(() => {
    const shadow = shadowRef.current;
    if (!shadow) return;

    // Set base styles + HTML (scripts won't execute via innerHTML)
    shadow.innerHTML =
      `<style>:host{display:block;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px;line-height:1.6;color:#e0e0e0;}</style>` +
      html;

    // Execute <script> tags manually via Function() to avoid DOM insertion issues
    const scripts = Array.from(shadow.querySelectorAll("script"));
    for (const oldScript of scripts) {
      oldScript.remove();
      try {
        const fn = new Function("shadow", oldScript.textContent || "");
        fn(shadow);
      } catch (e) {
        console.warn(`[PanelSlot] Script error in "${name}":`, e);
      }
    }
  }, [html]);

  useEffect(() => {
    renderContent();
  }, [renderContent]);

  return (
    <div className="bg-[rgba(15,15,26,0.25)] rounded-xl overflow-hidden border border-white/[0.06] shrink-0">
      <div className="px-4 py-2.5 text-[11px] font-semibold text-accent/80 uppercase tracking-wider">
        {name}
      </div>
      <div ref={containerRef} className="px-4 pb-4" />
    </div>
  );
}
