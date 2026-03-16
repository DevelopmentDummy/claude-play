"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface PopupItem {
  template: string;
  html: string;
  duration: number;
}

interface PopupEffectProps {
  popups: PopupItem[];
  themeColor?: string;
  onQueueComplete?: () => void;
}

export default function PopupEffect({ popups, themeColor, onQueueComplete }: PopupEffectProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [phase, setPhase] = useState<"enter" | "visible" | "exit" | "idle">("idle");
  const containerRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const primary = themeColor || "#6366f1";

  const cleanup = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cleanup();
    };
  }, [cleanup]);

  useEffect(() => {
    cleanup();
    if (popups.length > 0) {
      setCurrentIndex(0);
      setPhase("enter");
    } else {
      setPhase("idle");
      setCurrentIndex(0);
    }
  }, [popups, cleanup]);

  useEffect(() => {
    if (!mountedRef.current || popups.length === 0) return;
    const current = popups[currentIndex];
    if (!current) {
      setPhase("idle");
      onQueueComplete?.();
      return;
    }

    if (phase === "enter") {
      timerRef.current = setTimeout(() => {
        if (!mountedRef.current) return;
        setPhase("visible");
      }, 300);
    } else if (phase === "visible") {
      timerRef.current = setTimeout(() => {
        if (!mountedRef.current) return;
        setPhase("exit");
      }, current.duration);
    } else if (phase === "exit") {
      timerRef.current = setTimeout(() => {
        if (!mountedRef.current) return;
        const next = currentIndex + 1;
        if (next < popups.length) {
          setCurrentIndex(next);
          setPhase("enter");
        } else {
          setPhase("idle");
          onQueueComplete?.();
        }
      }, 300);
    }

    return () => cleanup();
  }, [phase, currentIndex, popups, cleanup, onQueueComplete]);

  useEffect(() => {
    if (phase === "idle" || !containerRef.current) return;
    const current = popups[currentIndex];
    if (!current) return;

    const el = containerRef.current;
    let shadow = el.shadowRoot;
    if (!shadow) {
      shadow = el.attachShadow({ mode: "open" });
    }

    shadow.innerHTML = `
      <style>
        :host {
          display: block;
          --popup-primary: ${primary};
          --popup-glow: ${hexToRgba(primary, 0.3)};
        }
        * { box-sizing: border-box; }
        img { max-width: 100%; height: auto; }
      </style>
      ${current.html}
    `;

    const scripts = shadow.querySelectorAll("script");
    scripts.forEach((s) => {
      try {
        const code = s.textContent || "";
        new Function("shadow", code)(shadow);
      } catch (e) {
        console.warn("[PopupEffect] script error:", e);
      }
    });
  }, [phase, currentIndex, popups, primary]);

  if (phase === "idle" || popups.length === 0) return null;

  const backdropStyle: React.CSSProperties = {
    position: "fixed",
    inset: 0,
    zIndex: 10100,
    backgroundColor: "rgba(0,0,0,0.5)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    opacity: phase === "exit" ? 0 : phase === "enter" ? 0 : 1,
    transition: "opacity 300ms ease",
    ...(phase === "enter" && { animation: "popupBackdropIn 300ms ease forwards" }),
    ...(phase === "exit" && { animation: "popupBackdropOut 300ms ease forwards" }),
  };

  const popupStyle: React.CSSProperties = {
    position: "relative",
    zIndex: 10101,
    maxWidth: "480px",
    width: "90vw",
    borderRadius: "16px",
    background: `linear-gradient(135deg, ${primary}, ${adjustColor(primary, 40)})`,
    boxShadow: `0 0 40px ${hexToRgba(primary, 0.3)}, 0 0 80px ${hexToRgba(primary, 0.15)}, 0 8px 32px rgba(0,0,0,0.3)`,
    border: "1px solid rgba(255,255,255,0.15)",
    padding: "24px",
    color: "white",
    overflow: "hidden",
    ...(phase === "enter" && { animation: "popupScaleIn 300ms cubic-bezier(0.34, 1.56, 0.64, 1) forwards" }),
    ...(phase === "visible" && { transform: "scale(1)", opacity: 1 }),
    ...(phase === "exit" && { animation: "popupScaleOut 300ms ease forwards" }),
  };

  return createPortal(
    <>
      <style>{`
        @keyframes popupBackdropIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes popupBackdropOut { from { opacity: 1; } to { opacity: 0; } }
        @keyframes popupScaleIn { from { opacity: 0; transform: scale(0.7); } to { opacity: 1; transform: scale(1); } }
        @keyframes popupScaleOut { from { opacity: 1; transform: scale(1); } to { opacity: 0; transform: scale(0.9); } }
      `}</style>
      <div style={backdropStyle}>
        <div style={popupStyle}>
          <div ref={containerRef} />
        </div>
      </div>
    </>,
    document.body
  );
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16) || 99;
  const g = parseInt(hex.slice(3, 5), 16) || 102;
  const b = parseInt(hex.slice(5, 7), 16) || 241;
  return `rgba(${r},${g},${b},${alpha})`;
}

function adjustColor(hex: string, amount: number): string {
  const r = Math.min(255, (parseInt(hex.slice(1, 3), 16) || 99) + amount);
  const g = Math.min(255, (parseInt(hex.slice(3, 5), 16) || 102) + amount);
  const b = Math.min(255, (parseInt(hex.slice(5, 7), 16) || 241) + amount);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}
