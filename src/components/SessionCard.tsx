"use client";

import { useState, useRef, useEffect } from "react";

interface SessionCardProps {
  id: string;
  title: string;
  persona: string;
  createdAt: string;
  hasIcon?: boolean;
  model?: string;
  index?: number;
  onOpen: () => void;
  onDelete: () => void;
}

/** Determine provider info from model string */
function providerInfo(model?: string): { label: string; bg: string; text: string; border: string } | null {
  if (!model) return null;
  const lower = model.split(":")[0].toLowerCase();
  const codexPrefixes = ["gpt-5", "codex-mini", "o3", "o4"];
  for (const prefix of codexPrefixes) {
    if (lower === prefix || lower.startsWith(prefix))
      return { label: "Codex", bg: "bg-[#2a5a3a]/60", text: "text-[#4dff91]/80", border: "border-[#4dff91]/15" };
  }
  const geminiPrefixes = ["gemini-", "gemini"];
  for (const prefix of geminiPrefixes) {
    if (lower === prefix || lower.startsWith(prefix))
      return { label: "Gemini", bg: "bg-[#1a3a5c]/60", text: "text-[#64b5f6]/80", border: "border-[#64b5f6]/15" };
  }
  // Claude — show badge for explicit models
  if (lower.includes("sonnet") || lower.includes("opus") || lower.includes("haiku") || lower.includes("claude"))
    return { label: "Claude", bg: "bg-[#4a2a1a]/60", text: "text-[#ff9f43]/80", border: "border-[#ff9f43]/15" };
  return null;
}

export default function SessionCard({
  id,
  title,
  persona,
  createdAt,
  hasIcon,
  model,
  onOpen,
  onDelete,
}: SessionCardProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, []);

  const date = new Date(createdAt);
  const timeStr = date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
  });

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirmDelete) {
      onDelete();
    } else {
      setConfirmDelete(true);
      timerRef.current = setTimeout(() => setConfirmDelete(false), 2500);
    }
  };

  return (
    <div
      className="group relative flex items-center gap-3 mx-2 px-4 py-3 rounded-xl cursor-pointer
        transition-all duration-fast
        hover:bg-surface-light/50"
      onClick={onOpen}
    >
      {hasIcon ? (
        <img
          src={`/api/sessions/${id}/files/images/icon.png`}
          alt=""
          className="w-8 h-8 rounded-full object-cover shrink-0 border border-white/[0.08]"
        />
      ) : (
        <div className="w-8 h-8 rounded-full shrink-0 bg-surface-light/40 flex items-center justify-center text-xs text-text-dim/60 border border-white/[0.06]">
          {persona.charAt(0).toUpperCase()}
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="text-sm text-text truncate leading-snug">{title}</div>
        <div className="text-xs text-text-dim/60 mt-1 flex items-center gap-1.5">
          <span>{persona} &middot; {timeStr}</span>
          {(() => {
            const info = providerInfo(model);
            if (info) return (
              <span className={`inline-flex items-center px-1.5 py-0 rounded text-[9px] font-semibold tracking-wide border ${info.bg} ${info.text} ${info.border}`}>
                {info.label}
              </span>
            );
            if (model && model !== "") return (
              <span className="inline-flex items-center px-1.5 py-0 rounded text-[9px] font-medium tracking-wide text-text-dim/40">
                {model}
              </span>
            );
            return null;
          })()}
        </div>
      </div>

      <button
        className={`absolute top-2.5 right-2.5 flex items-center justify-center rounded-md text-sm cursor-pointer
          transition-all duration-fast
          ${confirmDelete
            ? "px-2 py-0.5 text-error bg-error/15 border border-error/30 opacity-100"
            : "w-6 h-6 text-text-dim/40 opacity-100 md:opacity-0 md:group-hover:opacity-100 hover:text-error hover:bg-error/10"
          }`}
        onClick={handleDelete}
      >
        {confirmDelete ? <span className="text-[10px] font-medium">삭제</span> : <>&times;</>}
      </button>
    </div>
  );
}
