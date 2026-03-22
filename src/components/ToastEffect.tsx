"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface ToastItem {
  id: string;
  text: string;
  duration: number;
}

interface ToastEffectProps {
  themeColor?: string;
}

interface ActiveToast extends ToastItem {
  phase: "enter" | "visible" | "exit";
}

let toastIdCounter = 0;

/** Imperative API: call this from anywhere to show a toast */
const listeners = new Set<(item: ToastItem) => void>();

export function showToast(text: string, duration = 3000): void {
  const item: ToastItem = { id: `toast-${++toastIdCounter}`, text, duration };
  listeners.forEach((fn) => fn(item));
}

export default function ToastEffect({ themeColor }: ToastEffectProps) {
  const [toasts, setToasts] = useState<ActiveToast[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const startExit = useCallback((id: string) => {
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, phase: "exit" } : t)));
    const timer = setTimeout(() => removeToast(id), 300);
    timersRef.current.set(`${id}-exit`, timer);
  }, [removeToast]);

  const addToast = useCallback(
    (item: ToastItem) => {
      const active: ActiveToast = { ...item, phase: "enter" };
      setToasts((prev) => [...prev, active]);

      // enter -> visible
      const enterTimer = setTimeout(() => {
        setToasts((prev) => prev.map((t) => (t.id === item.id ? { ...t, phase: "visible" } : t)));
      }, 50);
      timersRef.current.set(`${item.id}-enter`, enterTimer);

      // visible -> exit after duration
      const visibleTimer = setTimeout(() => {
        startExit(item.id);
      }, item.duration + 50);
      timersRef.current.set(item.id, visibleTimer);
    },
    [startExit]
  );

  useEffect(() => {
    listeners.add(addToast);
    return () => {
      listeners.delete(addToast);
    };
  }, [addToast]);

  // Listen for bridge:toast custom events (from __panelBridge.showToast)
  useEffect(() => {
    const handler = (e: Event) => {
      const { text, duration } = (e as CustomEvent).detail as { text: string; duration?: number };
      showToast(text, duration || 3000);
    };
    window.addEventListener("bridge:toast", handler);
    return () => window.removeEventListener("bridge:toast", handler);
  }, []);

  // Cleanup all timers on unmount
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, []);

  if (toasts.length === 0) return null;

  const primary = themeColor || "#6366f1";

  return createPortal(
    <>
      <style>{`
        @keyframes toastSlideIn {
          from { opacity: 0; transform: translateX(100%); }
          to { opacity: 1; transform: translateX(0); }
        }
        @keyframes toastSlideOut {
          from { opacity: 1; transform: translateX(0); }
          to { opacity: 0; transform: translateX(100%); }
        }
      `}</style>
      <div
        style={{
          position: "fixed",
          bottom: 24,
          right: 24,
          zIndex: 10200,
          display: "flex",
          flexDirection: "column-reverse",
          gap: 8,
          pointerEvents: "none",
          maxWidth: "min(400px, calc(100vw - 48px))",
        }}
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            style={{
              pointerEvents: "auto",
              padding: "12px 20px",
              borderRadius: 10,
              background: `var(--toast-bg, ${hexToRgba(primary, 0.9)})`,
              color: `var(--toast-color, #fff)`,
              border: `var(--toast-border, 1px solid ${hexToRgba("#ffffff", 0.15)})`,
              boxShadow: `var(--toast-shadow, 0 4px 20px ${hexToRgba(primary, 0.3)}, 0 2px 8px rgba(0,0,0,0.2))`,
              fontSize: 14,
              lineHeight: 1.5,
              backdropFilter: "blur(8px)",
              cursor: "pointer",
              animation:
                toast.phase === "enter" || toast.phase === "visible"
                  ? "toastSlideIn 300ms ease forwards"
                  : "toastSlideOut 300ms ease forwards",
            }}
            onClick={() => startExit(toast.id)}
          >
            {toast.text}
          </div>
        ))}
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
