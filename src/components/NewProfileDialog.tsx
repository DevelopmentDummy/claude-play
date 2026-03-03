"use client";

import { useRef, useCallback } from "react";

interface NewProfileDialogProps {
  open: boolean;
  onClose: () => void;
  onSave: (name: string, description: string) => void;
}

export default function NewProfileDialog({
  open,
  onClose,
  onSave,
}: NewProfileDialogProps) {
  const nameRef = useRef<HTMLInputElement>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);

  const handleOk = useCallback(() => {
    const name = nameRef.current?.value.trim();
    const description = descRef.current?.value.trim() || "";
    if (!name) return;
    onSave(name, description);
    onClose();
  }, [onSave, onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose]
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-[8px] flex items-center justify-center z-[100]">
      <div
        className="bg-surface backdrop-blur-[16px] border border-border rounded-2xl p-6 px-7 w-[420px] flex flex-col gap-3.5 shadow-lg animate-[slideUp_0.25s_ease-out]"
        onKeyDown={handleKeyDown}
      >
        <h3 className="text-base font-semibold">New Profile</h3>
        <input
          ref={nameRef}
          type="text"
          placeholder="Name (e.g. 카이엔, Kai)"
          className="px-3.5 py-2.5 border border-border rounded-[10px] bg-[rgba(15,15,26,0.6)] text-text font-[inherit] text-sm outline-none transition-all duration-fast focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-glow)]"
          autoFocus
        />
        <textarea
          ref={descRef}
          placeholder="Description (character background for AI)"
          rows={4}
          className="px-3.5 py-2.5 border border-border rounded-[10px] bg-[rgba(15,15,26,0.6)] text-text font-[inherit] text-sm outline-none resize-y transition-all duration-fast focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-glow)]"
        />
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1 border border-border rounded-md bg-transparent text-text-dim cursor-pointer text-xs hover:bg-surface-light hover:text-text transition-all duration-fast"
          >
            Cancel
          </button>
          <button
            onClick={handleOk}
            className="px-3 py-1 border border-accent rounded-md bg-accent text-white cursor-pointer text-xs shadow-[0_2px_12px_var(--accent-glow)] hover:bg-accent-hover hover:-translate-y-px transition-all duration-fast"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
