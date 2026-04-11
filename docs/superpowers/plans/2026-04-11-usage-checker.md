# Usage Checker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude의 계정 수준 사용량(5시간/7일 윈도우)을 게이지 UI로 확인하는 기능 구현

**Architecture:** 서버에서 Anthropic OAuth usage API를 호출하여 사용량 데이터를 가져오고, Next.js API 라우트로 프론트엔드에 노출. 프론트엔드는 StatusBar 메뉴에 "Usage" 항목을 추가하고, 클릭 시 모달에서 게이지를 렌더링한다. 서비스 공통 인터페이스로 설계하여 향후 Codex/Gemini 확장 가능.

**Tech Stack:** TypeScript, Next.js API Routes, React, Tailwind CSS

**참고 문서:**
- 디자인 스펙: `docs/superpowers/specs/2026-04-11-usage-checker-design.md`
- StatusBar 컴포넌트: `src/components/StatusBar.tsx`
- API 라우트 패턴: `src/app/api/sessions/route.ts`

---

### Task 1: 백엔드 — usage-checker.ts

**Files:**
- Create: `src/lib/usage-checker.ts`

- [ ] **Step 1: Create usage-checker.ts with types and getClaudeUsage()**

이 파일은 Anthropic OAuth usage API를 호출하고 결과를 공통 인터페이스로 변환한다.

```ts
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
  // 캐시 확인
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

    // 윈도우 변환 — null/undefined인 키는 건너뜀
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
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/usage-checker.ts
git commit -m "feat: add usage-checker service for Claude OAuth usage API"
```

---

### Task 2: API 라우트

**Files:**
- Create: `src/app/api/usage/route.ts`

- [ ] **Step 1: Create the API route**

```ts
// src/app/api/usage/route.ts
import { NextResponse } from "next/server";
import { getClaudeUsage } from "@/lib/usage-checker";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const provider = searchParams.get("provider") || "claude";

  if (provider === "claude") {
    const usage = await getClaudeUsage();
    return NextResponse.json(usage);
  }

  // 향후 codex, gemini 분기 추가
  return NextResponse.json(
    { provider, windows: [], error: `지원하지 않는 provider: ${provider}` },
    { status: 400 }
  );
}
```

- [ ] **Step 2: 수동 테스트**

```bash
npm run dev
# 다른 터미널에서:
curl http://localhost:3340/api/usage?provider=claude
```

예상 결과: `five_hour`, `seven_day` 등의 `utilization`, `timeProgress` 값이 포함된 JSON

- [ ] **Step 3: Commit**

```bash
git add src/app/api/usage/route.ts
git commit -m "feat: add GET /api/usage route for usage data"
```

---

### Task 3: UsageModal 프론트엔드 컴포넌트

**Files:**
- Create: `src/components/UsageModal.tsx`

- [ ] **Step 1: Create UsageModal.tsx**

모달 + 게이지 UI. 열릴 때 `/api/usage?provider=claude` 를 1회 fetch. 하나의 게이지 바에 사용량(앞면, 불투명)과 시간 진행률(뒷면, 반투명)을 겹쳐 표시.

```tsx
// src/components/UsageModal.tsx
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

/** 사용량 vs 시간 진행률 비교 → 색상 결정 */
function gaugeColor(utilization: number, timeProgress: number): {
  bar: string;    // 사용량 바 색상
  bg: string;     // 시간 오버레이 색상
  label: string;  // 상태 텍스트 색상
} {
  const ratio = timeProgress > 0 ? utilization / timeProgress : (utilization > 0 ? 2 : 0);
  if (ratio > 1.2) {
    // 과소비: 빨간색
    return {
      bar: "bg-red-500",
      bg: "bg-red-400/20",
      label: "text-red-400",
    };
  }
  if (ratio > 0.8) {
    // 적정: 노란색
    return {
      bar: "bg-yellow-500",
      bg: "bg-yellow-400/20",
      label: "text-yellow-400",
    };
  }
  // 여유: 녹색
  return {
    bar: "bg-emerald-500",
    bg: "bg-emerald-400/20",
    label: "text-emerald-400",
  };
}

function UsageGauge({ window: w }: { window: UsageWindow }) {
  const colors = gaugeColor(w.utilization, w.timeProgress);

  return (
    <div className="mb-4">
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-xs font-medium text-text">{w.name}</span>
        <span className={`text-xs font-mono ${colors.label}`}>
          {Math.round(w.utilization)}%
        </span>
      </div>
      {/* 겹치는 게이지 바 */}
      <div className="relative h-5 rounded-full bg-surface-light overflow-hidden">
        {/* 뒷면: 시간 진행률 (반투명) */}
        <div
          className={`absolute inset-y-0 left-0 rounded-full ${colors.bg} transition-all duration-500`}
          style={{ width: `${Math.min(w.timeProgress, 100)}%` }}
        />
        {/* 앞면: 실 사용량 (불투명) */}
        <div
          className={`absolute inset-y-0 left-0 rounded-full ${colors.bar} transition-all duration-500`}
          style={{ width: `${Math.min(w.utilization, 100)}%`, opacity: 0.85 }}
        />
        {/* 시간 진행률 경계선 */}
        {w.timeProgress > 0 && w.timeProgress < 100 && (
          <div
            className="absolute inset-y-0 w-0.5 bg-white/40"
            style={{ left: `${w.timeProgress}%` }}
          />
        )}
      </div>
      <div className="flex justify-between mt-1">
        <span className="text-[10px] text-text-dim">
          시간 {Math.round(w.timeProgress)}%
        </span>
        <span className="text-[10px] text-text-dim">
          {formatRemaining(w.resetsAt)}
        </span>
      </div>
    </div>
  );
}

export default function UsageModal({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/usage?provider=claude")
      .then((r) => r.json())
      .then((d) => setData(d))
      .catch(() => setData({ provider: "claude", windows: [], error: "요청 실패" }))
      .finally(() => setLoading(false));
  }, []);

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

        {/* Content */}
        {loading && (
          <div className="text-center py-8 text-text-dim text-xs">로딩 중...</div>
        )}

        {!loading && data?.error && (
          <div className="text-center py-8 text-red-400 text-xs">{data.error}</div>
        )}

        {!loading && data && !data.error && (
          <>
            {/* Provider badge */}
            <div className="flex items-center gap-2 mb-4">
              <span className="inline-block w-2 h-2 rounded-full bg-[#ff9f43]" />
              <span className="text-xs text-text-dim">Claude</span>
            </div>

            {/* Gauge bars */}
            {data.windows.map((w) => (
              <UsageGauge key={w.name} window={w} />
            ))}

            {/* Extra usage */}
            {data.extraUsage?.isEnabled && (
              <div className="mt-4 pt-3 border-t border-border/40">
                <div className="flex items-baseline justify-between">
                  <span className="text-xs text-text-dim">추가 사용</span>
                  <span className="text-xs font-mono text-text-dim">
                    ${data.extraUsage.usedCredits.toFixed(2)} / ${data.extraUsage.monthlyLimit.toLocaleString()}
                  </span>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>,
    document.body
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/UsageModal.tsx
git commit -m "feat: add UsageModal component with layered gauge UI"
```

---

### Task 4: StatusBar에 Usage 메뉴 항목 연결

**Files:**
- Modify: `src/components/StatusBar.tsx`

- [ ] **Step 1: Add onUsage prop and menu item**

StatusBar의 props에 `onUsage` 콜백을 추가하고, 도구 메뉴(debugMenu)에 "Usage" 버튼을 추가한다.

`StatusBarProps` 인터페이스에 추가:
```ts
  /** Usage modal */
  onUsage?: () => void;
```

`hasDebugItems` 조건에 `onUsage` 추가:
```ts
  const hasDebugItems = onUsage || onCompact || onContext || onReinit || (!isBuilderMode && onSync) || onForceInputToggle;
```

도구 메뉴 `<div>` 안에서, `onForceInputToggle` 버튼 **앞에** 추가:
```tsx
                {onUsage && (
                  <button
                    onClick={() => { onUsage(); setDebugOpen(false); }}
                    className={menuBtnClass}
                  >
                    Usage
                  </button>
                )}
```

함수 시그니처 destructuring에 `onUsage` 추가.

- [ ] **Step 2: Commit**

```bash
git add src/components/StatusBar.tsx
git commit -m "feat: add Usage menu item to StatusBar"
```

---

### Task 5: 페이지에서 StatusBar ↔ UsageModal 연결

**Files:**
- Modify: `src/app/play/[id]/page.tsx` (플레이 세션)
- Modify: `src/app/builder/[name]/page.tsx` (빌더)

- [ ] **Step 1: Play 페이지에 연결**

`page.tsx` 상단에 import 추가:
```tsx
import UsageModal from "@/components/UsageModal";
```

상태 추가 (다른 useState 근처):
```tsx
const [showUsage, setShowUsage] = useState(false);
```

`<StatusBar>` 컴포넌트에 prop 추가:
```tsx
onUsage={() => setShowUsage(true)}
```

컴포넌트 트리 말미 (다른 모달 옆)에 추가:
```tsx
{showUsage && <UsageModal onClose={() => setShowUsage(false)} />}
```

- [ ] **Step 2: Builder 페이지에 동일하게 연결**

위와 동일한 패턴으로 builder 페이지에도 import, state, prop, render 추가.

- [ ] **Step 3: 수동 테스트**

1. `npm run dev`로 개발 서버 시작
2. 플레이 세션 진입 → StatusBar 도구 메뉴(☰) → "Usage" 클릭
3. 모달에 5시간/7일 게이지가 표시되는지 확인
4. 빌더 화면에서도 동일하게 동작하는지 확인
5. 모달 바깥 클릭 또는 X 버튼으로 닫히는지 확인

- [ ] **Step 4: Commit**

```bash
git add src/app/play/[id]/page.tsx src/app/builder/[name]/page.tsx
git commit -m "feat: wire UsageModal to play and builder pages"
```

---

### Task 6: 빌드 확인

**Files:** (없음 — 검증 단계)

- [ ] **Step 1: TypeScript 빌드 체크**

```bash
npm run build
```

예상: 에러 없이 빌드 성공.

- [ ] **Step 2: 빌드 에러 수정 (필요 시)**

타입 에러 또는 import 문제가 있으면 수정.

- [ ] **Step 3: Commit (수정 있을 경우)**

```bash
git add -A
git commit -m "fix: resolve build errors in usage checker"
```
