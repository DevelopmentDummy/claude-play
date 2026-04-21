# CLI Usage Widget — Design Spec

**작성일**: 2026-04-22
**대상**: 별도 저장소 (`claude-usage-widget`)
**참조 원본**: Claude Bridge 저장소의 `src/lib/usage-checker.ts`, `src/app/api/usage/route.ts`, `src/components/UsageModal.tsx`

## 1. 목적 및 범위

Claude Bridge에 내장된 3-provider(Claude/Codex/Gemini) CLI 사용량 트래커 UI를, 브릿지와 독립적으로 동작하는 **Windows 데스크탑 위젯**으로 분리·재배포한다.

**스코프 내**
- Claude/Codex/Gemini 각 CLI의 사용량 조회 및 잔여량 게이지 렌더링
- 토큰 만료 시 수동 CLI 갱신 트리거 (재인증 명령 안내 포함)
- 플로팅 창 (frameless, always-on-top 토글, 드래그 이동, 설정 영속화)
- Windows 전용 단일 실행 파일 배포 (포터블 `.exe` + NSIS 인스톨러)
- 향후 다마고치 모듈을 위한 데이터 훅(Tauri 이벤트 + 스칼라 상태 파일)

**스코프 외**
- macOS/Linux 지원
- 다마고치 게임 로직/UI (별도 모듈, 후속 작업)
- 자동 업데이트 / 코드 서명
- 라이트 테마
- API key 모드 Codex 계정 지원 (ChatGPT Plus/Pro OAuth 로그인 계정만)

## 2. 전체 아키텍처

```
┌─────────────────────────────────────┐
│ Tauri WebView (React/TS)            │
│  - UsageGauge 컴포넌트 (브릿지 포팅)  │
│  - 폴링 타이머 UI / 쿨다운 표시       │
│  - 창 드래그/설정 UI                  │
│  - usage:updated 이벤트 구독          │
└──────────────┬──────────────────────┘
               │ invoke(...)
               ▼
┌─────────────────────────────────────┐
│ Tauri Rust (src-tauri)              │
│  - commands::*                      │
│  - providers/{claude,codex,gemini}  │
│  - cli_refresher (CLI spawn)        │
│  - settings (settings.json, state)  │
│  - tokio interval (자동 폴링)        │
│  - 30초 TTL 메모리 캐시               │
└─────────────────────────────────────┘
```

**역할 분담 원칙**
- **Rust**: 파일시스템, HTTPS, CLI spawn, 캐시, 폴링 스케줄러. OS 보안 책임 일원화.
- **WebView**: 렌더링, 설정 UI, 이벤트 소비. HTTPS는 Rust가 하므로 토큰이 WebView에 노출되지 않음.

## 3. 토큰 관리 및 갱신 전략

### 3.1 토큰 파일 위치

| Provider | 파일 경로 | 추출 필드 |
|---|---|---|
| Claude | `~/.claude/.credentials.json` | `claudeAiOauth.accessToken`, `claudeAiOauth.expiresAt` |
| Gemini | `~/.gemini/oauth_creds.json` | `access_token`, `expiry_date` (+ `~/.gemini/projects.json`의 첫 project id) |
| Codex | `~/.codex/auth.json` | `tokens.access_token`, `tokens.account_id`, `tokens.id_token` (exp 파싱용) |

### 3.2 읽기 정책

- **매 조회 시 파일 재읽기.** 인메모리 토큰 캐시 없음. CLI가 백그라운드에서 갱신한 새 토큰을 즉시 반영.
- 파일 없음/파싱 실패 → `not_authenticated` 상태.

### 3.3 갱신 전략 (핵심 결정: CLI 위임 방식)

위젯은 **OAuth refresh를 직접 구현하지 않는다.** 토큰 만료/401 감지 시 사용자가 버튼을 눌러 CLI를 spawn하고, 실제 갱신은 각 CLI가 수행한다.

**갱신 버튼 동작 — Provider별 2단계**

| Provider | 1순위 (turn 없음) | 2순위 Fallback |
|---|---|---|
| Claude | `claude --version` | `claude -p "Reply with exactly: hi. No other text."` |
| Gemini | `gemini --version` | `gemini -p "Reply with exactly: hi. No other text."` |
| Codex | `codex --version` | `codex exec "Reply with exactly: hi. No other text."` |

**검증 로직**
1. spawn 전: 토큰 파일 mtime 기록
2. spawn (15초 타임아웃)
3. spawn 후: mtime 재확인
   - 변경됨 → 갱신 성공, usage 재조회
   - 동일 → 2순위 시도
4. 2순위도 mtime 미변경 또는 non-zero exit → "수동 로그인 필요" 상태 (`claude login` / `gemini` / `codex login` 안내)

**토큰 만료 감지**
- Claude: `expiresAt` 필드 또는 usage API 401
- Gemini: `expiry_date` 필드 또는 usage API 401
- Codex: `id_token`의 `exp` claim (JWT decode, 서명 검증 안 함) 또는 usage API 401

## 4. Provider별 API 계약

### 4.1 Claude

- `GET https://api.anthropic.com/api/oauth/usage`
- 헤더: `Authorization: Bearer <accessToken>`, `anthropic-beta: oauth-2025-04-20`
- 응답: `five_hour`, `seven_day`, `seven_day_sonnet`, `seven_day_opus`, `seven_day_cowork` 중 존재하는 것만.
- 브릿지 [src/lib/usage-checker.ts:90-147](../../../src/lib/usage-checker.ts#L90-L147) 로직 그대로 포팅.

### 4.2 Codex

- `GET https://chatgpt.com/backend-api/wham/usage`
- 헤더: `Authorization: Bearer <access_token>`, `ChatGPT-Account-Id: <account_id>`, `User-Agent: codex-cli`
- 응답: `primary_window` (5시간), `secondary_window` (7일), `credits`, `plan_type`
- 각 window: `used_percent`, `reset_at` (unix epoch sec), `limit_window_seconds`
- **브릿지 코드와 달리** `codex app-server` 세션 불필요. 파일 + HTTPS만.
- 레퍼런스: https://github.com/steipete/CodexBar/blob/main/docs/codex-oauth.md

### 4.3 Gemini

- `POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota`
- 헤더: `Authorization: Bearer <access_token>`, `Content-Type: application/json`
- Body: `{ "project": "<projectId>" }` (없으면 빈 객체)
- 응답: `buckets[]` 중 `tokenType === "REQUESTS"`만 사용, 모델 tier별(Flash Lite / Flash / Pro)로 1개씩 dedupe.
- 브릿지 [src/lib/usage-checker.ts:266-336](../../../src/lib/usage-checker.ts#L266-L336) 로직 그대로 포팅.

## 5. 데이터 모델

### 5.1 공유 타입

```ts
type Provider = "claude" | "codex" | "gemini";
type Status = "ok" | "not_authenticated" | "expired" | "network_error" | "unknown_error";

interface UsageWindow {
  key: string;           // provider 내에서 고유 (five_hour, primary, flash, ...)
  name: string;          // 표시용 라벨 ("5시간", "Flash")
  utilization: number;   // 0-100
  resetsAt: string;      // ISO 8601
  timeProgress: number;  // 0-100
}

interface UsageResponse {
  provider: Provider;
  status: Status;
  windows: UsageWindow[];
  extraUsage?: {
    isEnabled: boolean;
    monthlyLimit: number;
    usedCredits: number;
    utilization: number | null;
  };
  error?: string;
}
```

`key` 필드는 브릿지 원본에 없음 — 신규. 이벤트 payload의 delta 매핑 키(`${provider}.${key}`)로 사용.

### 5.2 영속 파일

위치: `%APPDATA%\claude-usage-widget\` (Tauri `app_data_dir()`)

**`settings.json`**
```json
{
  "window": { "x": 1580, "y": 40, "width": 320, "height": 520 },
  "alwaysOnTop": true,
  "opacity": 0.92,
  "refreshIntervalSec": 300,
  "autostart": false
}
```

**`state.json`** (다마고치 훅, 스칼라만)
```json
{
  "lastUtilization": {
    "claude.five_hour": 42,
    "codex.primary": 20,
    "gemini.flash": 80
  },
  "lastUpdatedAt": "2026-04-22T10:30:00Z"
}
```

- 윈도우별 직전 utilization 스칼라 1개만 보관
- 매 갱신마다 덮어씀 (원자적 쓰기: `*.tmp` → rename)
- 이력 로그 없음. jsonl append 없음.

## 6. IPC 계약

### 6.1 커맨드 (WebView → Rust)

| 커맨드 | 인자 | 반환 | 용도 |
|---|---|---|---|
| `get_all_usage` | — | `UsageResponse[]` (3개) | 초기 로딩 + 자동 폴링 + 수동 새로고침 |
| `refresh_via_cli` | `provider: Provider` | `{ ok: bool, error?: string }` | CLI spawn 갱신 |
| `get_settings` | — | `Settings` | 초기 설정 로드 |
| `save_settings` | `settings: Settings` | — | 설정 영속화 |
| `set_autostart` | `enabled: bool` | — | Windows `HKCU\Run` 레지스트리 |
| `open_url` | `url: string` | — | 외부 링크 열기 (About 메뉴) |

### 6.2 이벤트 (Rust → WebView)

| 이벤트 | Payload | 시점 |
|---|---|---|
| `usage:refreshing` | `{ manual: bool }` | fetch 시작 |
| `usage:updated` | `{ current: UsageResponse[], delta: Record<string, number> }` | fetch 완료 |

`delta` 키: `${provider}.${key}`. 값: `currentUtilization - lastUtilization` (음수 가능 — 리셋 시). 다마고치 모듈은 이 이벤트만 구독하면 됨.

### 6.3 폴링 & 캐시

- 자동 폴링: Rust `tokio::time::interval` (기본 300초, 설정 변경 시 재시작).
- 30초 TTL 메모리 캐시 (Provider별). 브릿지와 동일.
- `get_all_usage` 내부에서 3 provider 병렬 (`tokio::join!`).
- 수동 새로고침: WebView에서 30초 쿨다운 체크 후 `get_all_usage` 호출 (캐시 무시 플래그 포함).

## 7. UI / 창 동작

### 7.1 창 기본값
- 크기: 폭 320, 높이 auto (min 200, max 700)
- Frameless, 둥근 모서리 12px, 반투명 (opacity 92% 기본)
- 초기 위치: 우측 상단 (screen.right - 20, 40)
- Always-on-top: 기본 ON
- Taskbar 표시: OFF, Alt+Tab 미노출
- 트레이 아이콘 없음 (창 × 버튼 = 앱 종료)

### 7.2 레이아웃

```
┌────────────────────────────────┐
│ Claude Usage              [⟳][⋯][×]│ ← 드래그 핸들
├────────────────────────────────┤
│ ● Claude                          │
│   5시간     [████████░░] 75% 남음  │
│   7일       [██████░░░░] 60% 남음  │
│                                    │
│ ● Codex                           │
│   5시간     [██░░░░░░░░] 20% 남음  │
│   7일       [██████████] 95% 남음  │
│                                    │
│ ● Gemini                          │
│   Flash     [████████░░] 80% 남음  │
│   Pro       [██████████] 100% 남음 │
├────────────────────────────────┤
│ 마지막 갱신: 2분 전                │
└────────────────────────────────┘
```

### 7.3 헤더 버튼
- **⟳ 새로고침**: 수동 fetch, 30초 쿨다운 (쿨다운 중 회색 + 툴팁 "N초 후 가능")
- **⋯ 메뉴**: 드롭다운
  - Always-on-top 토글
  - Autostart 토글 (Windows `HKCU\Run`)
  - 불투명도 슬라이더 (50~100%)
  - 자동 갱신 간격 (1분 / 5분 / 15분)
  - About (버전, 저장소 링크)
- **× 닫기**: 앱 종료 (설정 저장 후)

### 7.4 게이지 컴포넌트

브릿지 [src/components/UsageModal.tsx:51-102](../../../src/components/UsageModal.tsx#L51-L102) 그대로 포팅:
- 잔여량 바 (accent 색)
- timeProgress 위험 구간 빨간 오버레이 + 흰색 마커 선
- remain vs expectedRemain 비교로 투명도 분기 (위험도 시각화)

### 7.5 Provider 색상 (배지)
- Claude `#ff9f43`, Codex `#4dff91`, Gemini `#64b5f6`

### 7.6 상태별 UI

| 상태 | 표시 |
|---|---|
| 초기 로딩 | "로딩 중..." 회색 |
| `not_authenticated` | "로그인되지 않음" + 명령어 (`claude login` 등) |
| `expired` | "토큰 만료" + **[CLI로 갱신]** 버튼 |
| `network_error` | 마지막 성공값 유지 + ⚠️ 아이콘 (호버 시 에러) |
| CLI spawn 진행 | 버튼 → 스피너 + "갱신 중... (최대 15초)" |
| CLI spawn 실패 | "CLI 실행 실패 — 수동 로그인 필요" + 명령어 |

### 7.7 상호작용
- 헤더 전체 드래그 (`data-tauri-drag-region`, 버튼 위 비활성)
- ESC: 최소화 (트레이 없으므로 숨기면 복구 불가 → 최소화로 안전)
- 우클릭: 헤더에서 ⋯ 메뉴와 동일 컨텍스트 메뉴
- 단축키: F5 새로고침 (쿨다운 적용), Ctrl+Q 종료

## 8. 프로젝트 구조

```
claude-usage-widget/
├── src/                        # React/TS
│   ├── App.tsx
│   ├── main.tsx
│   ├── components/
│   │   ├── UsageGauge.tsx
│   │   ├── ProviderCard.tsx
│   │   ├── Header.tsx
│   │   └── SettingsMenu.tsx
│   └── lib/
│       ├── ipc.ts
│       └── types.ts
├── src-tauri/
│   ├── src/
│   │   ├── main.rs
│   │   ├── commands.rs
│   │   ├── providers/
│   │   │   ├── mod.rs
│   │   │   ├── claude.rs
│   │   │   ├── codex.rs
│   │   │   └── gemini.rs
│   │   ├── cli_refresher.rs
│   │   ├── settings.rs
│   │   ├── state_store.rs
│   │   ├── cache.rs
│   │   └── types.rs
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── icons/
├── package.json
├── vite.config.ts
├── tsconfig.json
├── tailwind.config.js
├── README.md
└── .github/workflows/release.yml
```

## 9. 의존성

**Frontend**: `react@19`, `react-dom@19`, `vite@5`, `typescript@5`, `@tauri-apps/api@2`, `tailwindcss@3`.

**Rust**: `tauri@2`, `reqwest@0.12` (rustls-tls, json), `serde@1`, `serde_json@1`, `tokio@1` (full), `chrono@0.4` (serde), `jsonwebtoken@9` (Codex id_token exp만 파싱, 서명 검증 안 함), `dirs@5`, `anyhow@1`, `thiserror@1`, `winreg@0.52` (Autostart).

## 10. 빌드 / 배포

- 개발: `npm run tauri dev`
- 프로덕션: `npm run tauri build`
- 산출물:
  - `src-tauri/target/release/claude-usage-widget.exe` (포터블, ~10MB)
  - `claude-usage-widget_x.x.x_x64-setup.exe` (NSIS)
- 타겟: `x86_64-pc-windows-msvc`만.
- WebView2: Evergreen bootstrapper 모드.
- 코드 서명 없음 (README에 SmartScreen 안내).
- 자동 업데이트 없음.

**릴리스 자동화**: `.github/workflows/release.yml`, 태그 `v*` 푸시 시 Windows runner에서 `tauri-action`으로 빌드 + Release 업로드.

## 11. 테스트 전략

### 11.1 단위 테스트 (Rust)

- `providers/*.rs`: 고정 JSON fixture → `UsageResponse` 변환 순수 함수.
- `settings.rs`, `state_store.rs`: 파일 읽기/쓰기 원자성, 기본값 fallback, 손상된 JSON 복구.
- `cli_refresher.rs`: mtime 비교 로직 (실제 spawn은 mock).
- `cache.rs`: TTL 동작, provider별 분리.

### 11.2 프론트엔드 테스트

- `vitest` + `@testing-library/react`
- `UsageGauge`의 remain 계산, 색상/투명도 분기
- Tauri `invoke` mock해서 status별 분기 렌더링 확인

### 11.3 수동 QA 체크리스트

1. 3 provider 전부 로그인된 상태에서 정상 로딩
2. 각 provider 토큰 파일 삭제 → `not_authenticated` 표시 확인
3. 토큰을 `"expired"` 상태로 날조 → `expired` + [CLI로 갱신] → 실제 CLI spawn 성공 확인
4. PATH에서 CLI 제거 → "CLI 실행 실패" 메시지 + 수동 명령 안내 확인
5. 네트워크 끊고 새로고침 → 마지막 값 유지 + ⚠️
6. 창 위치/불투명도/always-on-top 재시작 후 복원
7. 자동 갱신 확인 (1분으로 줄여서 검증)
8. 수동 새로고침 30초 쿨다운
9. Autostart 토글 → `HKCU\Run` 레지스트리 확인 → 재부팅 테스트
10. `usage:updated` 이벤트 payload에 `delta` 정확히 포함 (다마고치 훅 검증용 — devtools에서 확인)
11. Codex `primary`/`secondary` window 이름 라벨이 windowDurationSec 기반으로 한글 변환 확인

## 12. 리스크 및 대응

| 리스크 | 영향 | 대응 |
|---|---|---|
| Codex 엔드포인트가 비공식 (변경 가능성) | Codex 기능 단절 | 변환 로직을 `providers/codex.rs` 순수 함수로 격리, 변경 시 파일 1개 수정 |
| CLI가 PATH에 없는 사용자 | 갱신 버튼 실패 | 에러 메시지에 수동 로그인 명령 표시 + 설치 가이드 링크 |
| Gemini `projects.json` 없는 신규 사용자 | project id 없이 POST 실패 가능 | 빈 body로 시도, 실패 시 "Gemini CLI 한 번 실행하세요" 안내 |
| WebView2 런타임 미설치 (구 Windows 10) | 앱 실행 불가 | Evergreen bootstrapper 자동 설치, README에도 명시 |
| Provider 토큰 파일 스키마 변경 | 특정 provider 실패 | 해당 provider만 `not_authenticated`로 degrade, 나머지 정상 동작 유지 |
| Codex API key 모드 계정 (OAuth 아님) | 엔드포인트 거부 | README에 "ChatGPT Plus/Pro 로그인 필수" 명시, API key 모드는 미지원 |

## 13. 버전 정책

- **v0.1.0 (MVP)**: 3 provider 조회 + 설정 영속화 + 수동 CLI 갱신 + `usage:updated` 이벤트 훅
- **v0.2.0+**: 다마고치 모듈, 자동 업데이트, 코드 서명, 테마 등

## 14. 후속 작업 (스코프 외, 별도 스펙)

- 다마고치 모듈: 별도 저장소 또는 동일 저장소 내 `src/tamagotchi/` 하위 모듈. 본체 위젯의 `usage:updated` 이벤트만 구독.
- macOS/Linux 포팅 — 토큰 파일 경로 추상화 + 플랫폼별 autostart 구현 필요.
