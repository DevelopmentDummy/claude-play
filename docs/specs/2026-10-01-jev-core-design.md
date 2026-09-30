# Jev(TypeSafe System One) 코어 통합 — 설계

작성: 2026-10-01. 승인: 사용자(채팅, "1~6 전부 진행").

## 목적

TypeSafe의 System One 모델 **Jev**를 Claude Play 코어에서 어디서든 한 줄로 부를 수 있게 한다.
Jev는 텍스트를 생성하지 않고, `state` + 타입 있는 질문(Choice / Score / Noul)을 받아 **확률이 붙은 구조화 답**을 돌려준다
(실측 ~0.23초, 입력 백만 토큰당 $0.042). LLM 턴이 과한 "빠른 판단"(행동 선택, 분류, 게이트)을 싸고 빠르게 처리하는 용도다.

첫 소비자는 kingdom 앱 모드의 주민 행동 결정이지만, **이 스펙은 공용 기반만** 다룬다. 스레드 루프의 "Jev 두뇌" 타입은 kingdom 행동 설계와 함께 별도 스펙으로 한다.

## 원칙

- **키는 서버 밖으로 나가지 않는다.** `TYPESAFE_API_KEY`는 `.env.local`(gitignored)에만 있고, 모든 경로가 `src/lib/jev-client.ts` 하나를 거친다.
- **코어는 질문을 해석하지 않는다.** 요청을 검증·전달·재시도만 하고, 질문 설계와 답의 의미 해석은 호출자(페르소나 도구, 세션 AI, 앱)의 몫이다.
- **Jev 응답은 가공하지 않고 그대로 돌려준다** (`model`, `answers`, `usage`). 호출자가 `probabilities`/`confidence`를 직접 쓴다.

## 구성 요소

### 1. `src/lib/jev-client.ts` — 단일 진입점
- `askJev(state, questions, opts?) → Promise<JevResponse>`
  - `opts`: `model`(기본 `jev-latest`), `timeoutMs`(기본 15000), `retries`(기본 2), 테스트용 `apiKey`/`fetchImpl`/`baseUrl`.
- 요청 전 검증(`JevError` status 400): `questions`가 비어 있지 않은 객체, 각 질문의 `type` ∈ {choice, score, noul}, `instructions` 존재, choice `criteria`는 1~255개 키의 객체, score `criteria`는 2~10개 배열.
- 키 없음 → `JevError` status 503 (`TYPESAFE_API_KEY not configured`).
- 429 / 5xx / 네트워크 오류 → 지수 백오프 재시도(`retry-after` 헤더 우선, 상한 5초). 4xx(429 제외)는 재시도하지 않고 TypeSafe 에러 본문을 그대로 전달.
- 타임아웃은 `AbortController`. 짧은 요청이라 전역 `fetch` 사용이 안전하다(플레이북 §5.10의 305초 절벽과 무관).
- 매 호출 한 줄 로그: `[jev] model=… q=… in=… out=… ms=…`. **키는 절대 로그하지 않는다.**

### 2. `POST /api/jev` — HTTP 프록시
- 본문 `{ state, questions, model? }` → `askJev` → Jev 응답 JSON.
- 인증은 기존 middleware(쿠키 `bridge_auth` 또는 `x-bridge-token`)가 처리. 라우트는 얇게 유지.
- 본문 256KB 초과 시 413. `JevError.status`를 HTTP 상태로 매핑.
- 소비자: MCP 도구, 패널·앱 화면(브라우저 JS).

### 3. MCP 도구 `jev_ask`
- 모든 세션·빌더에 노출. 입력 `{ state, questions, model? }` → `POST /api/jev`.
- 도구 설명에 핵심 사용 규칙 요약 + 공용 스킬 `jev` 참조.

### 4. 페르소나 도구 컨텍스트 `context.jev(state, questions, opts?)`
- `tools/*.js`(월드 엔진 포함)에서 `await context.jev(...)`로 호출. `askJev`를 그대로 바인딩.
- **금지(문서화)**: 월드 엔진의 `step()`에서 호출하지 말 것 — 200ms 월드 시계를 네트워크 왕복이 막는다. `observe`·`submit` 이외의 전용 액션이나 일반 페르소나 도구에서 쓴다.

### 5. 패널/앱 브리지 `__panelBridge.jev(state, questions, model?)`
- `use-panel-bridge.ts`에 추가. `fetch('/api/jev')` 래퍼. 브라우저에는 키가 없다.

### 6. 공용 스킬 `data/skills/jev/SKILL.md`
- 세션 AI용 사용법: 언제 쓰나(LLM 대신 빠른 판단), 질문 설계 규칙(영어 질문·기준, 숫자는 코드에서 서술 단계로 변환, 선택지마다 명확한 기준과 "해당 없음" 선택지, 한 질문엔 한 판단, 같은 state의 독립 질문은 한 요청에 묶기), confidence 활용, 세 가지 호출 경로.
- `data/`는 사용자 데이터라 git 밖이다. 세션 Open 시 기존 스킬 전파(`refreshToolSkills`)로 모든 세션에 복사된다.

## 문서·설정 전파

- `.env.example`에 `TYPESAFE_API_KEY=` 자리표시자, `docs/infrastructure.md` env 표 행.
- `docs/architecture.md` Core Libraries 행 + MCP 도구 목록, `docs/api-routes.md` 행, `docs/codebase-map.md` 어휘 행("Jev, TypeSafe, 빠른 판단").
- `docs/frontend.md`: 패널 브리지 `jev` 메서드 언급(해당 절이 있으면).

## 테스트

- `src/lib/jev-client.test.ts` (가짜 fetch 주입): 키 없음 503 / 검증 실패 400 / 429 후 성공(재시도) / 400은 재시도 안 함 / 타임아웃 / 정상 응답 통과.
- 라이브: 서버 재시작 후 `/api/jev` 1회, MCP `jev_ask` 1회.

## 범위 밖

- 스레드 루프 Jev 두뇌 타입, kingdom 주민 행동 어휘 — 다음 스펙.
- 사용량 누적 대시보드, 호출 예산 상한 — 필요해지면.
- 동기 훅(`on-message`/`on-assistant`)에서의 호출 — 훅이 동기라 불가.
