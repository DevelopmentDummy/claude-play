"use client";

import { useState, useEffect, useCallback } from "react";

interface SyncItem {
  key: string;
  label: string;
  hasChanges: boolean;
}

type Direction = "forward" | "reverse";
type VariablesMode = "merge" | "overwrite" | "skip";

interface SyncModalProps {
  open: boolean;
  sessionId: string;
  onClose: () => void;
  onSynced: () => void;
}

export default function SyncModal({ open, sessionId, onClose, onSynced }: SyncModalProps) {
  const [direction, setDirection] = useState<Direction>("forward");
  const [items, setItems] = useState<SyncItem[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [variablesMode, setVariablesMode] = useState<VariablesMode>("merge");
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);

  // Fetch diff when opened or direction changes
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetch(`/api/sessions/${sessionId}/sync?direction=${direction}`)
      .then((r) => r.json())
      .then((data) => {
        const diff = (data.diff || []) as SyncItem[];
        setItems(diff);
        const initial: Record<string, boolean> = {};
        for (const item of diff) {
          initial[item.key] = item.hasChanges;
        }
        setSelected(initial);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [open, sessionId, direction]);

  // Reset variablesMode when direction changes
  useEffect(() => {
    setVariablesMode("merge");
  }, [direction]);

  const toggle = useCallback((key: string) => {
    setSelected((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const selectAll = useCallback(() => {
    setSelected((prev) => {
      const all: Record<string, boolean> = {};
      for (const key of Object.keys(prev)) all[key] = true;
      return all;
    });
  }, []);

  const selectNone = useCallback(() => {
    setSelected((prev) => {
      const none: Record<string, boolean> = {};
      for (const key of Object.keys(prev)) none[key] = false;
      return none;
    });
  }, []);

  const handleSync = useCallback(async () => {
    setSyncing(true);
    try {
      const effectiveElements = { ...selected };
      if (direction === "reverse" && variablesMode === "skip") {
        effectiveElements.variables = false;
      }

      const res = await fetch(`/api/sessions/${sessionId}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          elements: effectiveElements,
          direction,
          ...(direction === "reverse" && selected.variables ? { variablesMode } : {}),
        }),
      });
      if (res.ok) {
        // Only notify AI for forward sync (reverse doesn't change session files)
        if (direction === "forward") {
          onSynced();
        }
        onClose();
      }
    } finally {
      setSyncing(false);
    }
  }, [sessionId, selected, direction, variablesMode, onSynced, onClose]);

  const anySelected = Object.values(selected).some(Boolean);
  const effectiveSelection = direction === "reverse" && variablesMode === "skip"
    ? Object.entries(selected).some(([k, v]) => v && k !== "variables")
    : anySelected;

  if (!open) return null;

  const isReverse = direction === "reverse";

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-[8px] flex items-center justify-center z-[100]"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-surface border border-border/70 rounded-2xl w-[420px] max-w-[92vw] max-h-[80vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-5 pt-5 pb-3 border-b border-border/40">
          <h3 className="text-sm font-semibold text-text">동기화</h3>
          {/* Direction toggle */}
          <div className="flex mt-2.5 rounded-lg overflow-hidden border border-border/50">
            <button
              onClick={() => setDirection("forward")}
              className={`flex-1 py-1.5 text-[11px] font-medium transition-all cursor-pointer
                ${!isReverse
                  ? "bg-accent/15 text-accent border-r border-accent/30"
                  : "bg-transparent text-text-dim/60 border-r border-border/30 hover:text-text-dim hover:bg-surface-light/50"
                }`}
            >
              페르소나 → 세션
            </button>
            <button
              onClick={() => setDirection("reverse")}
              className={`flex-1 py-1.5 text-[11px] font-medium transition-all cursor-pointer
                ${isReverse
                  ? "bg-accent/15 text-accent"
                  : "bg-transparent text-text-dim/60 hover:text-text-dim hover:bg-surface-light/50"
                }`}
            >
              세션 → 페르소나
            </button>
          </div>
          <p className="text-[11px] text-text-dim/60 mt-2">
            {isReverse
              ? "세션에서 변경된 내용을 페르소나에 반영합니다."
              : "페르소나의 최신 파일을 세션에 반영합니다."
            }
          </p>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="w-5 h-5 rounded-full border-2 border-accent/40 border-t-transparent animate-spin" />
            </div>
          ) : (
            <>
              <div className="flex gap-2 mb-3">
                <button
                  onClick={selectAll}
                  className="text-[10px] text-text-dim/60 hover:text-text cursor-pointer transition-colors"
                >
                  전체 선택
                </button>
                <span className="text-[10px] text-text-dim/30">|</span>
                <button
                  onClick={selectNone}
                  className="text-[10px] text-text-dim/60 hover:text-text cursor-pointer transition-colors"
                >
                  선택 해제
                </button>
              </div>
              <div className="flex flex-col gap-1">
                {items.map((item) => (
                  <div key={item.key}>
                    <label
                      className={`flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-all duration-fast
                        ${selected[item.key]
                          ? "bg-accent/8 border border-accent/25"
                          : "bg-transparent border border-transparent hover:bg-surface-light/50"
                        }`}
                    >
                      <input
                        type="checkbox"
                        checked={!!selected[item.key]}
                        onChange={() => toggle(item.key)}
                        className="w-3.5 h-3.5 rounded accent-[var(--accent)] cursor-pointer"
                      />
                      <span className="flex-1 text-[13px] text-text">{item.label}</span>
                      {item.hasChanges ? (
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-yellow-500/15 text-yellow-400 border border-yellow-500/20">
                          변경됨
                        </span>
                      ) : (
                        <span className="text-[10px] text-text-dim/40">동일</span>
                      )}
                    </label>
                    {/* Variables mode sub-options (reverse sync only) */}
                    {isReverse && item.key === "variables" && selected.variables && (
                      <div className="ml-9 mt-1 mb-1 flex flex-col gap-1">
                        {([
                          { value: "merge" as const, label: "추가된 값만 추가" },
                          { value: "overwrite" as const, label: "세션 값으로 덮어쓰기" },
                          { value: "skip" as const, label: "변수 동기화 안 함" },
                        ]).map((opt) => (
                          <label
                            key={opt.value}
                            className="flex items-center gap-2 px-2 py-1 rounded cursor-pointer hover:bg-surface-light/30 transition-colors"
                          >
                            <input
                              type="radio"
                              name="variablesMode"
                              value={opt.value}
                              checked={variablesMode === opt.value}
                              onChange={() => setVariablesMode(opt.value)}
                              className="w-3 h-3 accent-[var(--accent)] cursor-pointer"
                            />
                            <span className="text-[11px] text-text-dim">{opt.label}</span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-border/40 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-xs text-text-dim border border-border/60 bg-transparent
              cursor-pointer hover:bg-surface-light hover:text-text transition-all duration-fast"
          >
            취소
          </button>
          <button
            disabled={!effectiveSelection || syncing}
            onClick={handleSync}
            className="px-4 py-2 rounded-lg text-xs font-medium text-white bg-accent border border-accent
              cursor-pointer hover:bg-accent-hover transition-all duration-fast
              disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {syncing ? "동기화 중..." : "동기화"}
          </button>
        </div>
      </div>
    </div>
  );
}
