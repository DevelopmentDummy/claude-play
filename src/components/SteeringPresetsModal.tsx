"use client";

import { useState, useEffect, useCallback, useRef, useLayoutEffect } from "react";
import {
  loadPresets,
  addPreset,
  updatePreset,
  deletePreset,
  getSelectedPresetId,
  setSelectedPresetId,
  type SteeringPreset,
} from "@/lib/autoplay";

interface SteeringPresetsModalProps {
  open: boolean;
  onClose: () => void;
  onPresetChange: (preset: SteeringPreset | null) => void;
}

type EditTarget = { mode: "create" } | { mode: "edit"; id: string } | null;

export default function SteeringPresetsModal({ open, onClose, onPresetChange }: SteeringPresetsModalProps) {
  const [presets, setPresets] = useState<SteeringPreset[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<EditTarget>(null);
  const [name, setName] = useState("");
  const [instruction, setInstruction] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setPresets(loadPresets());
      setSelectedId(getSelectedPresetId());
      setEditTarget(null);
      setConfirmDeleteId(null);
    }
  }, [open]);

  const handleSelect = useCallback((id: string | null) => {
    setSelectedId(id);
    setSelectedPresetId(id);
    const preset = id ? loadPresets().find((p) => p.id === id) || null : null;
    onPresetChange(preset);
  }, [onPresetChange]);

  const handleStartCreate = useCallback(() => {
    setEditTarget({ mode: "create" });
    setName("");
    setInstruction("");
    setConfirmDeleteId(null);
  }, []);

  const handleStartEdit = useCallback((preset: SteeringPreset) => {
    setEditTarget({ mode: "edit", id: preset.id });
    setName(preset.name);
    setInstruction(preset.instruction);
    setConfirmDeleteId(null);
  }, []);

  const handleCancel = useCallback(() => {
    setEditTarget(null);
  }, []);

  const handleSave = useCallback(() => {
    if (!editTarget || !name.trim()) return;
    if (editTarget.mode === "create") {
      const created = addPreset(name.trim(), instruction.trim());
      setPresets(loadPresets());
      handleSelect(created.id);
    } else {
      updatePreset(editTarget.id, { name: name.trim(), instruction: instruction.trim() });
      setPresets(loadPresets());
      if (editTarget.id === selectedId) {
        const updated = loadPresets().find((p) => p.id === editTarget.id) || null;
        onPresetChange(updated);
      }
    }
    setEditTarget(null);
  }, [editTarget, name, instruction, selectedId, handleSelect, onPresetChange]);

  const handleDelete = useCallback((id: string) => {
    deletePreset(id);
    setPresets(loadPresets());
    setConfirmDeleteId(null);
    if (editTarget?.mode === "edit" && editTarget.id === id) setEditTarget(null);
    if (selectedId === id) handleSelect(null);
  }, [editTarget, selectedId, handleSelect]);

  // ESC: cancel edit first, then close modal. Ctrl/Cmd+Enter: save when editing.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (confirmDeleteId) {
          setConfirmDeleteId(null);
          e.stopPropagation();
          return;
        }
        if (editTarget) {
          handleCancel();
          e.stopPropagation();
          return;
        }
        onClose();
      } else if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && editTarget && name.trim()) {
        handleSave();
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, editTarget, confirmDeleteId, name, handleCancel, handleSave, onClose]);

  if (!open) return null;

  const renderEditForm = () => (
    <EditForm
      key={editTarget?.mode === "edit" ? editTarget.id : "create"}
      name={name}
      instruction={instruction}
      onNameChange={setName}
      onInstructionChange={setInstruction}
      onCancel={handleCancel}
      onSave={handleSave}
      isCreate={editTarget?.mode === "create"}
    />
  );

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative bg-surface border border-border rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-text">스티어링 프리셋</h2>
            <span className="text-xs text-text-dim/60 tabular-nums">{presets.length}</span>
          </div>
          <div className="flex items-center gap-1">
            {!editTarget && (
              <button
                onClick={handleStartCreate}
                className="px-2.5 py-1 rounded-lg text-xs text-accent hover:text-accent-hover border border-accent/30 hover:border-accent/60 hover:bg-[rgba(var(--accent-rgb),0.08)] transition-all flex items-center gap-1"
                title="새 프리셋 추가"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" className="w-3.5 h-3.5">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                새 프리셋
              </button>
            )}
            <button
              onClick={onClose}
              className="w-7 h-7 flex items-center justify-center text-text-dim hover:text-text hover:bg-white/5 rounded-lg transition-colors text-lg leading-none"
              title="닫기 (Esc)"
            >
              &times;
            </button>
          </div>
        </div>

        {/* Body — single scroll area */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-2.5">
          {/* Default (no preset) */}
          <button
            onClick={() => handleSelect(null)}
            className={`w-full text-left px-4 py-3 rounded-xl border transition-all ${
              selectedId === null
                ? "border-accent bg-[rgba(var(--accent-rgb),0.1)] text-text"
                : "border-border/50 bg-transparent text-text-dim hover:border-border hover:text-text"
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">기본 (방향성 없음)</span>
              {selectedId === null && <SelectedDot />}
            </div>
            <div className="text-xs text-text-dim mt-1">AI가 자유롭게 다음 턴을 진행합니다</div>
          </button>

          {/* Inline create form sits at the top of the list */}
          <Expandable open={editTarget?.mode === "create"}>
            <div className="pt-0.5">{editTarget?.mode === "create" && renderEditForm()}</div>
          </Expandable>

          {/* Preset list */}
          {presets.map((preset) => {
            const isEditingThis = editTarget?.mode === "edit" && editTarget.id === preset.id;
            const isSelected = selectedId === preset.id;
            return (
              <div
                key={preset.id}
                className={`relative rounded-xl border transition-all ${
                  isEditingThis
                    ? "border-accent/60 bg-[rgba(var(--accent-rgb),0.06)] shadow-[0_0_0_1px_rgba(var(--accent-rgb),0.25)]"
                    : isSelected
                      ? "border-accent bg-[rgba(var(--accent-rgb),0.1)]"
                      : "border-border/50 bg-transparent hover:border-border"
                }`}
              >
                <div className="flex items-start gap-3 px-4 py-3">
                  <button
                    className="flex-1 text-left min-w-0"
                    onClick={() => handleSelect(preset.id)}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-text truncate">{preset.name}</span>
                      {isSelected && <SelectedDot />}
                    </div>
                    {!isEditingThis && (
                      <div className="text-xs text-text-dim mt-1 line-clamp-2">{preset.instruction || "(비어있음)"}</div>
                    )}
                  </button>
                  <div className="flex gap-1 shrink-0">
                    <button
                      onClick={() => (isEditingThis ? handleCancel() : handleStartEdit(preset))}
                      className={`w-7 h-7 flex items-center justify-center rounded-lg transition-all text-xs ${
                        isEditingThis
                          ? "text-accent bg-[rgba(var(--accent-rgb),0.15)]"
                          : "text-text-dim/60 hover:text-text hover:bg-white/5"
                      }`}
                      title={isEditingThis ? "편집 닫기" : "편집"}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                      </svg>
                    </button>
                    {confirmDeleteId === preset.id ? (
                      <button
                        onClick={() => handleDelete(preset.id)}
                        onMouseLeave={() => setConfirmDeleteId(null)}
                        className="px-2 h-7 flex items-center justify-center rounded-lg text-red-400 bg-red-500/15 hover:bg-red-500/25 text-[10px] font-semibold tracking-wide transition-colors"
                        title="다시 클릭하여 삭제"
                      >
                        삭제?
                      </button>
                    ) : (
                      <button
                        onClick={() => setConfirmDeleteId(preset.id)}
                        className="w-7 h-7 flex items-center justify-center rounded-lg text-text-dim/40 hover:text-red-400 hover:bg-red-500/10 transition-all text-xs"
                        title="삭제"
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                      </button>
                    )}
                  </div>
                </div>

                {/* Inline edit form for THIS preset */}
                <Expandable open={isEditingThis}>
                  <div className="px-4 pb-4 pt-1">{isEditingThis && renderEditForm()}</div>
                </Expandable>
              </div>
            );
          })}

          {presets.length === 0 && editTarget?.mode !== "create" && (
            <div className="text-center py-8 text-xs text-text-dim/70">
              아직 프리셋이 없습니다. 우측 상단의 <span className="text-accent">+ 새 프리셋</span> 으로 추가하세요.
            </div>
          )}
        </div>

        {/* Footer hint */}
        <div className="px-5 py-2.5 border-t border-border/60 flex items-center justify-between text-[11px] text-text-dim/50">
          <span>
            <kbd className="px-1.5 py-0.5 rounded bg-white/5 border border-border/40 text-text-dim">Esc</kbd>
            <span className="mx-1.5">취소/닫기</span>
            <span className="opacity-50">·</span>
            <kbd className="px-1.5 py-0.5 rounded bg-white/5 border border-border/40 text-text-dim ml-1.5">Ctrl</kbd>
            <span className="mx-1">+</span>
            <kbd className="px-1.5 py-0.5 rounded bg-white/5 border border-border/40 text-text-dim">Enter</kbd>
            <span className="ml-1.5">저장</span>
          </span>
          {editTarget && <span className="text-accent/70">편집 중</span>}
        </div>
      </div>
    </div>
  );
}

function SelectedDot() {
  return <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent shadow-[0_0_6px_rgba(var(--accent-rgb),0.8)]" />;
}

interface EditFormProps {
  name: string;
  instruction: string;
  onNameChange: (v: string) => void;
  onInstructionChange: (v: string) => void;
  onCancel: () => void;
  onSave: () => void;
  isCreate: boolean;
}

function EditForm({ name, instruction, onNameChange, onInstructionChange, onCancel, onSave, isCreate }: EditFormProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  // Auto-resize textarea — grows freely, never shows its own scrollbar.
  // Outer modal body is the single scroll area.
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    ta.style.height = ta.scrollHeight + "px";
  }, [instruction]);

  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);

  return (
    <div className="rounded-xl border border-accent/30 bg-[rgba(var(--accent-rgb),0.04)] p-3.5 space-y-2.5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-[0.14em] text-accent/80 font-semibold">
          {isCreate ? "새 프리셋" : "프리셋 편집"}
        </span>
      </div>
      <input
        ref={nameRef}
        type="text"
        value={name}
        onChange={(e) => onNameChange(e.target.value)}
        placeholder="프리셋 이름"
        className="w-full px-3 py-2 rounded-lg border border-border bg-[rgba(15,15,26,0.6)] text-text text-sm outline-none focus:border-accent transition-colors"
      />
      <textarea
        ref={textareaRef}
        value={instruction}
        onChange={(e) => onInstructionChange(e.target.value)}
        placeholder="방향성 지시문을 입력하세요...&#10;예: 긴장감 있는 전투 상황으로 전개해주세요"
        rows={3}
        className="w-full px-3 py-2 rounded-lg border border-border bg-[rgba(15,15,26,0.6)] text-text text-sm outline-none resize-none focus:border-accent transition-colors leading-relaxed"
      />
      <div className="flex justify-end gap-2 pt-0.5">
        <button
          onClick={onCancel}
          className="px-3 py-1.5 rounded-lg text-sm text-text-dim hover:text-text border border-border/50 hover:border-border transition-all"
        >
          취소
        </button>
        <button
          onClick={onSave}
          disabled={!name.trim()}
          className="px-3.5 py-1.5 rounded-lg text-sm text-white bg-accent hover:bg-accent-hover transition-all disabled:opacity-40 disabled:cursor-not-allowed"
        >
          저장
        </button>
      </div>
    </div>
  );
}

interface ExpandableProps {
  open: boolean;
  children: React.ReactNode;
}

/**
 * Smooth height-based expand/collapse using grid-rows trick — no inner scrollbars,
 * so the body scroll stays as the single scroll area.
 */
function Expandable({ open, children }: ExpandableProps) {
  return (
    <div
      className="grid transition-[grid-template-rows,opacity] duration-200 ease-out"
      style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0 }}
      aria-hidden={!open}
    >
      <div className="overflow-hidden min-h-0">{children}</div>
    </div>
  );
}
