import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { CodexProcess } from "./codex-process";

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
const cache: Record<string, { result: UsageResponse; at: number }> = {};

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

function getCached(key: string): UsageResponse | null {
  const entry = cache[key];
  if (entry && Date.now() - entry.at < CACHE_TTL_MS) return entry.result;
  return null;
}

function setCache(key: string, result: UsageResponse): UsageResponse {
  cache[key] = { result, at: Date.now() };
  return result;
}

export async function getClaudeUsage(): Promise<UsageResponse> {
  const cached = getCached("claude");
  if (cached) return cached;

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

    return setCache("claude", result);
  } catch (err) {
    return {
      provider: "claude",
      windows: [],
      error: `네트워크 오류: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── Codex ──────────────────────────────────────────────────

interface CodexRateLimitBucket {
  limitId: string;
  limitName: string | null;
  primary: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null;
  secondary: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null;
}

interface CodexRateLimitsResult {
  rateLimitsByLimitId?: Record<string, CodexRateLimitBucket>;
}

export async function getCodexUsage(process: CodexProcess): Promise<UsageResponse> {
  const cached = getCached("codex");
  if (cached) return cached;

  if (!process.isRunning()) {
    return { provider: "codex", windows: [], error: "Codex 세션이 실행 중이 아닙니다" };
  }

  try {
    const raw = await process.getRateLimits() as CodexRateLimitsResult | null;
    if (!raw?.rateLimitsByLimitId) {
      return { provider: "codex", windows: [], error: "사용량 데이터를 가져올 수 없습니다" };
    }

    const windows: UsageWindow[] = [];
    for (const [, bucket] of Object.entries(raw.rateLimitsByLimitId)) {
      const label = bucket.limitName || bucket.limitId;

      // Primary window (5시간)
      const p = bucket.primary;
      if (p && p.usedPercent != null) {
        const durationMs = p.windowDurationMins * 60 * 1000;
        const resetsAt = new Date(p.resetsAt * 1000).toISOString();
        const h = Math.round(p.windowDurationMins / 60);
        windows.push({
          name: `${h}시간`,
          utilization: p.usedPercent,
          resetsAt,
          timeProgress: computeTimeProgress(resetsAt, durationMs),
        });
      }

      // Secondary window (7일)
      const s = bucket.secondary;
      if (s && s.usedPercent != null) {
        const durationMs = s.windowDurationMins * 60 * 1000;
        const resetsAt = new Date(s.resetsAt * 1000).toISOString();
        const d = Math.round(s.windowDurationMins / 60 / 24);
        windows.push({
          name: `${d}일`,
          utilization: s.usedPercent,
          resetsAt,
          timeProgress: computeTimeProgress(resetsAt, durationMs),
        });
      }
    }

    return setCache("codex", { provider: "codex", windows });
  } catch (err) {
    return {
      provider: "codex",
      windows: [],
      error: `Codex 조회 실패: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── Gemini ─────────────────────────────────────────────────

interface GeminiQuotaBucket {
  resetTime: string;
  tokenType: string;
  modelId: string;
  remainingFraction: number;
}

interface GeminiQuotaResponse {
  buckets?: GeminiQuotaBucket[];
}

function readGeminiAccessToken(): string | null {
  try {
    const credPath = path.join(os.homedir(), ".gemini", "oauth_creds.json");
    const raw = fs.readFileSync(credPath, "utf-8");
    const creds = JSON.parse(raw);
    return creds?.access_token ?? null;
  } catch {
    return null;
  }
}

function readGeminiProjectId(): string | null {
  try {
    const projPath = path.join(os.homedir(), ".gemini", "projects.json");
    const raw = fs.readFileSync(projPath, "utf-8");
    const data = JSON.parse(raw);
    // projects는 { "dir": "projectId" } 형태. 첫 번째 값 사용
    const projects = data?.projects;
    if (!projects || typeof projects !== "object") return null;
    const values = Object.values(projects) as string[];
    return values[0] || null;
  } catch {
    return null;
  }
}

/** 모델 ID에서 티어를 추출 (flash-lite / flash / pro) */
function getModelTier(modelId: string): string {
  if (modelId.includes("flash-lite")) return "Flash Lite";
  if (modelId.includes("flash")) return "Flash";
  if (modelId.includes("pro")) return "Pro";
  return modelId;
}

export async function getGeminiUsage(): Promise<UsageResponse> {
  const cached = getCached("gemini");
  if (cached) return cached;

  const token = readGeminiAccessToken();
  if (!token) {
    return { provider: "gemini", windows: [], error: "Gemini OAuth 토큰을 찾을 수 없습니다" };
  }

  const projectId = readGeminiProjectId();

  try {
    const res = await fetch("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(projectId ? { project: projectId } : {}),
    });

    if (!res.ok) {
      const msg = res.status === 401
        ? "Gemini 토큰 만료 (CLI에서 재인증 필요)"
        : `API 오류 (${res.status})`;
      return { provider: "gemini", windows: [], error: msg };
    }

    const raw: GeminiQuotaResponse = await res.json();
    if (!raw.buckets?.length) {
      return { provider: "gemini", windows: [], error: "사용량 데이터 없음" };
    }

    // 티어별로 그룹화 (같은 티어는 사용량 공유이므로 하나만 표시)
    const TIER_ORDER = ["Flash Lite", "Flash", "Pro"];
    const tierMap = new Map<string, GeminiQuotaBucket>();
    for (const b of raw.buckets) {
      if (b.tokenType !== "REQUESTS") continue;
      const tier = getModelTier(b.modelId);
      if (!tierMap.has(tier)) {
        tierMap.set(tier, b);
      }
    }

    const windows: UsageWindow[] = [];
    const durationMs = 24 * 60 * 60 * 1000;

    const sortedTiers = [...tierMap.entries()].sort((a, b) => {
      const ai = TIER_ORDER.indexOf(a[0]);
      const bi = TIER_ORDER.indexOf(b[0]);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

    for (const [tier, b] of sortedTiers) {
      windows.push({
        name: tier,
        utilization: Math.round((1 - b.remainingFraction) * 100),
        resetsAt: b.resetTime,
        timeProgress: computeTimeProgress(b.resetTime, durationMs),
      });
    }

    return setCache("gemini", { provider: "gemini", windows });
  } catch (err) {
    return {
      provider: "gemini",
      windows: [],
      error: `Gemini 조회 실패: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
