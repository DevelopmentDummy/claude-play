# CLI Usage Widget — 작업 인수인계 (Handoff)

새 Claude Code 세션(작업 디렉토리: `C:/repository/`)에서 이 문서를 첫 메시지로 전달하면 바로 이어서 구현을 시작할 수 있습니다.

---

## 이전 세션 요약

Claude Bridge 프로젝트(`C:/repository/claude bridge/`)에서 내장 usage tracker를 독립 Windows 데스크탑 위젯으로 분리하기로 결정. 설계·구현 플랜까지 작성 완료. Codex에게 구현을 위임했으나 **샌드박스 권한 문제로 실제 구현 시작 전에 차단**되어, 새 세션에서 재시작이 필요함.

## 참조 문서 (반드시 먼저 읽을 것)

둘 다 `C:/repository/claude bridge/` 안에 있습니다.

1. **설계 스펙**: `C:/repository/claude bridge/docs/superpowers/specs/2026-04-22-cli-usage-widget-design.md` — 14개 섹션, 아키텍처·API·UI·리스크 전부 포함.
2. **구현 플랜**: `C:/repository/claude bridge/docs/superpowers/plans/2026-04-22-cli-usage-widget.md` — 23개 task로 분해되어 있고 각 task에 붙여넣을 수 있는 완전한 Rust/TS 코드 포함.

## 확정된 핵심 결정

- **스택**: Tauri 2 + Rust + React 19 + TypeScript + Vite + Tailwind 3
- **타겟**: Windows x64 전용
- **Provider**: Claude/Codex/Gemini 3종 — 모두 OAuth 토큰 파일 직읽기 + HTTPS 직접 호출 (CLI 프로세스 의존 없음)
- **Codex 엔드포인트**: `GET https://chatgpt.com/backend-api/wham/usage`, 헤더 `Authorization: Bearer <access_token>`, `ChatGPT-Account-Id: <account_id>`, `User-Agent: codex-cli` — `~/.codex/auth.json`에서 토큰 직접 추출 (세션 불필요)
- **토큰 갱신 정책**: 위젯은 OAuth refresh를 직접 구현하지 않음. 401 감지 시 UI의 "CLI로 갱신" 버튼으로 해당 CLI를 spawn해서 갱신 유도 (1순위 `--version`, 2순위 `Reply with exactly: hi. No other text.` 최소 프롬프트)
- **폼팩터**: 플로팅 창, 프레임리스, always-on-top 토글, 드래그 이동, 트레이 없음
- **갱신 주기**: 5분 자동 + 수동 새로고침 버튼 (30초 쿨다운)
- **저장소 위치**: **별도 저장소** — `C:/repository/claude-usage-widget/` (신규 생성)
- **다마고치 훅**: 위젯은 `usage:updated` Tauri 이벤트에 `delta` 스칼라만 payload로 실어 emit. 다마고치 모듈은 이 이벤트만 구독하면 됨 (본체 코드 수정 없이 플러그인처럼 붙음). 다마고치 본 구현은 별도 스펙/후속 작업.

## 실행 방법

### 1단계: 환경 사전 점검

현재 환경 상태:
- `node v22.19.0` ✓
- `npm.cmd 11.12.1` ✓
- **Rust**: ✅ `rustc 1.95.0` / `cargo 1.95.0` (winget Rustlang.Rustup으로 설치 완료)
- **npm registry 접근**: ⚠️ 이전 세션에서 `npm ping` timeout. 방화벽/프록시 확인 필요할 수 있음
- **PowerShell execution policy**: `npm.ps1`이 차단되므로 `npm.cmd`를 사용하거나 execution policy 조정

### 2단계: Claude Code 새 세션 시작

- **작업 디렉토리를 반드시 `C:/repository/`로 변경**해서 Claude Code 열 것. `C:/repository/claude bridge/` 안에서 열면 이전 세션과 같은 샌드박스 문제가 반복됨.
- 새 세션에서 이 handoff 문서 내용 또는 다음 프롬프트를 붙여넣기:

```
docs/claude-bridge/docs/superpowers/plans/2026-04-22-cli-usage-widget.md 의 Task 1~22를 순서대로 구현해줘. 이전 세션에서 설계까지 완료되었고, 플랜에 모든 코드 블록이 포함되어 있어 기계적으로 적용 가능해. 새 저장소 C:/repository/claude-usage-widget/ 를 만들어서 진행하면 돼. Task 23은 수동 QA라 스킵.
```

(위 경로는 새 세션 기준 상대 경로로 조정 필요. 가장 확실한 건 Claude Code를 `C:/repository/`에서 열면 `claude bridge/docs/...`로 참조 가능.)

### 3단계: 구현 진행 방식 권장

플랜의 각 task 코드 블록은 거의 그대로 붙여넣을 수 있는 수준으로 작성됨. Task 1 (`npm create tauri-app`)만 인터랙티브 프롬프트가 있을 수 있으니 주의. 이후 Task 2~19는 파일 생성 중심이라 순차 진행. Task 20~22는 빌드/CI 설정.

플랜의 각 task에 `cargo test` / `cargo check` 지점이 명시되어 있음 — 반드시 해당 지점에서 실행해서 통과 확인 후 다음 task로 진행.

## Windows 특이사항 (플랜에는 없는 함정 포함)

- `npm` 명령이 PowerShell에서 차단되면 `npm.cmd` 또는 bash 셸 사용
- Tauri 빌드에는 **MSVC C++ build tools** 필수 (rustup-init가 보통 자동 안내)
- WebView2 런타임은 Windows 11에 내장, 구형 Windows 10은 자동 bootstrap (Evergreen)

## 완료 기준

- `npm run tauri build` 성공
- `src-tauri/target/release/claude-usage-widget.exe` 생성 및 실행 확인
- 3 provider 로그인된 상태에서 게이지 표시
- 플랜 Task 23의 수동 QA 체크리스트 중 최소 1~11번 PASS

## 이미 완료된 것 (브릿지 쪽)

- `c9...` 범위의 커밋들 — 설계 스펙 + 구현 플랜 문서 커밋 (확인: `cd "C:/repository/claude bridge" && git log --oneline -5`)
- 최신 커밋: `0d1e37e docs: CLI Usage Widget 구현 플랜 추가`

## 주의

- 플랜의 Task 1이 사용하는 `create-tauri-app` 버전이 업데이트되었을 수 있음 → 실제 프롬프트에 맞게 대응
- `tauri.conf.json` 스키마는 Tauri 2 기준. Tauri 1 문법과 다름 — 플랜 그대로 복사
- `dirs@5`, `winreg@0.52`, `webbrowser@1` 등 crate 버전은 발행 시점 기준 — 업데이트된 메이저 버전이 있으면 호환성 체크 필요
