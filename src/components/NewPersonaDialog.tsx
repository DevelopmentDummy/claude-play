"use client";

import { useRef, useState, useCallback } from "react";
import { MODEL_GROUPS } from "@/lib/ai-provider";

interface NewPersonaDialogProps {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string, model?: string) => void;
}

export default function NewPersonaDialog({
  open,
  onClose,
  onCreate,
}: NewPersonaDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedModel, setSelectedModel] = useState("opus[1m]:medium");

  const handleOk = useCallback(() => {
    const name = inputRef.current?.value
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-");
    if (!name) return;
    onCreate(name, selectedModel || undefined);
    onClose();
  }, [onCreate, onClose, selectedModel]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") handleOk();
      else if (e.key === "Escape") onClose();
    },
    [handleOk, onClose]
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-[8px] flex items-center justify-center z-[100]">
      <div className="bg-surface backdrop-blur-[16px] border border-border rounded-2xl p-6 px-7 w-[380px] flex flex-col gap-3.5 shadow-lg animate-[slideUp_0.25s_ease-out]">
        <h3 className="text-base font-semibold">New Persona</h3>
        <input
          ref={inputRef}
          type="text"
          placeholder="Persona folder name (english, lowercase)"
          className="px-3.5 py-2.5 border border-border rounded-[10px] bg-[rgba(15,15,26,0.6)] text-text font-[inherit] text-sm outline-none transition-all duration-fast focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-glow)]"
          onKeyDown={handleKeyDown}
          autoFocus
        />
        <select
          value={selectedModel}
          onChange={(e) => setSelectedModel(e.target.value)}
          className="px-3.5 py-2.5 border border-border rounded-[10px] bg-[rgba(15,15,26,0.6)] text-text font-[inherit] text-sm outline-none transition-all duration-fast focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-glow)] cursor-pointer"
        >
          {MODEL_GROUPS.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.options.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
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
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
