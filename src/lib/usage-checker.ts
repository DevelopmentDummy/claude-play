import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { CodexProcess } from "./codex-process";

// ── 공통 인터페이스 (서비스 불문) ──────────────────────────
export interface UsageWindow {
  key: string;            // "five_hour" | "weekly_scoped_fable" 등 안정 식별자
  name: string;           // "5시간" | "7일" | "7일 (Sonnet)" 등
  utilization: number;    // 0-100
  resetsAt: string;       // ISO 8601 ("" = 리셋 시각 미제공)
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
  resets_at?: string | null;
}

// 2026-07 신형 스키마: limits 배열이 1차 소스 (top-level 모델 키는 null로 올 수 있음)
interface RawLimit {
  kind: string;
  group: string;
  percent: number;
  resets_at?: string | null;
  scope?: { model?: { display_name?: string | null } | null } | null;
}

interface RawUsageResponse {
  five_hour?: RawWindow | null;
  seven_day?: RawWindow | null;
  seven_day_sonnet?: RawWindow | null;
  seven_day_opus?: RawWindow | null;
  seven_day_cowork?: RawWindow | null;
  limits?: RawLimit[] | null;
  extra_usage?: {
    is_enabled: boolean;
    /** 최소 화폐 단위 정수 (decimal_places 참고). USD면 센트. */
    monthly_limit: number;
    /** 최소 화폐 단위 정수 (decimal_places 참고). USD면 센트. */
    used_credits: number;
    utilization: number | null;
    currency?: string;
    /** 소수 자릿수. USD=2 → 위 값들을 100으로 나눠야 실제 금액. 미제공 시 2로 가정. */
    decimal_places?: number;
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

const HOUR_MS = 60 * 60 * 1000;
const HOUR5_MS = 5 * HOUR_MS;
const DAY7_MS = 7 * 24 * HOUR_MS;

/** resets_at이 없는 윈도우는 리셋 시각 미제공("") + 진행률 100으로 처리 */
function windowFromReset(
  key: string,
  name: string,
  utilization: number,
  resetsAt: string | null | undefined,
  durationMs: number
): UsageWindow {
  if (!resetsAt) {
    return { key, name, utilization, resetsAt: "", timeProgress: 100 };
  }
  return { key, name, utilization, resetsAt, timeProgress: computeTimeProgress(resetsAt, durationMs) };
}

/** 신형 limits 배열 → 윈도우 매핑 (session=5시간, weekly_all=7일, weekly_scoped=7일 (모델명)) */
function windowsFromLimits(limits: RawLimit[]): UsageWindow[] {
  const windows: UsageWindow[] = [];
  for (const l of limits) {
    if (l.percent == null) continue;
    if (l.group === "session") {
      windows.push(windowFromReset("five_hour", "5시간", l.percent, l.resets_at, HOUR5_MS));
    } else if (l.group === "weekly") {
      if (l.kind === "weekly_all") {
        windows.push(windowFromReset("seven_day", "7일", l.percent, l.resets_at, DAY7_MS));
      } else {
        const model = l.scope?.model?.display_name;
        if (!model) continue;
        windows.push(windowFromReset(
          `weekly_scoped_${model.toLowerCase().replace(/ /g, "_")}`,
          `7일 (${model})`,
          l.percent,
          l.resets_at,
          DAY7_MS
        ));
      }
    }
    // 그 외 group(monthly 등 미지 항목)은 표시하지 않음
  }
  return windows;
}

/** Anthropic raw 응답 → 윈도우 목록. limits 배열이 있으면 우선, 없으면 구형 top-level 키 폴백 */
export function mapClaudeWindows(raw: RawUsageResponse): UsageWindow[] {
  if (raw.limits?.length) {
    const windows = windowsFromLimits(raw.limits);
    if (windows.length) return windows;
  }
  const windows: UsageWindow[] = [];
  for (const [key, meta] of Object.entries(WINDOW_DURATIONS)) {
    const w = raw[key as keyof RawUsageResponse] as RawWindow | undefined | null;
    if (!w || w.utilization == null) continue;
    windows.push(windowFromReset(key, meta.label, w.utilization, w.resets_at, meta.durationMs));
  }
  return windows;
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

// 업스트림 usage API가 응답 없이 매달리면 /api/usage 라우트가 hang 되고,
// Cloudflare 터널이 520 + HTML 에러 페이지를 대신 반환한다. 그 HTML을
// 프론트가 JSON으로 파싱하다 "Unexpected token '<'"로 터진다.
// 타임아웃을 걸어 라우트가 매달리지 않고 즉시 JSON 에러를 돌려주게 한다.
async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 8000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function getClaudeUsage(): Promise<UsageResponse> {
  const cached = getCached("claude");
  if (cached) return cached;

  const token = readAccessToken();
  if (!token) {
    return { provider: "claude", windows: [], error: "OAuth 토큰을 찾을 수 없습니다" };
  }

  try {
    const res = await fetchWithTimeout("https://api.anthropic.com/api/oauth/usage", {
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

    const result: UsageResponse = { provider: "claude", windows: mapClaudeWindows(raw) };

    if (raw.extra_usage) {
      // API는 금액을 최소 화폐 단위 정수로 준다 (USD: 14306 = $143.06).
      // decimal_places를 무시하고 원본을 그대로 표시하면 100배로 부풀려진다.
      const divisor = 10 ** (raw.extra_usage.decimal_places ?? 2);
      result.extraUsage = {
        isEnabled: raw.extra_usage.is_enabled,
        monthlyLimit: raw.extra_usage.monthly_limit / divisor,
        usedCredits: raw.extra_usage.used_credits / divisor,
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
    for (const [id, bucket] of Object.entries(raw.rateLimitsByLimitId)) {
      const base = bucket.limitId || id;

      // Primary window (5시간)
      const p = bucket.primary;
      if (p && p.usedPercent != null) {
        const durationMs = p.windowDurationMins * 60 * 1000;
        const resetsAt = new Date(p.resetsAt * 1000).toISOString();
        const h = Math.round(p.windowDurationMins / 60);
        windows.push({
          key: `${base}_primary`,
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
          key: `${base}_secondary`,
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

// ── 모델 패밀리 분류 (Gemini/Antigravity 공용 4-패밀리) ────
type ModelFamily = "flash" | "pro" | "claude" | "gpt";
const FAMILY_ORDER: ModelFamily[] = ["flash", "pro", "claude", "gpt"];
const FAMILY_LABELS: Record<ModelFamily, string> = {
  flash: "Flash",
  pro: "Pro",
  claude: "Claude",
  gpt: "GPT-OSS",
};

/** claude-/gpt- 접두사 우선, flash-lite는 flash로 통합. 미분류 모델은 표시 제외 */
function modelFamily(modelId: string): ModelFamily | null {
  if (modelId.startsWith("claude-")) return "claude";
  if (modelId.startsWith("gpt-")) return "gpt";
  if (modelId.includes("flash")) return "flash";
  if (modelId.includes("pro")) return "pro";
  return null;
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
    const res = await fetchWithTimeout("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota", {
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

    // 패밀리별로 그룹화 (같은 패밀리는 사용량 공유이므로 하나만 표시)
    const familyMap = new Map<ModelFamily, GeminiQuotaBucket>();
    for (const b of raw.buckets) {
      if (b.tokenType !== "REQUESTS") continue;
      const family = modelFamily(b.modelId);
      if (!family || familyMap.has(family)) continue;
      familyMap.set(family, b);
    }

    const windows: UsageWindow[] = [];
    const durationMs = 24 * 60 * 60 * 1000;

    for (const family of FAMILY_ORDER) {
      const b = familyMap.get(family);
      if (!b) continue;
      windows.push({
        key: family,
        name: FAMILY_LABELS[family],
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

// 모델별 리셋 주기가 가변(스프린트~일 단위)이라 now→reset 간격으로 추정.
// 1시간~24시간 사이로 보정하고, 파싱 실패/과거 시각이면 24시간으로 폴백.
function estimateWindowDurationMs(resetsAt: string): number {
  const gap = new Date(resetsAt).getTime() - Date.now();
  if (!Number.isFinite(gap) || gap <= 0) return 24 * HOUR_MS;
  return Math.min(Math.max(gap, HOUR_MS), 24 * HOUR_MS);
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

  const loadRes = await fetchWithTimeout("https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", {
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

  const modelsRes = await fetchWithTimeout("https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels", {
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
  // 패밀리별로 remainingFraction이 가장 낮은(가장 많이 소진된) 모델을 대표로 선택 — 보수적 표시
  const familyMap = new Map<ModelFamily, { remainingFraction: number; resetTime: string }>();

  for (const [modelId, model] of Object.entries(raw.models ?? {})) {
    if (model.isInternal || !model.displayName) continue;
    const remainingFraction = model.quotaInfo?.remainingFraction;
    if (typeof remainingFraction !== "number") continue;
    const family = modelFamily(modelId);
    if (!family) continue;

    const resetTime = model.quotaInfo?.resetTime || new Date().toISOString();
    const existing = familyMap.get(family);
    if (!existing || remainingFraction < existing.remainingFraction) {
      familyMap.set(family, { remainingFraction, resetTime });
    }
  }

  const windows: UsageWindow[] = [];
  for (const family of FAMILY_ORDER) {
    const quota = familyMap.get(family);
    if (!quota) continue;
    windows.push({
      key: family,
      name: FAMILY_LABELS[family],
      utilization: Math.round((1 - quota.remainingFraction) * 100),
      resetsAt: quota.resetTime,
      timeProgress: computeTimeProgress(quota.resetTime, estimateWindowDurationMs(quota.resetTime)),
    });
  }

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
