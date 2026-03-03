"use client";

import { useRef, useEffect } from "react";

interface PanelSlotProps {
  name: string;
  html: string;
}

export default function PanelSlot({ name, html }: PanelSlotProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<ShadowRoot | null>(null);

  useEffect(() => {
    if (containerRef.current && !shadowRef.current) {
      shadowRef.current = containerRef.current.attachShadow({ mode: "open" });
    }
  }, []);

  useEffect(() => {
    if (shadowRef.current) {
      shadowRef.current.innerHTML =
        `<style>:host{display:block;padding:8px 12px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px;color:#e0e0e0;}</style>` +
        html;
    }
  }, [html]);

  return (
    <div className="bg-[rgba(15,15,26,0.4)]">
      <div className="px-3 py-1.5 text-[11px] font-semibold text-accent uppercase tracking-wider bg-surface">
        {name}
      </div>
      <div ref={containerRef} />
    </div>
  );
}
