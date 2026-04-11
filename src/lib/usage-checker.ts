// src/lib/usage-checker.ts
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ── 공통 인터페이스 (서비스 불문) ──────────────────────────
export interface UsageWindow {
  name: string;           // "5시간" | "7일" | "7일 (Sonnet)" 등
  utilization: number;    // 0-100
  resetsAt: string;       // ISO 8601
  timeProgress: number;   // 0-100
}

export interface UsageResponse {
  provider: "claude" | "codex" | "gemini";
  windows: UsageWindow[];
  extraUsage?: {
    isEnabled: boolean;
    monthlyLimit: number;
    usedCredits: number;
    utilization: number | null;
  };
  error?: string;
}

// ── 캐시 ──────────────────────────────────────────────────
const CACHE_TTL_MS = 30_000;
let cachedResult: UsageResponse | null = null;
let cachedAt = 0;

// ── Anthropic raw 응답 타입 ────────────────────────────────
interface RawWindow {
  utilization: number;
  resets_at: string;
}

interface RawUsageResponse {
  five_hour?: RawWindow;
  seven_day?: RawWindow;
  seven_day_sonnet?: RawWindow;
  seven_day_opus?: RawWindow;
  seven_day_cowork?: RawWindow;
  extra_usage?: {
    is_enabled: boolean;
    monthly_limit: number;
    used_credits: number;
    utilization: number | null;
  };
}

// ── 윈도우 duration 매핑 (ms) ──────────────────────────────
const WINDOW_DURATIONS: Record<string, { label: string; durationMs: number }> = {
  five_hour:        { label: "5시간",          durationMs: 5 * 60 * 60 * 1000 },
  seven_day:        { label: "7일",            durationMs: 7 * 24 * 60 * 60 * 1000 },
  seven_day_sonnet: { label: "7일 (Sonnet)",   durationMs: 7 * 24 * 60 * 60 * 1000 },
  seven_day_opus:   { label: "7일 (Opus)",     durationMs: 7 * 24 * 60 * 60 * 1000 },
  seven_day_cowork: { label: "7일 (Cowork)",   durationMs: 7 * 24 * 60 * 60 * 1000 },
};

function computeTimeProgress(resetsAt: string, durationMs: number): number {
  const now = Date.now();
  const resetTime = new Date(resetsAt).getTime();
  const startTime = resetTime - durationMs;
  if (now <= startTime) return 0;
  if (now >= resetTime) return 100;
  return Math.round(((now - startTime) / durationMs) * 100);
}

function readAccessToken(): string | null {
  try {
    const credPath = path.join(os.homedir(), ".claude", ".credentials.json");
    const raw = fs.readFileSync(credPath, "utf-8");
    const creds = JSON.parse(raw);
    return creds?.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

export async function getClaudeUsage(): Promise<UsageResponse> {
  if (cachedResult && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedResult;
  }

  const token = readAccessToken();
  if (!token) {
    return { provider: "claude", windows: [], error: "OAuth 토큰을 찾을 수 없습니다" };
  }

  try {
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
    });

    if (!res.ok) {
      const msg = res.status === 429
        ? "사용량 API 호출 제한 (잠시 후 다시 시도)"
        : `API 오류 (${res.status})`;
      return { provider: "claude", windows: [], error: msg };
    }

    const raw: RawUsageResponse = await res.json();

    const windows: UsageWindow[] = [];
    for (const [key, meta] of Object.entries(WINDOW_DURATIONS)) {
      const w = raw[key as keyof RawUsageResponse] as RawWindow | undefined | null;
      if (!w || w.utilization == null) continue;
      windows.push({
        name: meta.label,
        utilization: w.utilization,
        resetsAt: w.resets_at,
        timeProgress: computeTimeProgress(w.resets_at, meta.durationMs),
      });
    }

    const result: UsageResponse = { provider: "claude", windows };

    if (raw.extra_usage) {
      result.extraUsage = {
        isEnabled: raw.extra_usage.is_enabled,
        monthlyLimit: raw.extra_usage.monthly_limit,
        usedCredits: raw.extra_usage.used_credits,
        utilization: raw.extra_usage.utilization,
      };
    }

    cachedResult = result;
    cachedAt = Date.now();
    return result;
  } catch (err) {
    return {
      provider: "claude",
      windows: [],
      error: `네트워크 오류: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
