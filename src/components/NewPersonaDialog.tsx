"use client";

import { useRef, useState, useCallback } from "react";
import ModelSelect from "@/components/ModelSelect";
import { useFocusTrap } from "@/hooks/useFocusTrap";

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
  const panelRef = useFocusTrap<HTMLDivElement>({ active: open, initialFocus: false });
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedModel, setSelectedModel] = useState("claude-opus-5[1m]:ultracode");

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
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label="New Persona"
        className="bg-surface backdrop-blur-[16px] border border-border rounded-2xl p-6 px-7 w-[380px] max-w-[92vw] flex flex-col gap-3.5 shadow-lg animate-[slideUp_0.25s_ease-out]">
        <h3 className="text-base font-semibold">New Persona</h3>
        <input
          ref={inputRef}
          type="text"
          placeholder="Persona folder name (english, lowercase)"
          className="px-3.5 py-2.5 border border-border rounded-[10px] bg-[rgba(15,15,26,0.6)] text-text font-[inherit] text-sm outline-none transition-all duration-fast focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-glow)]"
          onKeyDown={handleKeyDown}
          autoFocus
        />
        <label className="text-xs text-text-dim ml-1">빌더 모델</label>
        <ModelSelect value={selectedModel} onChange={setSelectedModel} />
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
