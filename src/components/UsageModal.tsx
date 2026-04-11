"use client";

import { useState, useEffect } from "react";
import { createPortal } from "react-dom";

interface UsageWindow {
  name: string;
  utilization: number;
  resetsAt: string;
  timeProgress: number;
}

interface UsageData {
  provider: string;
  windows: UsageWindow[];
  extraUsage?: {
    isEnabled: boolean;
    monthlyLimit: number;
    usedCredits: number;
    utilization: number | null;
  };
  error?: string;
}

function formatRemaining(resetsAt: string): string {
  const diff = new Date(resetsAt).getTime() - Date.now();
  if (diff <= 0) return "리셋 완료";
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (h > 24) {
    const d = Math.floor(h / 24);
    const rh = h % 24;
    return `${d}일 ${rh}시간 후 리셋`;
  }
  return h > 0 ? `${h}시간 ${m}분 후 리셋` : `${m}분 후 리셋`;
}

function gaugeColor(remain: number, expectedRemain: number): {
  bar: string;
  label: string;
} {
  if (remain < expectedRemain) {
    // 기대보다 적게 남음
    return remain < expectedRemain - 10
      ? { bar: "bg-red-500", label: "text-red-400" }
      : { bar: "bg-yellow-500", label: "text-yellow-400" };
  }
  return { bar: "bg-emerald-500", label: "text-emerald-400" };
}

function UsageGauge({ window: w }: { window: UsageWindow }) {
  const remain = 100 - w.utilization;
  const expectedRemain = 100 - w.timeProgress;
  const colors = gaugeColor(remain, expectedRemain);

  return (
    <div className="mb-4">
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-xs font-medium text-text">{w.name}</span>
        <span className={`text-xs font-mono ${colors.label}`}>
          {Math.round(remain)}% 남음
        </span>
      </div>
      {/* Gauge bar — 배터리 스타일 (잔여량) */}
      <div className="relative h-5 rounded-full bg-surface-light overflow-hidden">
        {/* 잔여량 바 */}
        <div
          className={`absolute inset-y-0 left-0 rounded-full ${colors.bar} transition-all duration-500`}
          style={{ width: `${Math.max(remain, 0)}%`, opacity: 0.85 }}
        />
        {/* 타임 레퍼런스 오버레이 (마커 왼쪽 = 위험 구간) */}
        {expectedRemain > 0 && expectedRemain < 100 && (
          <>
            <div
              className="absolute inset-y-0 left-0 bg-red-500/15 z-10"
              style={{ width: `${expectedRemain}%` }}
            />
            <div
              className="absolute inset-y-0 w-0.5 bg-white/50 z-10"
              style={{ left: `${expectedRemain}%` }}
            />
          </>
        )}
      </div>
      <div className="flex justify-between mt-1">
        <span className="text-[10px] text-text-dim">
          사용 {Math.round(w.utilization)}%
        </span>
        <span className="text-[10px] text-text-dim">
          {formatRemaining(w.resetsAt)}
        </span>
      </div>
    </div>
  );
}

const PROVIDER_COLORS: Record<string, string> = {
  claude: "#ff9f43",
  codex: "#4dff91",
  gemini: "#64b5f6",
};

const PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
};

interface UsageModalProps {
  onClose: () => void;
  provider?: "claude" | "codex" | "gemini";
  sessionId?: string;
}

export default function UsageModal({ onClose, provider = "claude", sessionId }: UsageModalProps) {
  const [results, setResults] = useState<UsageData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const params = new URLSearchParams({ provider });
    if (sessionId) params.set("sessionId", sessionId);

    fetch(`/api/usage?${params}`)
      .then((r) => r.json())
      .then((d) => setResults([d]))
      .catch(() => setResults([{ provider, windows: [], error: "요청 실패" }]))
      .finally(() => setLoading(false));
  }, [provider, sessionId]);

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-[380px] max-h-[80vh] overflow-y-auto rounded-xl border border-border/60 bg-[rgba(20,16,32,0.97)] shadow-[0_8px_32px_rgba(0,0,0,0.5)] p-5">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-text">사용량</h2>
          <button
            onClick={onClose}
            className="text-text-dim hover:text-text text-lg leading-none transition-colors"
          >
            &times;
          </button>
        </div>

        {loading && (
          <div className="text-center py-8 text-text-dim text-xs">로딩 중...</div>
        )}

        {!loading && results.map((data) => (
          <div key={data.provider} className="mb-5 last:mb-0">
            {/* Provider badge */}
            <div className="flex items-center gap-2 mb-3">
              <span
                className="inline-block w-2 h-2 rounded-full"
                style={{ backgroundColor: PROVIDER_COLORS[data.provider] || "#888" }}
              />
              <span className="text-xs text-text-dim">
                {PROVIDER_LABELS[data.provider] || data.provider}
              </span>
            </div>

            {data.error && (
              <div className="text-xs text-red-400 mb-2">{data.error}</div>
            )}

            {!data.error && data.windows.map((w) => (
              <UsageGauge key={`${data.provider}-${w.name}`} window={w} />
            ))}

            {data.extraUsage?.isEnabled && (
              <div className="mt-2 pt-2 border-t border-border/40">
                <div className="flex items-baseline justify-between">
                  <span className="text-xs text-text-dim">추가 사용</span>
                  <span className="text-xs font-mono text-text-dim">
                    ${data.extraUsage.usedCredits.toFixed(2)} / ${data.extraUsage.monthlyLimit.toLocaleString()}
                  </span>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>,
    document.body
  );
}
