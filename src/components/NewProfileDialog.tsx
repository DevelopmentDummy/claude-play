"use client";

import { useRef, useCallback, useEffect, useState } from "react";

interface NewProfileDialogProps {
  open: boolean;
  onClose: () => void;
  onSave: (name: string, description: string, isPrimary?: boolean) => void;
  editData?: { name: string; description: string; isPrimary?: boolean } | null;
  /** When true, Cancel and ESC are disabled (first-time profile creation) */
  required?: boolean;
}

export default function NewProfileDialog({
  open,
  onClose,
  onSave,
  editData,
  required,
}: NewProfileDialogProps) {
  const nameRef = useRef<HTMLInputElement>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);
  const [isPrimary, setIsPrimary] = useState(false);

  useEffect(() => {
    if (open && editData) {
      if (nameRef.current) nameRef.current.value = editData.name;
      if (descRef.current) descRef.current.value = editData.description;
      setIsPrimary(!!editData.isPrimary);
    } else if (open) {
      if (nameRef.current) nameRef.current.value = "";
      if (descRef.current) descRef.current.value = "";
      setIsPrimary(false);
    }
  }, [open, editData]);

  const handleOk = useCallback(() => {
    const name = nameRef.current?.value.trim();
    const description = descRef.current?.value.trim() || "";
    if (!name) return;
    onSave(name, description, isPrimary || undefined);
    onClose();
  }, [onSave, onClose, isPrimary]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape" && !required) onClose();
    },
    [onClose, required]
  );

  if (!open) return null;

  const isEdit = !!editData;

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-[8px] flex items-center justify-center z-[100]">
      <div
        className="bg-surface backdrop-blur-[16px] border border-border rounded-2xl p-6 px-7 w-[440px] flex flex-col gap-4 shadow-lg animate-[slideUp_0.25s_ease-out]"
        onKeyDown={handleKeyDown}
      >
        <h3 className="text-lg font-semibold">{isEdit ? "Edit Profile" : "Create Your Profile"}</h3>
        <p className="text-sm text-text-dim -mt-2">
          {isEdit ? "" : "AI가 당신을 알아볼 수 있도록 프로필을 만들어주세요."}
        </p>
        <input
          ref={nameRef}
          type="text"
          placeholder="닉네임 (e.g. 민지, Alex)"
          className="px-4 py-3 border border-border rounded-xl bg-[rgba(15,15,26,0.6)] text-text font-[inherit] text-sm outline-none transition-all duration-fast focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-glow)]"
          autoFocus
        />
        <textarea
          ref={descRef}
          placeholder="자기소개 — 성격, 관심사, 말투 등 AI에게 알려주고 싶은 것들"
          rows={4}
          className="px-4 py-3 border border-border rounded-xl bg-[rgba(15,15,26,0.6)] text-text font-[inherit] text-sm outline-none resize-y transition-all duration-fast focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-glow)]"
        />

        {/* Primary profile toggle */}
        <label className="flex items-center gap-3 px-1 cursor-pointer group">
          <button
            type="button"
            role="switch"
            aria-checked={isPrimary}
            onClick={() => setIsPrimary(!isPrimary)}
            className={`relative w-9 h-5 rounded-full transition-all duration-fast shrink-0 ${
              isPrimary
                ? "bg-accent shadow-[0_0_8px_var(--accent-glow)]"
                : "bg-border/60"
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform duration-fast shadow-sm ${
                isPrimary ? "translate-x-4" : "translate-x-0"
              }`}
            />
          </button>
          <div>
            <span className="text-sm text-text group-hover:text-text transition-colors">
              Primary profile
            </span>
            <p className="text-[11px] text-text-dim/50 mt-0.5">
              Auto-selected when starting new sessions
            </p>
          </div>
        </label>

        <div className="flex justify-end gap-2.5 mt-1">
          {!required && (
            <button
              onClick={onClose}
              className="px-4 py-2 border border-border rounded-lg bg-transparent text-text-dim cursor-pointer text-sm hover:bg-surface-light hover:text-text transition-all duration-fast"
            >
              Cancel
            </button>
          )}
          <button
            onClick={handleOk}
            className="px-4 py-2 border border-accent rounded-lg bg-accent text-white cursor-pointer text-sm font-medium shadow-[0_2px_12px_var(--accent-glow)] hover:bg-accent-hover hover:-translate-y-px transition-all duration-fast"
          >
            {isEdit ? "Save" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
