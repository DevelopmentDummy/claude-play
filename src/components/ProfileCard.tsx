"use client";

import { useState, useRef, useEffect } from "react";

interface ProfileCardProps {
  name: string;
  isPrimary?: boolean;
  onEdit: () => void;
  onDelete: () => void;
}

export default function ProfileCard({ name, isPrimary, onEdit, onDelete }: ProfileCardProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, []);

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    // Profile delete is a HARD (non-recoverable) delete — require a confirming
    // second click within the timeout window, mirroring SessionCard.
    if (confirmDelete) { onDelete(); return; }
    setConfirmDelete(true);
    timerRef.current = setTimeout(() => setConfirmDelete(false), 2500);
  };

  return (
    <div
      className={`group relative inline-flex items-center gap-2 px-3 py-1.5 rounded-full cursor-pointer
        transition-all duration-fast border
        ${isPrimary
          ? "border-plum-hairline bg-plum-soft text-text"
          : "border-lobby-border bg-white/[0.02] text-text-dim hover:text-text"}`}
      onClick={onEdit}
      title={isPrimary ? `${name} (primary)` : name}
    >
      {isPrimary && (
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: "var(--plum)" }} />
      )}
      <span className="text-[11px] font-medium">{name}</span>
      <button
        type="button"
        aria-label="프로필 삭제"
        className={`cursor-pointer ml-0.5 transition-all duration-fast
          ${confirmDelete
            ? "text-[10px] text-error font-medium opacity-100"
            : "text-xs text-text-dim/40 opacity-100 md:opacity-0 md:group-hover:opacity-100 hover:text-error"
          }`}
        onClick={handleDelete}
      >
        {confirmDelete ? "삭제?" : <>&times;</>}
      </button>
    </div>
  );
}
