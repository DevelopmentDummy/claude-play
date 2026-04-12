"use client";

import { useState, useEffect, useCallback } from "react";

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

/** 미니 배터리 게이지 (잔여량 표시) */
function MiniGauge({ utilization, timeProgress }: { utilization: number; timeProgress: number }) {
  const remain = 100 - utilization;        // 남은 %
  const expectedRemain = 100 - timeProgress; // 시간 기준 기대 잔여

  // 악센트 컬러 기반: 상태에 따라 투명도로 위험도 표현
  let barOpacity: number;
  if (remain < expectedRemain) {
    barOpacity = remain < expectedRemain - 10 ? 0.25 : 0.5;
  } else {
    barOpacity = 1;
  }

  return (
    <span className="inline-flex items-center w-[28px] h-[10px] rounded-sm bg-surface-light overflow-hidden relative">
      {/* 잔여량 바 (왼쪽부터 채움, 줄어들수록 위험) */}
      <span
        className="absolute inset-y-0 left-0 rounded-sm"
        style={{
          backgroundColor: "var(--accent, #34d399)",
          opacity: barOpacity,
          width: `${Math.max(remain, 0)}%`,
        }}
      />
      {/* 타임 레퍼런스 마커 (기대 잔여 위치) */}
      {expectedRemain > 0 && expectedRemain < 100 && (
        <span
          className="absolute top-0 bottom-0 z-10 bg-white"
          style={{ left: `${expectedRemain}%`, width: "2px", marginLeft: "-1px" }}
        />
      )}
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
  // Claude / Codex: "5시간" → "5h", "7일 (Sonnet)" → "7d(s)", "7일" → "7d"
  const hourMatch = name.match(/(\d+)\s*시간/);
  if (hourMatch) return `${hourMatch[1]}h`;
  const dayMatch = name.match(/(\d+)\s*일(?:\s*\((\w)\w*\))?/);
  if (dayMatch) return dayMatch[2] ? `${dayMatch[1]}d(${dayMatch[2].toLowerCase()})` : `${dayMatch[1]}d`;
  return name.slice(0, 3);
}

const REFRESH_COOLDOWN_MS = 300_000; // 5분 쿨다운

// Provider별 글로벌 캐시 — 세션 이동해도 데이터 유지, 쿨다운 공유
const globalCache = new Map<string, { data: UsageData; fetchedAt: number }>();

interface UsageIndicatorProps {
  provider: "claude" | "codex" | "gemini";
  sessionId?: string;
  /** 변경될 때마다 갱신 트리거 (예: 대화 종료 시 카운터 증가) */
  refreshTrigger?: number;
  onClick?: () => void;
}

export default function UsageIndicator({ provider, sessionId, refreshTrigger, onClick }: UsageIndicatorProps) {
  const cached = globalCache.get(provider);
  const [data, setData] = useState<UsageData | null>(cached?.data ?? null);

  const doFetch = useCallback((force = false) => {
    const entry = globalCache.get(provider);
    if (!force && entry && Date.now() - entry.fetchedAt < REFRESH_COOLDOWN_MS) return;

    const params = new URLSearchParams({ provider });
    if (sessionId) params.set("sessionId", sessionId);

    fetch(`/api/usage?${params}`)
      .then((r) => r.json())
      .then((d: UsageData) => {
        if (d.error) {
          globalCache.delete(provider);
        } else {
          globalCache.set(provider, { data: d, fetchedAt: Date.now() });
        }
        setData(d);
      })
      .catch(() => { globalCache.delete(provider); });
  }, [provider, sessionId]);

  // 마운트 시 캐시 있으면 그대로 사용, 없거나 만료면 fetch
  useEffect(() => {
    const entry = globalCache.get(provider);
    if (entry) {
      setData(entry.data);
      if (Date.now() - entry.fetchedAt >= REFRESH_COOLDOWN_MS) doFetch(true);
    } else {
      doFetch(true);
    }
  }, [provider]); // eslint-disable-line react-hooks/exhaustive-deps

  // 대화 종료 시 갱신 (refreshTrigger 변경, 쿨다운 적용)
  useEffect(() => {
    if (refreshTrigger !== undefined && refreshTrigger > 0) {
      doFetch();
    }
  }, [refreshTrigger, doFetch]);

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
