"use client";

import { useState, useRef, useEffect, ReactNode } from "react";
import { createPortal } from "react-dom";

export interface KebabMenuItem {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  danger?: boolean;
  hidden?: boolean;
  confirm?: string;
}

interface KebabMenuProps {
  items: KebabMenuItem[];
  badge?: ReactNode;
  className?: string;
}

export default function KebabMenu({ items, badge, className = "" }: KebabMenuProps) {
  const [open, setOpen] = useState(false);
  const [confirmingIndex, setConfirmingIndex] = useState<number | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number; alignRight: boolean } | null>(null);
  const [mounted, setMounted] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      if (btnRef.current?.contains(e.target as Node)) return;
      setOpen(false);
      setConfirmingIndex(null);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setOpen(false); setConfirmingIndex(null); }
    };
    const onScroll = () => { setOpen(false); setConfirmingIndex(null); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onEsc);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onEsc);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !btnRef.current) {
      setPos(null);
      return;
    }
    const rect = btnRef.current.getBoundingClientRect();
    const alignRight = window.innerWidth - rect.right < 180;
    setPos({
      top: rect.bottom + 6,
      left: alignRight ? rect.right : rect.left,
      alignRight,
    });
  }, [open]);

  useEffect(() => {
    return () => { if (confirmTimer.current) clearTimeout(confirmTimer.current); };
  }, []);

  const visibleItems = items
    .map((it, i) => ({ it, i }))
    .filter(({ it }) => !it.hidden);

  const handleItemClick = (e: React.MouseEvent, origIndex: number, item: KebabMenuItem) => {
    e.stopPropagation();
    if (item.confirm) {
      if (confirmingIndex === origIndex) {
        item.onClick();
        setOpen(false);
        setConfirmingIndex(null);
        if (confirmTimer.current) clearTimeout(confirmTimer.current);
      } else {
        setConfirmingIndex(origIndex);
        if (confirmTimer.current) clearTimeout(confirmTimer.current);
        confirmTimer.current = setTimeout(() => setConfirmingIndex(null), 3000);
      }
      return;
    }
    item.onClick();
    setOpen(false);
  };

  return (
    <div className={`relative ${className}`} onClick={(e) => e.stopPropagation()}>
      <button
        ref={btnRef}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className="relative w-7 h-7 flex items-center justify-center rounded-lg
          bg-black/35 backdrop-blur-sm border border-white/[0.08]
          text-white/80 text-base tracking-widest cursor-pointer
          hover:bg-black/55 hover:text-white transition-all duration-fast"
        title="More"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        &#8943;
        {badge && (
          <span className="absolute -top-1 -right-1">{badge}</span>
        )}
      </button>
      {mounted && open && pos && createPortal(
        <div
          ref={menuRef}
          role="menu"
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "fixed",
            top: pos.top,
            left: pos.alignRight ? undefined : pos.left,
            right: pos.alignRight ? window.innerWidth - pos.left : undefined,
          }}
          className="min-w-[150px] bg-[#14141a] border border-white/[0.08] rounded-lg p-1.5
            shadow-[0_8px_24px_rgba(0,0,0,0.5)] z-[100]"
        >
          {visibleItems.map(({ it, i }, displayIdx) => {
            const isDanger = it.danger;
            const isConfirming = confirmingIndex === i;
            const label = isConfirming && it.confirm ? it.confirm : it.label;
            return (
              <button
                key={displayIdx}
                type="button"
                role="menuitem"
                onClick={(e) => handleItemClick(e, i, it)}
                className={`w-full text-left px-3 py-2 rounded-md text-xs cursor-pointer
                  flex items-center gap-2 transition-colors duration-fast
                  ${isDanger
                    ? "text-[#f97a7a] hover:bg-[#f97a7a]/10"
                    : "text-white/85 hover:bg-plum-soft"}
                  ${isConfirming ? "bg-[#f97a7a]/15" : ""}`}
              >
                {it.icon && <span className="opacity-80">{it.icon}</span>}
                <span>{label}</span>
              </button>
            );
          })}
        </div>,
        document.body
      )}
    </div>
  );
}
