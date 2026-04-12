"use client";

import { useRef, useState, useCallback, useEffect } from "react";

interface ClonePersonaDialogProps {
  open: boolean;
  sourceName: string;
  onClose: () => void;
  onCloned: (newName: string) => void;
}

export default function ClonePersonaDialog({
  open,
  sourceName,
  onClose,
  onCloned,
}: ClonePersonaDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setError(null);
      setChecking(false);
      setBusy(false);
      // Pre-fill with source name + "-copy"
      setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.value = `${sourceName}-copy`;
          inputRef.current.select();
        }
      }, 0);
    }
  }, [open, sourceName]);

  const checkAvailability = useCallback((name: string) => {
    if (checkTimer.current) clearTimeout(checkTimer.current);
    if (!name.trim()) { setError(null); return; }
    setChecking(true);
    checkTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/personas/${encodeURIComponent(sourceName)}/clone?folderName=${encodeURIComponent(name.trim())}`
        );
        const data = await res.json();
        setError(data.available ? null : "이미 존재하는 폴더명입니다.");
      } catch {
        setError(null);
      } finally {
        setChecking(false);
      }
    }, 300);
  }, [sourceName]);

  const handleClone = useCallback(async () => {
    const name = inputRef.current?.value.trim();
    if (!name || error || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/personas/${encodeURIComponent(sourceName)}/clone`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderName: name }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "복제 실패");
        return;
      }
      onCloned(data.name);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "복제 실패");
    } finally {
      setBusy(false);
    }
  }, [sourceName, error, busy, onCloned, onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") handleClone();
      else if (e.key === "Escape") onClose();
    },
    [handleClone, onClose]
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-[8px] flex items-center justify-center z-[100]">
      <div className="bg-surface backdrop-blur-[16px] border border-border rounded-2xl p-6 px-7 w-[380px] flex flex-col gap-3.5 shadow-lg animate-[slideUp_0.25s_ease-out]">
        <h3 className="text-base font-semibold">페르소나 복제</h3>
        <p className="text-xs text-text-dim -mt-1">
          <span className="font-mono text-accent/80">{sourceName}</span>을(를) 복제합니다.
        </p>
        <input
          ref={inputRef}
          type="text"
          placeholder="새 폴더명 (영문, 소문자)"
          className="px-3.5 py-2.5 border border-border rounded-[10px] bg-[rgba(15,15,26,0.6)] text-text font-[inherit] text-sm outline-none transition-all duration-fast focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-glow)]"
          onKeyDown={handleKeyDown}
          onChange={(e) => checkAvailability(e.target.value)}
          autoFocus
        />
        {error && (
          <p className="text-xs text-error -mt-1 ml-1">{error}</p>
        )}
        {checking && (
          <p className="text-xs text-text-dim -mt-1 ml-1">확인 중...</p>
        )}
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1 border border-border rounded-md bg-transparent text-text-dim cursor-pointer text-xs hover:bg-surface-light hover:text-text transition-all duration-fast"
          >
            취소
          </button>
          <button
            onClick={handleClone}
            disabled={busy || !!error || checking}
            className="px-3 py-1 border border-accent rounded-md bg-accent text-white cursor-pointer text-xs shadow-[0_2px_12px_var(--accent-glow)] hover:bg-accent-hover hover:-translate-y-px transition-all duration-fast disabled:opacity-50 disabled:pointer-events-none"
          >
            {busy ? "복제 중..." : "복제"}
          </button>
        </div>
      </div>
    </div>
  );
}
