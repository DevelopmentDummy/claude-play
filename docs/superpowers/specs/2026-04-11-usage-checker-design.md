# Usage Checker Design

## Overview

플레이 세션 및 빌더 화면에서 AI 서비스의 계정 수준 사용량을 확인할 수 있는 기능.
시간 진행률과 사용량을 하나의 게이지에 겹쳐 표시하여 소모 속도를 직관적으로 파악한다.
서비스 공통 인터페이스로 설계하되, 우선 Claude부터 구현.

## Data Source — Claude

**Endpoint**: `GET https://api.anthropic.com/api/oauth/usage`
- 비공식 API (변경 가능성 있음, graceful degradation 필요)
- 인증: `~/.claude/.credentials.json` → `claudeAiOauth.accessToken` (Bearer token)
- 헤더: `anthropic-beta: oauth-2025-04-20`

**응답 예시**:
```json
{
  "five_hour": { "utilization": 11.0, "resets_at": "2026-04-11T09:00:00+00:00" },
  "seven_day": { "utilization": 9.0, "resets_at": "2026-04-17T05:00:00+00:00" },
  "seven_day_sonnet": { "utilization": 0.0, "resets_at": "..." },
  "extra_usage": { "is_enabled": true, "monthly_limit": 20000, "used_credits": 0.0 }
}
```

**갱신 방식**: 자동 폴링 없음. 패널 열 때 1회 호출. 30초 TTL 메모리 캐시로 연속 열기 시 중복 호출 방지.

## Backend

### `src/lib/usage-checker.ts` (신규)

- `getClaudeUsage(): Promise<UsageResponse>` — credentials 읽기 → API 호출 → 파싱
- 30초 TTL 인메모리 캐시 (lastFetch timestamp + cached result)
- 토큰 만료/갱신은 별도 처리 안 함
- API 실패 시 에러 메시지 반환 (429, 네트워크 오류 등)

### `src/app/api/usage/route.ts` (신규)

- `GET /api/usage?provider=claude`
- 향후 Codex/Gemini 추가 시 provider 파라미터로 분기

### 공통 응답 인터페이스

```ts
interface UsageWindow {
  name: string;           // "5시간" | "7일" | "7일 (Sonnet)" 등
  utilization: number;    // 0-100 (사용량 %)
  resetsAt: string;       // ISO 8601
  timeProgress: number;   // 0-100 (서버에서 계산)
}

interface UsageResponse {
  provider: "claude" | "codex" | "gemini";
  windows: UsageWindow[];
  extraUsage?: {
    isEnabled: boolean;
    monthlyLimit: number;
    usedCredits: number;
  };
  error?: string;
}
```

`timeProgress` 계산: `(1 - (resetsAt - now) / windowDuration) * 100`
- 5시간 윈도우: windowDuration = 5h
- 7일 윈도우: windowDuration = 7d

## Frontend

### 진입점

플레이 세션 / 빌더 화면 공통으로 접근 가능한 버튼. 모달로 표시.

### 게이지 UI

하나의 바에 두 레이어를 겹치는 방식:
- **뒷면 레이어**: 시간 진행률 — 반투명 색상으로 채움
- **앞면 레이어**: 실 사용량 — 메인 불투명 색상으로 채움
- 둘 다 같은 바 위에 absolute position으로 겹침

**색상 로직**:
- 사용량 < 시간 진행률 → 녹색 계열 (여유)
- 사용량 ≈ 시간 진행률 → 노란색 계열 (적정)
- 사용량 > 시간 진행률 → 빨간색 계열 (과소비)

각 윈도우별로 게이지 + 리셋까지 남은 시간 텍스트 표시.

### Extra Usage

Max 초과 사용 활성화 상태면 하단에 별도 섹션: `사용 크레딧 / 월 한도`.

### 서비스 공통

컴포넌트는 `UsageResponse`만 받으면 렌더링. Codex/Gemini 추가 시 같은 모달에 섹션으로 나열.

## Scope

- 이번 구현: Claude만
- 향후: Codex, Gemini (각 서비스별 데이터 소스 조사 필요)
