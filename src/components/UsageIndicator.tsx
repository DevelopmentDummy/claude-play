"use client";

import { useState, useEffect, useCallback, useRef } from "react";

interface UsageWindow {
  name: string;
  utilization: number;
  resetsAt: string;
  timeProgress: number;
}

interface UsageData {
  provider: string;
  windows: UsageWindow[];
  error?: string;
}

/** 미니 게이지 바 */
function MiniGauge({ utilization, timeProgress }: { utilization: number; timeProgress: number }) {
  const ratio = timeProgress > 0 ? utilization / timeProgress : (utilization > 0 ? 2 : 0);
  const barColor = ratio > 1.2 ? "bg-red-400" : ratio > 0.8 ? "bg-yellow-400" : "bg-emerald-400";

  return (
    <span className="inline-flex items-center w-[28px] h-[8px] rounded-sm bg-surface-light overflow-hidden">
      <span
        className={`h-full rounded-sm ${barColor}`}
        style={{ width: `${Math.min(utilization, 100)}%` }}
      />
    </span>
  );
}

/** 윈도우 이름을 짧은 라벨로 변환 */
function shortLabel(name: string, provider: string): string {
  if (provider === "gemini") {
    if (name === "Flash Lite") return "FL";
    if (name === "Flash") return "F";
    if (name === "Pro") return "P";
    return name.slice(0, 2).toUpperCase();
  }
  // Claude / Codex: "5시간" → "5h", "7일" → "7d"
  const hourMatch = name.match(/(\d+)\s*시간/);
  if (hourMatch) return `${hourMatch[1]}h`;
  const dayMatch = name.match(/(\d+)\s*일/);
  if (dayMatch) return `${dayMatch[1]}d`;
  return name.slice(0, 3);
}

const REFRESH_COOLDOWN_MS = 60_000; // 1분 쿨다운

interface UsageIndicatorProps {
  provider: "claude" | "codex" | "gemini";
  sessionId?: string;
  /** 변경될 때마다 갱신 트리거 (예: 대화 종료 시 카운터 증가) */
  refreshTrigger?: number;
  onClick?: () => void;
}

export default function UsageIndicator({ provider, sessionId, refreshTrigger, onClick }: UsageIndicatorProps) {
  const [data, setData] = useState<UsageData | null>(null);
  const lastFetchRef = useRef(0);

  const fetchUsage = useCallback(() => {
    const now = Date.now();
    if (now - lastFetchRef.current < REFRESH_COOLDOWN_MS) return;
    lastFetchRef.current = now;

    const params = new URLSearchParams({ provider });
    if (sessionId) params.set("sessionId", sessionId);

    fetch(`/api/usage?${params}`)
      .then((r) => r.json())
      .then((d) => setData(d))
      .catch(() => null);
  }, [provider, sessionId]);

  // 초기 로드
  useEffect(() => { fetchUsage(); }, [fetchUsage]);

  // 대화 종료 시 갱신 (refreshTrigger 변경)
  useEffect(() => {
    if (refreshTrigger !== undefined && refreshTrigger > 0) {
      fetchUsage();
    }
  }, [refreshTrigger, fetchUsage]);

  if (!data || data.error || !data.windows.length) return null;

  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 px-1.5 py-0.5 rounded text-[10px] text-text-dim hover:bg-surface-light transition-colors cursor-pointer"
      title="사용량 상세 보기"
    >
      {data.windows.map((w) => (
        <span key={w.name} className="flex items-center gap-0.5">
          <span className="opacity-60">{shortLabel(w.name, data.provider)}</span>
          <MiniGauge utilization={w.utilization} timeProgress={w.timeProgress} />
        </span>
      ))}
    </button>
  );
}
