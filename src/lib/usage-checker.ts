import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { CodexProcess } from "./codex-process";

// ── 공통 인터페이스 (서비스 불문) ──────────────────────────
export interface UsageWindow {
  name: string;           // "5시간" | "7일" | "7일 (Sonnet)" 등
  utilization: number;    // 0-100
  resetsAt: string;       // ISO 8601
  timeProgress: number;   // 0-100
}

export interface UsageResponse {
  provider: "claude" | "codex" | "gemini" | "antigravity";
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
const execFileAsync = promisify(execFile);

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

// ── Antigravity ───────────────────────────────────────────

interface AntigravityCredentialBlob {
  token?: {
    access_token?: string;
  };
}

interface AntigravityLoadCodeAssistResponse {
  cloudaicompanionProject?: unknown;
}

interface AntigravityModelQuotaInfo {
  remainingFraction?: number;
  resetTime?: string;
}

interface AntigravityModelInfo {
  displayName?: string;
  isInternal?: boolean;
  quotaInfo?: AntigravityModelQuotaInfo;
}

interface AntigravityModelsResponse {
  models?: Record<string, AntigravityModelInfo>;
}

type AntigravityFamily = "flash" | "pro" | "claude" | "gpt";

const ANTIGRAVITY_FAMILY_META: Record<AntigravityFamily, { label: string; durationMs: number; order: number }> = {
  flash: { label: "Flash", durationMs: 5 * 60 * 60 * 1000, order: 0 },
  pro: { label: "Pro", durationMs: 5 * 60 * 60 * 1000, order: 1 },
  claude: { label: "Claude", durationMs: 24 * 60 * 60 * 1000, order: 2 },
  gpt: { label: "GPT-OSS", durationMs: 24 * 60 * 60 * 1000, order: 3 },
};

function antigravityFamily(modelId: string): AntigravityFamily | null {
  if (modelId.includes("flash")) return "flash";
  if (modelId.includes("pro")) return "pro";
  if (modelId.startsWith("claude-")) return "claude";
  if (modelId.startsWith("gpt-")) return "gpt";
  return null;
}

function pickProjectId(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.id === "string") return record.id;
    if (typeof record.name === "string") return record.name;
  }
  return null;
}

async function readAntigravityAccessToken(): Promise<string | null> {
  if (process.platform !== "win32") return null;

  const script = `
$code = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class CredReader {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct CREDENTIAL {
    public UInt32 Flags;
    public UInt32 Type;
    public string TargetName;
    public string Comment;
    public long LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  [DllImport("Advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredRead(string target, int type, int reservedFlag, out IntPtr credentialPtr);

  [DllImport("Advapi32.dll", SetLastError = true)]
  private static extern void CredFree(IntPtr buffer);

  public static string Read(string target) {
    IntPtr credentialPtr;
    if (!CredRead(target, 1, 0, out credentialPtr)) return null;
    try {
      CREDENTIAL credential = (CREDENTIAL)Marshal.PtrToStructure(credentialPtr, typeof(CREDENTIAL));
      if (credential.CredentialBlob == IntPtr.Zero || credential.CredentialBlobSize == 0) return null;
      byte[] bytes = new byte[credential.CredentialBlobSize];
      Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length);
      return Encoding.UTF8.GetString(bytes).TrimEnd('\\0');
    } finally {
      CredFree(credentialPtr);
    }
  }
}
'@
Add-Type -TypeDefinition $code
$blob = [CredReader]::Read('gemini:antigravity')
if ($null -ne $blob) { [Console]::Out.Write($blob) }
`;

  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
    ], { timeout: 10_000, windowsHide: true });
    const raw = stdout.trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AntigravityCredentialBlob;
    return parsed.token?.access_token ?? null;
  } catch {
    return null;
  }
}

async function fetchAntigravityUsage(token: string): Promise<UsageResponse> {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": "antigravity",
  };

  const loadRes = await fetch("https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", {
    method: "POST",
    headers,
    body: JSON.stringify({
      metadata: {
        ideType: "ANTIGRAVITY",
        platform: "PLATFORM_UNSPECIFIED",
        pluginType: "GEMINI",
      },
    }),
  });

  if (!loadRes.ok) {
    const msg = loadRes.status === 401
      ? "Antigravity 토큰 만료 (agy를 한 번 실행해 갱신 필요)"
      : loadRes.status === 403
        ? "Antigravity 권한 부족 (agy 본인 토큰 필요)"
        : `Antigravity API 오류 (${loadRes.status})`;
    return { provider: "antigravity", windows: [], error: msg };
  }

  const loadRaw = await loadRes.json() as AntigravityLoadCodeAssistResponse;
  const project = pickProjectId(loadRaw.cloudaicompanionProject);
  if (!project) {
    return { provider: "antigravity", windows: [], error: "Antigravity 프로젝트를 찾을 수 없습니다" };
  }

  const modelsRes = await fetch("https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels", {
    method: "POST",
    headers,
    body: JSON.stringify({ project }),
  });

  if (!modelsRes.ok) {
    const msg = modelsRes.status === 401
      ? "Antigravity 토큰 만료 (agy를 한 번 실행해 갱신 필요)"
      : modelsRes.status === 403
        ? "Antigravity 권한 부족 (agy 본인 토큰 필요)"
        : `Antigravity 모델 API 오류 (${modelsRes.status})`;
    return { provider: "antigravity", windows: [], error: msg };
  }

  const raw = await modelsRes.json() as AntigravityModelsResponse;
  const familyMap = new Map<AntigravityFamily, { remainingFraction: number; resetTime: string }>();

  for (const [modelId, model] of Object.entries(raw.models ?? {})) {
    if (model.isInternal || !model.displayName) continue;
    const remainingFraction = model.quotaInfo?.remainingFraction;
    if (typeof remainingFraction !== "number") continue;
    const family = antigravityFamily(modelId);
    if (!family) continue;

    const resetTime = model.quotaInfo?.resetTime || new Date().toISOString();
    const existing = familyMap.get(family);
    if (!existing || remainingFraction < existing.remainingFraction) {
      familyMap.set(family, { remainingFraction, resetTime });
    }
  }

  const windows = [...familyMap.entries()]
    .sort((a, b) => ANTIGRAVITY_FAMILY_META[a[0]].order - ANTIGRAVITY_FAMILY_META[b[0]].order)
    .map(([family, quota]) => {
      const meta = ANTIGRAVITY_FAMILY_META[family];
      return {
        name: meta.label,
        utilization: Math.round((1 - quota.remainingFraction) * 100),
        resetsAt: quota.resetTime,
        timeProgress: computeTimeProgress(quota.resetTime, meta.durationMs),
      };
    });

  if (!windows.length) {
    return { provider: "antigravity", windows: [], error: "Antigravity 사용량 데이터 없음" };
  }

  return { provider: "antigravity", windows };
}

export async function getAntigravityUsage(): Promise<UsageResponse> {
  const cached = getCached("antigravity");
  if (cached) return cached;

  const token = await readAntigravityAccessToken();
  if (token) {
    try {
      return setCache("antigravity", await fetchAntigravityUsage(token));
    } catch (err) {
      return {
        provider: "antigravity",
        windows: [],
        error: `Antigravity 조회 실패: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const legacy = await getGeminiUsage();
  return setCache("antigravity", {
    ...legacy,
    provider: "antigravity",
    error: legacy.error ? `Antigravity 토큰 없음, Gemini fallback 실패: ${legacy.error}` : undefined,
  });
}
