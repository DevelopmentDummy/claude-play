# 페르소나 서브에이전트 오케스트레이션 — 설계 (v1: 코어 백본)

- **작성일**: 2026-06-07
- **상태**: 승인됨 (설계) → 구현 플랜 작성 대기
- **범위**: v1 = 코어 백본 (sub↔main 양방향). sub↔sub·관리 UI는 후속 페이즈.

## 1. 목적 (Goal)

현재 단일 세션 = 단일 AI 인스턴스 구조를, **페르소나 단위의 멀티 에이전트 오케스트레이션**으로 확장한다.

- 각 페르소나 세션은 **메인 서사 인스턴스 1개** + **빌더에서 미리 구성한 전문화 서브 인스턴스 N개**를 가진다.
- 서브는 메인이 신경 쓰기 어렵거나(흐름제어·패널 변수 부기) 컨텍스트상 굳이 챙기고 싶지 않은 영역을 전담한다.
- 메인↔서브는 **훅 스크립트** 또는 **메인의 명시 요청**으로 작업이 디스패치되고, 서브의 결과는 **이벤트 큐(비동기)** 로 쌓여 **다음 유저 입력 때 메인에 합류**한다.

핵심 통찰: 이 흐름의 배관 상당 부분이 이미 코드베이스에 존재한다.
- 이벤트 큐 → 다음 유저 턴 prepend: `pending-events.json` + `SessionInstance.flushEvents()` ([session-instance.ts:446](../../src/lib/session-instance.ts#L446))
- 백그라운드 AI spawn: `spawnBackgroundClaude()` ([background-session.ts](../../src/lib/background-session.ts))
- 별도 프로세스 → 메인 큐 적재: `POST /api/sessions/{id}/events` (MCP가 이미 사용, [claude-play-mcp-server.mjs:750](../../src/mcp/claude-play-mcp-server.mjs#L750))
- MCP 신원/콜백: env(`CLAUDE_PLAY_SESSION_DIR`/`_AUTH_TOKEN`) 기반 ([claude-play-mcp-server.mjs:8-14](../../src/mcp/claude-play-mcp-server.mjs#L8))

빠진 것은 (1) one-shot fire_ai를 **영속·역할고정 서브 인스턴스**로 승격, (2) **디스패치/라우팅 레이어**, (3) **빌더 정의 스키마** 세 가지다.

## 2. 키스톤 결정 (확정)

| # | 결정 | 선택 | 함의 |
|---|---|---|---|
| 1 | 서브 수명 모델 | **Always-on 상주** | 세션 open 시 서브를 라이브 프로세스로 spawn해 상주. 최저 지연, 컨텍스트가 프로세스에 자연 유지. 비용: 세션당 N+1 프로세스, 수명관리 부담 |
| 2 | 트리거/라우팅 | **둘 다** (훅 자동 + 메인 명시 위임) | 훅(on-assistant)이 메인 턴 보고 자동 디스패치 + 메인이 MCP `bridge_delegate`로 명시 호출 |
| 3 | 서브 권한 | **직접 액추에이터** | 서브가 세션 dir 공유, 패널 변수·데이터 직접 변경 + 변경 요약을 큐로 메인에 통지 |
| 4 | v1 범위 | **코어 백본** (sub↔main 양방향) | 상주 런타임 + 빌더 스키마 + 양방향 트리거 + 직접 액추에이터 + sub→main 큐 + provider-per-sub. sub↔sub·UI 제외 |
| 5 | 레지스트리 구조 | **부모 소유** | `SessionInstance`가 `subAgents: Map<name, SubAgentInstance>` 보유. 메인 생존주기에 서브 연쇄 |
| 6 | 전달 타이밍 | **순수 비동기** | send 시점 큐에 있는 것만 flush, in-flight 서브 요약은 다음 턴에 합류 |
| 7 | 트리거 선언 | **선언적 + 훅 JS** | 매니페스트 `autoTrigger`(노코드) 또는 `on-assistant.js`의 `dispatch[]`(유연) 둘 다 코어가 읽음 |

## 3. 아키텍처

세션 1개 = OS 프로세스 N+1개, 모두 같은 cwd(세션 dir) 공유.

```
data/sessions/{persona}-{ts}/           ← 공유 세션 dir (메인+서브 cwd)
├─ session.json, variables.json, ...    ← 공유 상태 (직렬 writer 경유 변경)
├─ chat-history.json                     ← 메인 서사 히스토리 (유저가 보는 것)
├─ subagents.json                        ← [신규] 서브 매니페스트 (빌더 산출물, 세션에 복사)
├─ subagents/                            ← [신규] 서브별 격리 영역
│   ├─ panel-updater/
│   │   ├─ history.json                  ← 서브 자기 대화 히스토리 (always-on 상주)
│   │   ├─ instructions.md               ← 서브 시스템 프롬프트 (빌더 생성)
│   │   └─ sub.log
│   └─ lore-keeper/ ...
└─ pending-events.json                   ← [기존] sub→main 큐 (그대로 재사용)
```

### 3.1 컴포넌트

| 컴포넌트 | 역할 | 기반/참고 |
|---|---|---|
| `SubAgentInstance` (신규) | 서브 1개 = AIProcess + 자기 history + 이벤트 누적. **PanelEngine 없음** (패널 UI는 메인 전용; 서브는 변수만 변경) | `SessionInstance`의 경량 버전 |
| `SubAgentManager` (신규) | 부모 `SessionInstance`에 종속. 매니페스트 읽어 서브 spawn/생존/정리, 이름→인스턴스 라우팅, 디스패치 진입점 | `session-registry.ts` 패턴 |
| `subagents.json` (신규) | 서브 매니페스트 (3.4 스키마) | 빌더 산출물 |
| 디스패치 라우트 (신규) | `POST /api/sessions/{id}/subagents/{name}/dispatch` → `SubAgentInstance.sendMessage(task)` | `fire-ai` 라우트 패턴 |
| `bridge_delegate` (신규 MCP) | 메인이 서브에게 명시 위임 | `fire_ai` 도구 패턴 |
| 이벤트 큐 (기존) | 서브 요약을 `POST /api/sessions/{id}/events`로 적재 → 다음 유저 턴 합류 | **이미 존재** |
| MCP 신원 확장 (기존+α) | 서브 프로세스 env에 `CLAUDE_PLAY_SUBAGENT_NAME` 추가 → 이벤트 헤더 `[SUB:name]` 자동 태깅 | env 주입 지점 확장 |

## 4. 데이터 흐름

### ① 훅 자동 디스패치 (메인은 모름)
```
메인 assistant 턴 종료 → on-assistant.js (기존 훅) 실행
  → 반환값 신규 필드: { dispatch: [{ to:"panel-updater", task:"전투 결과 반영" }] }
  → 코어(runAssistantHooks)가 subManager.dispatch(name, task) 호출
  → SubAgentInstance.sendMessage(task). 비동기 — 메인 턴은 즉시 유저에 반환.
```
선언적 대안: 매니페스트 `autoTrigger:"onAssistantTurn"`이면 코어가 매 메인 턴 후 기본 task로 자동 디스패치(훅 JS 불필요).

### ② 메인 명시 위임 (MCP)
```
메인이 턴 중 bridge_delegate({ to:"lore-keeper", task:"지명 설정 일관성 확인" })
  → POST /api/sessions/{id}/subagents/{name}/dispatch → SubAgentInstance.sendMessage(task)
```

### ③ 서브 실행 → 직접 액추에이션
```
SubAgentInstance: 역할 instructions + task + (직접 읽은 변수 스냅샷)으로 턴 수행
  → MCP/API로 변수·데이터 직접 변경 (direct actuator, 4.1 직렬 writer 경유)
  → 턴 종료 시 요약을 메인 큐에 적재:
     POST /api/sessions/{id}/events { header: "[SUB:panel-updater] hp 80→55, 적 비틀거림" }
```

### ④ 다음 유저 입력 합류 (기존 메커니즘)
```
유저 다음 입력 → SessionInstance.sendMessage() → flushEvents()가 [SUB:...] 헤더를 메시지 앞 prepend
  → 메인이 "내가 안 보는 사이 일어난 일"로 읽고 서사에 녹임
```

### 4.1 동시성 (필수 — 메모리 F1 미완 항목 마무리)
메인+서브 N개가 같은 `variables.json`을 쓰는 **다중 OS 프로세스 레이스**가 생긴다.

해결: 변수 변경을 **서버 단일 직렬 writer**로 모은다.
- 서브는 raw `fs.write` 대신 `update_variables` API 경로로 변경을 *요청*한다.
- 메인 서버 프로세스가 atomic(tmp+rename) + `retryOnWindowsLock`([fs-retry.ts](../../src/lib/fs-retry.ts))으로 직렬 반영.
- 서브는 여전히 결정/행위자(direct actuator)지만, 디스크 쓰기는 한 곳을 통과 → 레이스 원천 차단.
- 단일 Node 서버 프로세스의 이벤트 루프가 직렬화를 보장하므로, 별도 OS 프로세스에서 온 요청도 안전하게 순차 반영된다.

## 5. 빌더 설정 스키마

서브는 **빌더 단계에서 정의 → 페르소나 dir에 저장 → 세션 생성 시 세션 dir로 복사**(기존 페르소나 파일 흐름 + open 시 additive mirror).

### 5.1 `subagents.json`
```jsonc
{
  "version": 1,
  "subagents": [{
    "name": "panel-updater",            // [a-z0-9-], 고유, 디렉토리명으로 사용
    "role": "전투·상태 패널 변수 관리자",   // 사람용 설명
    "provider": "claude",                // penta-runtime 중 택1 (claude|codex|gemini|kimi|antigravity)
    "model": "claude-haiku-4-5",         // 저비용 모델 가능 (메인=Opus, 서브=Haiku)
    "effort": "low",                     // optional
    "instructions": "instructions.md",   // 서브 dir 상대경로 → 서브 시스템 프롬프트
    "delegable": true,                   // 메인이 bridge_delegate로 호출 가능
    "autoTrigger": "onAssistantTurn",    // "onAssistantTurn" | "none"(훅 JS가 제어)
    "autoTriggerTask": "최근 턴을 반영해 네 영역의 변수를 갱신하라", // autoTrigger 시 기본 task
    "emitSummary": true,                 // 턴 종료 시 [SUB:name] 요약을 메인 큐에 적재
    "writes": ["combat.*", "status.*"]   // v1: 권고용 문서 주석 (강제 X — 후속 페이즈)
  }]
}
```

### 5.2 빌더 통합
- `builder-prompt.md` 메타프롬프트에 "서브에이전트 정의" 섹션 추가 — 빌더 AI가 페르소나 특성에 맞는 서브를 제안/구성하도록 안내.
- 신규 빌더 MCP 도구 `bridge_define_subagent` — 매니페스트 항목 + `instructions.md` 작성/검증(이름 충돌·cap·스키마 체크).
- 유저는 기존처럼 빌더 AI와 자연어로 협업.

## 6. 생존주기 · 에러처리

### 6.1 생존주기
- **생성** (`POST /api/sessions`): `subagents.json` + `subagents/`를 페르소나→세션 dir 복사.
- **open** (`POST /api/sessions/[id]/open`): 메인 spawn → ready 후 `SubAgentManager`가 매니페스트 읽어 서브별 프로세스 spawn(provider별, env에 `CLAUDE_PLAY_SUBAGENT_NAME` 주입, 각자 `history.json` resume). 서브 cwd=세션 dir → 서브 MCP의 `events` 콜백이 메인 세션 정조준.
- **정리**: 마지막 클라이언트 해제 → grace(10분) → 메인 `closeSessionInstance`가 서브 연쇄 destroy. 서버 종료 시 `destroyAllInstances` 연쇄.
- **고아 reap**: 서브 PID를 `data/.runtime/`에 영속화(agy PID 레지스트리 패턴 재사용) → dev 재시작 시 좀비 정리.
- **재시작 복구**: 서브는 런타임 일회성 — 재시작 후 매니페스트로 재spawn + `history.json` resume. 별도 마커 불필요(상태는 history + 공유 variables.json에 이미 영속). 메인 restart 마커 흐름은 불변.

### 6.2 에러처리 (메모리 하드닝 패턴 재사용)
- 서브 spawn 실패/중도 사망: 로그 + `[SUB:name 오류]`를 메인 큐에 적재(메인·유저가 조용히 기다리지 않게) + 각 서브 프로세스에 default no-op error listener(`unhandledRejection` 크래시 방지, [commit c60c282 패턴](../../src/lib/antigravity-process.ts)).
- 빈 응답: 큐에 노이즈 안 넣음.
- 미지정/비활성 서브 디스패치: API 4xx + 훅 dispatch는 로그 후 skip.
- 리소스 상한: 세션당 서브 수 cap(기본 6, env override) — 매니페스트 검증 시 강제.

## 7. v1 범위 경계 (명시적 non-goal)
- ❌ sub↔sub 직접 통신 → Phase 3
- ❌ 전용 관리 UI / 라이브 모니터 → Phase 3 (v1은 최소 WS `subagent:status` 브로드캐스트만 선택적)
- ❌ blocking/drain 전달 (순수 비동기 채택)
- ❌ 변수 네임스페이스 소유권 강제 (매니페스트 `writes`는 v1 권고 주석)
- ❌ lazy/resumable 수명 (always-on 채택)

## 8. 후속 페이즈 (참고)
- **Phase 2**: 메인↔서브 양방향 위임 고도화(서브가 메인에 질의·응답 대기 등), provider-per-sub 비용 최적화 검증.
- **Phase 3**: sub↔sub 직접 통신(라우팅 그래프·루프/교착 가드), 전용 관리 UI(서브 활동 모니터·수동 제어), 변수 네임스페이스 소유권 강제.

## 9. 검증 전략
테스트 프레임워크 없음(CLAUDE.md) → 다음으로 검증:
1. `npx tsc` 그린.
2. `npm run build` 그린.
3. dev 서버 수동 스모크: 서브 1개(panel-updater) 페르소나 생성 → 세션 open → 서브 프로세스 spawn 확인(로그/PID) → 메인 턴 1회 → `variables.json` 변경 + 다음 유저 턴에 `[SUB:panel-updater]` 헤더 합류 확인.
4. 정리 검증: 클라이언트 해제 → grace 후 서브 프로세스 종료 확인. 서버 재시작 → 고아 reap 확인.

## 10. 변경 영향 파일 (예상, 플랜에서 확정)
- 신규: `src/lib/subagent-instance.ts`, `src/lib/subagent-manager.ts`, `src/app/api/sessions/[id]/subagents/[name]/dispatch/route.ts`
- 수정: `src/lib/session-instance.ts`(subAgents 보유·디스패치 연동·on-assistant `dispatch[]` 처리), `src/lib/session-registry.ts`(연쇄 정리), 세션 open 라우트(서브 spawn), `src/mcp/claude-play-mcp-server.mjs`(`bridge_delegate`·`SUBAGENT_NAME` 태깅), `builder-prompt.md`(`bridge_define_subagent`), 변수 직렬 writer(atomic+lock), `.gitignore`/세션 미러 SKIP 목록(`subagents/*/history.json`·`sub.log`)
- 문서: `docs/session-lifecycle.md`, `docs/architecture.md`, `docs/data-model.md`, `docs/change-propagation.md`
