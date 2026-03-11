"use client";

import { useState, useCallback, useMemo } from "react";

interface OptionSchema {
  key: string;
  label: string;
  description?: string;
  type: "boolean" | "slider" | "select" | "text" | "number";
  default: unknown;
  scope: "session" | "builder" | "both";
  target: "prompt" | "frontend" | "both";
  group: string;
  // slider
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  // select
  choices?: { value: string; label: string }[];
}

interface ChatOptionsModalProps {
  schema: OptionSchema[];
  values: Record<string, unknown>;
  onApply: (values: Record<string, unknown>) => void;
  onClose: () => void;
}

export default function ChatOptionsModal({ schema, values, onApply, onClose }: ChatOptionsModalProps) {
  const [draft, setDraft] = useState<Record<string, unknown>>({ ...values });

  const groups = useMemo(() => {
    const map = new Map<string, OptionSchema[]>();
    for (const opt of schema) {
      const list = map.get(opt.group) || [];
      list.push(opt);
      map.set(opt.group, list);
    }
    return Array.from(map.entries());
  }, [schema]);

  const hasPromptChanges = useMemo(() => {
    return schema.some(
      (o) =>
        (o.target === "prompt" || o.target === "both") &&
        draft[o.key] !== values[o.key]
    );
  }, [schema, draft, values]);

  const hasChanges = useMemo(() => {
    return schema.some((o) => draft[o.key] !== values[o.key]);
  }, [schema, draft, values]);

  const setValue = useCallback((key: string, val: unknown) => {
    setDraft((prev) => ({ ...prev, [key]: val }));
  }, []);

  const handleApply = useCallback(() => {
    onApply(draft);
  }, [draft, onApply]);

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-surface border border-border rounded-xl w-full max-w-md max-h-[80vh] flex flex-col shadow-lg">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-text">채팅 옵션</h2>
          <button
            onClick={onClose}
            className="text-text-dim hover:text-text text-lg leading-none cursor-pointer"
          >
            &times;
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {groups.map(([group, opts]) => (
            <div key={group}>
              <h3 className="text-xs font-semibold text-text-dim uppercase tracking-wider mb-3">
                {group}
              </h3>
              <div className="space-y-3">
                {opts.map((opt) => (
                  <OptionRow
                    key={opt.key}
                    opt={opt}
                    value={draft[opt.key] ?? opt.default}
                    onChange={(val) => setValue(opt.key, val)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs text-text-dim border border-border rounded-md cursor-pointer hover:bg-surface-light transition-all"
          >
            취소
          </button>
          <button
            onClick={handleApply}
            disabled={!hasChanges}
            className={`px-4 py-1.5 text-xs rounded-md cursor-pointer transition-all ${
              hasChanges
                ? "text-white bg-accent border border-accent hover:bg-accent-hover"
                : "text-text-dim bg-surface-light border border-border opacity-50 cursor-not-allowed"
            }`}
          >
            {hasPromptChanges ? "적용 (재시작)" : "적용"}
          </button>
        </div>
      </div>
    </div>
  );
}

function OptionRow({
  opt,
  value,
  onChange,
}: {
  opt: OptionSchema;
  value: unknown;
  onChange: (val: unknown) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm text-text">{opt.label}</span>
          {opt.target === "prompt" && (
            <span className="text-[10px] text-amber-400/70" title="변경 시 세션 재시작">
              &#9889;
            </span>
          )}
        </div>
        {opt.description && (
          <p className="text-xs text-text-dim mt-0.5 truncate">{opt.description}</p>
        )}
      </div>
      <div className="shrink-0">
        {opt.type === "boolean" && (
          <button
            onClick={() => onChange(!value)}
            className={`w-10 h-5 rounded-full relative cursor-pointer transition-colors ${
              value ? "bg-accent" : "bg-border"
            }`}
          >
            <span
              className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                value ? "left-[22px]" : "left-0.5"
              }`}
            />
          </button>
        )}
        {opt.type === "slider" && (
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={opt.min}
              max={opt.max}
              step={opt.step}
              value={value as number}
              onChange={(e) => onChange(Number(e.target.value))}
              className="w-24 accent-accent"
            />
            <span className="text-xs text-text-dim w-14 text-right">
              {value as number}{opt.unit ? opt.unit : ""}
            </span>
          </div>
        )}
        {opt.type === "select" && opt.choices && (
          <select
            value={value as string}
            onChange={(e) => onChange(e.target.value)}
            className="px-2 py-1 text-xs text-text bg-transparent border border-border rounded-md outline-none cursor-pointer"
          >
            {opt.choices.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        )}
        {opt.type === "number" && (
          <input
            type="number"
            value={value as number}
            min={opt.min}
            max={opt.max}
            step={opt.step}
            onChange={(e) => onChange(Number(e.target.value))}
            className="w-20 px-2 py-1 text-xs text-text bg-transparent border border-border rounded-md outline-none"
          />
        )}
        {opt.type === "text" && (
          <input
            type="text"
            value={value as string}
            onChange={(e) => onChange(e.target.value)}
            className="w-32 px-2 py-1 text-xs text-text bg-transparent border border-border rounded-md outline-none"
          />
        )}
      </div>
    </div>
  );
}
