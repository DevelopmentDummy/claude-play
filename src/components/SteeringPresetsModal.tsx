"use client";

import { useState, useEffect, useCallback } from "react";
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

export default function SteeringPresetsModal({ open, onClose, onPresetChange }: SteeringPresetsModalProps) {
  const [presets, setPresets] = useState<SteeringPreset[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [name, setName] = useState("");
  const [instruction, setInstruction] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setPresets(loadPresets());
      setSelectedId(getSelectedPresetId());
      setEditingId(null);
      setIsCreating(false);
    }
  }, [open]);

  const handleSelect = useCallback((id: string | null) => {
    setSelectedId(id);
    setSelectedPresetId(id);
    const preset = id ? loadPresets().find((p) => p.id === id) || null : null;
    onPresetChange(preset);
  }, [onPresetChange]);

  const handleStartCreate = () => {
    setIsCreating(true);
    setEditingId(null);
    setName("");
    setInstruction("");
  };

  const handleStartEdit = (preset: SteeringPreset) => {
    setIsCreating(false);
    setEditingId(preset.id);
    setName(preset.name);
    setInstruction(preset.instruction);
  };

  const handleSave = () => {
    if (!name.trim()) return;
    if (isCreating) {
      const newPreset = addPreset(name.trim(), instruction.trim());
      setPresets(loadPresets());
      handleSelect(newPreset.id);
      setIsCreating(false);
    } else if (editingId) {
      updatePreset(editingId, { name: name.trim(), instruction: instruction.trim() });
      setPresets(loadPresets());
      // Refresh selection if editing the selected preset
      if (editingId === selectedId) {
        const updated = loadPresets().find((p) => p.id === editingId) || null;
        onPresetChange(updated);
      }
      setEditingId(null);
    }
  };

  const handleDelete = (id: string) => {
    deletePreset(id);
    setPresets(loadPresets());
    setConfirmDeleteId(null);
    if (editingId === id) setEditingId(null);
    if (selectedId === id) handleSelect(null);
  };

  const handleCancel = () => {
    setIsCreating(false);
    setEditingId(null);
  };

  if (!open) return null;

  const isEditing = isCreating || editingId !== null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative bg-surface border border-border rounded-2xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-base font-semibold text-text">스티어링 프리셋</h2>
          <button onClick={onClose} className="text-text-dim hover:text-text transition-colors text-lg leading-none">&times;</button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {/* Default (no preset) */}
          <button
            onClick={() => handleSelect(null)}
            className={`w-full text-left px-4 py-3 rounded-xl border transition-all ${
              selectedId === null
                ? "border-accent bg-[rgba(var(--accent-rgb),0.1)] text-text"
                : "border-border/50 bg-transparent text-text-dim hover:border-border hover:text-text"
            }`}
          >
            <div className="text-sm font-medium">기본 (방향성 없음)</div>
            <div className="text-xs text-text-dim mt-1">AI가 자유롭게 다음 턴을 진행합니다</div>
          </button>

          {/* Preset list */}
          {presets.map((preset) => (
            <div
              key={preset.id}
              className={`relative px-4 py-3 rounded-xl border transition-all ${
                selectedId === preset.id
                  ? "border-accent bg-[rgba(var(--accent-rgb),0.1)]"
                  : "border-border/50 bg-transparent hover:border-border"
              }`}
            >
              <div className="flex items-start gap-3">
                <button
                  className="flex-1 text-left min-w-0"
                  onClick={() => handleSelect(preset.id)}
                >
                  <div className="text-sm font-medium text-text truncate">{preset.name}</div>
                  <div className="text-xs text-text-dim mt-1 line-clamp-2">{preset.instruction || "(비어있음)"}</div>
                </button>
                <div className="flex gap-1 shrink-0">
                  <button
                    onClick={() => handleStartEdit(preset)}
                    className="w-7 h-7 flex items-center justify-center rounded-lg text-text-dim/60 hover:text-text hover:bg-white/5 transition-all text-xs"
                    title="편집"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                  </button>
                  {confirmDeleteId === preset.id ? (
                    <button
                      onClick={() => handleDelete(preset.id)}
                      className="w-7 h-7 flex items-center justify-center rounded-lg text-red-400 bg-red-500/15 text-xs font-medium"
                    >
                      !!
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
            </div>
          ))}

          {/* Edit / Create form */}
          {isEditing && (
            <div className="border border-accent/40 rounded-xl p-4 space-y-3 bg-[rgba(var(--accent-rgb),0.03)]">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="프리셋 이름"
                className="w-full px-3 py-2 rounded-lg border border-border bg-[rgba(15,15,26,0.6)] text-text text-sm outline-none focus:border-accent"
                autoFocus
              />
              <textarea
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                placeholder="방향성 지시문을 입력하세요...&#10;예: 긴장감 있는 전투 상황으로 전개해주세요"
                rows={5}
                className="w-full px-3 py-2 rounded-lg border border-border bg-[rgba(15,15,26,0.6)] text-text text-sm outline-none resize-none focus:border-accent"
              />
              <div className="flex justify-end gap-2">
                <button
                  onClick={handleCancel}
                  className="px-3 py-1.5 rounded-lg text-sm text-text-dim hover:text-text border border-border/50 hover:border-border transition-all"
                >
                  취소
                </button>
                <button
                  onClick={handleSave}
                  disabled={!name.trim()}
                  className="px-3 py-1.5 rounded-lg text-sm text-white bg-accent hover:bg-accent-hover transition-all disabled:opacity-50"
                >
                  저장
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-between items-center px-5 py-3 border-t border-border">
          {!isEditing && (
            <button
              onClick={handleStartCreate}
              className="px-3 py-1.5 rounded-lg text-sm text-accent hover:text-accent-hover border border-accent/30 hover:border-accent/60 transition-all"
            >
              + 새 프리셋
            </button>
          )}
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg text-sm text-text-dim hover:text-text border border-border/50 hover:border-border transition-all"
          >
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}
