"use client";

import { useState, useEffect } from "react";
import { createPortal } from "react-dom";

interface MinimizedModalsProps {
  items: { name: string }[];
  onRestore: (name: string) => void;
}

export default function MinimizedModals({ items, onRestore }: MinimizedModalsProps) {
  const [mounted, setMounted] = useState(false);
  const [animatedIn, setAnimatedIn] = useState<Set<string>>(new Set());

  useEffect(() => { setMounted(true); }, []);

  // Animate new items in
  useEffect(() => {
    const newNames = items.map((i) => i.name).filter((n) => !animatedIn.has(n));
    if (newNames.length > 0) {
      requestAnimationFrame(() => {
        setAnimatedIn((prev) => {
          const next = new Set(prev);
          newNames.forEach((n) => next.add(n));
          return next;
        });
      });
    }
    // Clean up removed items
    setAnimatedIn((prev) => {
      const current = new Set(items.map((i) => i.name));
      const next = new Set<string>();
      prev.forEach((n) => { if (current.has(n)) next.add(n); });
      return next;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.map((i) => i.name).join(",")]);

  if (!mounted || items.length === 0) return null;

  return createPortal(
    <div
      className="fixed flex flex-col-reverse gap-2 pointer-events-none"
      style={{ bottom: 80, right: 16, zIndex: 9990 }}
    >
      {items.map((item) => {
        const isIn = animatedIn.has(item.name);
        return (
          <button
            key={item.name}
            onClick={() => onRestore(item.name)}
            className="pointer-events-auto flex items-center gap-2 px-3 py-2 rounded-xl border border-white/[0.1] shadow-lg backdrop-blur-md cursor-pointer select-none"
            style={{
              backgroundColor: "rgba(15, 15, 26, 0.85)",
              opacity: isIn ? 1 : 0,
              transform: isIn ? "scale(1) translateY(0)" : "scale(0.5) translateY(10px)",
              transformOrigin: "bottom right",
              transition: "all 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)",
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              className="text-white/50"
            >
              <rect x="2" y="2" width="12" height="12" rx="2" />
              <line x1="2" y1="5" x2="14" y2="5" />
            </svg>
            <span
              className="text-[11px] font-medium uppercase tracking-wider whitespace-nowrap"
              style={{ color: "var(--accent, #b8a0e8)" }}
            >
              {item.name}
            </span>
          </button>
        );
      })}
    </div>,
    document.body
  );
}
