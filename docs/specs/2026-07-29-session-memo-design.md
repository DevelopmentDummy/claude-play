# 세션 메모 (Session Memo) 설계

**작성일**: 2026-07-29
**상태**: 설계 승인됨 (사용자 승인 2026-07-29)

## 문제

같은 페르소나로 진행 중인 세션이 여러 개 쌓이면 로비 사이드바에서 구분이 불가능하다. 현재 `SessionCard`가 보여주는 정보는 `title`(= 페르소나 표시명), 페르소나명, 상대 시간, 프로바이더 배지뿐이고, 이 중 앞의 둘은 같은 페르소나 세션끼리 완전히 동일하다.

## 목표

로비 사이드바 세션 카드에서 각 세션이 "무슨 상황인지"를 한 줄로 식별할 수 있게 한다. 사용자가 직접 쓴 메모를 1순위로 하되, 아무것도 안 써도 카드가 비어 보이지 않도록 자동 폴백을 둔다.

## 비목표

- 세션 제목(`title`) 변경 기능. 메모와 별개 기능이며 이번 범위 밖.
- 메모 검색/필터/태그.
- 빌더 세션 메모. 로비에 노출되지 않으므로 제외.

## 데이터 모델

`session.json`(`SessionMeta`)에 필드 3개 추가. `SessionInfo`에도 동일하게 반영한다.

```jsonc
{
  "memo": "학원 엔딩 직전, 배신 루트 진입",   // 수동. 사용자만 씀
  "autoMemo": "유나와 옥상 대치 중",           // AI가 씀
  "autoMemoAt": "2026-07-29T12:00:00.000Z"     // autoMemo 갱신 시각 (ISO)
}
```

**수동/자동 필드를 분리하는 이유**: 하나로 합치면 자동 갱신이 사용자가 쓴 메모를 덮어쓴다. 분리하면 자동 요약이 어떤 값을 넣든 수동 메모는 불변이다.

세 필드 모두 optional. 기존 세션은 필드 없이 동작한다(마이그레이션 불필요).

### 표시 우선순위

```
memo (수동)  →  autoMemo (AI)  →  최근 유저 발화 프리뷰  →  (없으면 줄 미표시)
```

프리뷰는 `listSessions()`에서 `chat-history.json`의 꼬리 256KB만 읽어 마지막 `role === "user"` 메시지 1줄을 뽑는다(`session-list.ts:readLastJsonlMessage`와 같은 tail-read 패턴, 단 `chat-history.json`은 JSONL이 아니라 JSON 배열이므로 tail 파싱이 아니라 전체 파싱 후 역순 탐색). 세션당 1회, 60자 truncate.

`SessionInfo`에 계산 결과를 `memoFallback?: string`으로 실어 보내고, 우선순위 선택은 프런트에서 한다.

## 자동 갱신

`session-instance.ts`의 `runStyleCheckHook()`이 호출되는 자리(비-OOC assistant 턴 종료 후, `session-instance.ts:1656`)에 `runSessionMemoTick()`을 나란히 추가한다.

1. `variables.json`의 `__session_memo_counter`를 `mutateSessionJsonSync`로 증분. 읽기 실패 시 즉시 return (style-check와 동일한 쓰기 무결성 규칙 — 못 읽은 상태로 덮어쓰지 않는다).
2. `counter % interval !== 0`이면 종료. `interval = 10` (턴).
3. 임계 도달 시 `queueEvent()`로 다음 유저 턴에 병합될 헤더를 큐잉:

```
[MEMO] 지금까지의 전개를 25자 이내 한 줄로 요약해 bridge_set_session_memo 도구로 저장하세요. 응답 본문에서는 이 지시를 언급하지 마세요.
```

`[MEMO]`는 `REPLACE_ONLY_PREFIXES`에 추가한다 — 유저가 오래 자리를 비워 여러 번 임계를 넘겨도 헤더가 쌓이지 않고 최신 1개만 남는다.

**옵트아웃**: `session.json`의 `memoAuto?: boolean` (미설정 = `true`). `false`면 카운터 증분도 하지 않고 즉시 return.

`/api/sessions/[id]/options`는 페르소나가 선언한 옵션 스키마(`readOptionsSchema`)를 다루는 별개 채널이라 여기에 끼워넣지 않는다 — 코어 기능을 페르소나 옵션 스키마에 섞으면 페르소나마다 선언이 필요해진다.

**설계 근거**: 별도 LLM 스폰(fire_ai) 대신 세션 AI 자신에게 시키므로 추가 토큰 비용이 도구 호출 1건 수준이고, 페르소나별 훅 파일 작성 없이 모든 세션에 전역 적용된다. 대가는 RP 턴에 도구 호출이 하나 섞이는 것 — 응답 본문에는 노출되지 않는다.

## MCP 도구

`src/mcp/claude-play-mcp-server.mjs`에 `bridge_set_session_memo` 추가.

- `inputSchema`: `{ memo: z.string() }`
- 동작: `PATCH /api/sessions/{sessionId}/memo`에 `{ autoMemo: memo }` 전송
- 세션 모드에서만 유효. `mode !== "session"`이면 `fail("session mode only")`

## API

**`PATCH /api/sessions/[id]/memo`**

| body | 대상 필드 | 호출자 |
|------|-----------|--------|
| `{ memo: string }` | `memo` | 로비/채팅 UI |
| `{ autoMemo: string }` | `autoMemo` + `autoMemoAt` | MCP 도구 |
| `{ memoAuto: boolean }` | `memoAuto` | 자동 요약 옵트아웃 토글 |

- `memo`와 `autoMemo`를 동시에 보내면 400. `memoAuto`는 단독으로만 보낸다.
- 서버에서 200자 하드 클램프, `trim()`. 빈 문자열은 해당 필드 삭제(메모 지우기).
- 응답: `{ memo?, autoMemo?, autoMemoAt? }` (갱신 후 값).

라우트는 얇게 유지하고 로직은 `session-manager.ts`에:

```ts
setSessionMemo(id: string, memo: string): void      // patchSessionMeta 재사용
setSessionAutoMemo(id: string, text: string): void  // autoMemoAt 동시 갱신
```

`patchSessionMeta()`는 `mutateSessionJsonSync`(tmp+rename) 기반이라 원자적 쓰기가 이미 보장된다.

## UI

### 로비 사이드바 (`SessionCard.tsx`)

기존 2줄 아래 메모 줄을 추가한다:

```
┌────────────────────────────────┐
│ [◉] 유나                        │
│     유나 · 2시간 전 · Claude    │
│     학원 엔딩 직전, 배신 루트…  │
└────────────────────────────────┘
```

- **수동 메모**: 기본 텍스트 색(`text-text-dim`), 정자체 — "내가 쓴 것"이 구분된다.
- **자동 메모 / 발화 프리뷰**: `text-text-mute` + `italic`로 한 단계 흐리게.
- 프리픽스 아이콘은 쓰지 않는다 — hover 편집 버튼이 `✎`라 중복되면 혼동된다.
- 1줄 `truncate`, `title` 속성으로 전문 tooltip.
- 셋 다 없으면 줄 자체를 렌더하지 않아 카드 높이가 기존과 동일.

**인라인 편집**: 삭제 버튼(`×`) 옆에 hover 시 나타나는 `✎` 버튼. 클릭하면 메모 줄이 그 자리에서 `input`으로 전환.

- Enter 저장 / Esc 취소 / blur 저장
- 카드 클릭 = 세션 열기이므로 편집 영역은 `stopPropagation` 필수
- IME 조합 중 Enter 가드 (`e.nativeEvent.isComposing`)
- 저장 성공 시 로비 로컬 state만 낙관적 갱신 — `loadLobby()` 전체 재호출 안 함

### 채팅 헤더 (`StatusBar.tsx`)

StatusBar가 이미 버튼으로 빽빽하므로 버튼을 늘리지 않고 **제목 옆 메모 칩**을 붙인다.

- 메모가 있으면 내용이 흐리게, 없으면 `✎` 아이콘만
- 클릭 시 작은 팝오버 입력창 → 저장 시 같은 PATCH 호출
- 좁은 화면(`sm` 미만)에서는 숨김 — 모바일은 로비에서 편집

## 에러 처리

- 메모 저장 실패 시 토스트로 알리고 인라인 입력값을 되돌린다. `patchSessionMeta`가 실패를 삼키므로 라우트는 쓰기 후 재조회로 성공을 확인한다.
- 자동 요약이 이상한 값을 넣어도 `memo`는 불변 (필드 분리).
- `chat-history.json` 파싱 실패 시 프리뷰는 `undefined` — 카드는 메모 줄 없이 렌더된다.

## 검증

- `npm run typecheck` → `npm run verify`
- 수동 편집 경로: dev 서버에서 로비 인라인 편집 + 채팅 헤더 칩 저장 후 새로고침해 영속 확인
- **자동 갱신 경로는 헤드리스로 검증 불가** — 세션 10턴 진행 후 카드에 `autoMemo`가 뜨는지 라이브 스모크 필요. `HANDOVER.md`의 라이브 스모크 백로그에 등재한다.

## 변경 파일

| 파일 | 변경 |
|------|------|
| `src/lib/session-manager.ts` | `SessionMeta`/`SessionInfo` 필드 3개 + `memoFallback`, `setSessionMemo`/`setSessionAutoMemo`, `listSessions` 프리뷰 계산 |
| `src/lib/session-instance.ts` | `runSessionMemoTick()`, 호출 배선, `REPLACE_ONLY_PREFIXES`에 `[MEMO]` |
| `src/app/api/sessions/[id]/memo/route.ts` | 신규 PATCH 라우트 |
| `src/mcp/claude-play-mcp-server.mjs` | `bridge_set_session_memo` 도구 |
| `src/components/SessionCard.tsx` | 메모 줄 + 인라인 편집 |
| `src/components/StatusBar.tsx` | 메모 칩 + 팝오버 |
| `src/app/page.tsx` | `Session` 인터페이스 필드, 메모 저장 핸들러 |
| `src/app/chat/[sessionId]/page.tsx` | StatusBar에 메모 props 전달 |
| `docs/data-model.md`, `docs/api-routes.md`, `docs/architecture.md` | 문서 반영 |
