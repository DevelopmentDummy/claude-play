# 서브에이전트 대화 모달 패널 + 대화 내역 — 설계

- 날짜: 2026-06-24
- 상태: 설계 승인됨 (구현 플랜 대기)
- 선행: [v1 오케스트레이션](2026-06-07-persona-subagent-orchestration-design.md), [v2 세션 provider 상속](2026-06-09-subagent-follow-session-provider-design.md), [v2.1 고정 모델/프로바이더](2026-06-22-subagent-fixed-model-design.md)

## 배경 / 문제

v1~v2.1로 페르소나 단위 멀티에이전트(상주 서브에이전트)는 동작한다. 그러나 서브와의 상호작용은 **단방향·불투명**하다:

- 서브의 텍스트 응답은 앱이 버린다. `SubAgentInstance`(`src/lib/subagent-instance.ts`) 생성자는 provider 프로세스의 `error`/`sessionId`/`exit`만 구독하고 **`message` 이벤트는 구독하지 않는다**. 서브가 무슨 말을 했는지는 `subagents/{name}/sub.log`에만 남고 UI로 오지 않는다.
- 서브↔메인 트래픽은 fire-and-forget이다. `bridge_delegate`/auto-trigger/hook `dispatch[]`는 작업만 던지고, `report_to_main`은 `[SUB:<name>] <summary>`를 `pending-events.json`에 잠깐 담았다가 다음 메인 턴에 소비한다. **영구 대화 내역이 없다.**
- 사용자가 서브에게 직접 말을 걸 경로가 없다.

요구사항: **사용자가 서브에이전트와 OOC처럼 직접 양방향 대화**하고, **서브↔메인 자율 트래픽까지 한 transcript에서** 메인 채팅처럼 볼 수 있는 **공용 모달 패널**.

## 목표

1. 사용자가 특정 서브에게 직접 메시지를 보내고, 서브가 **대화체로 응답**한다(메인 서사와 분리된 OOC 사이드채널).
2. 직접 메시지는 **풀 액추에이터**다 — 서브는 평소처럼 도구로 상태를 바꾸고 필요하면 `report_to_main`으로 메인에 반영하며, 동시에 운영자에게 대화체로 답한다.
3. 서브별 **대화 내역(transcript)을 영속화**하고, 메인→서브 디스패치(auto/hook/delegate) + 서브 응답 + 서브→메인 report를 **하나의 시간순 transcript**에 담는다.
4. **공용 모달**(메신저형: 좌측 서브 목록 + 우측 transcript/입력)에서 모든 서브를 전환하며 본다.
5. 서브 응답·report는 **실시간 WS 푸시**로 모달에 즉시 반영되고, 모달이 닫혀 있으면 **안읽음 뱃지**로 알린다.

## 비목표

- **토큰 단위 스트리밍 UI.** 서브 응답은 **턴 완료 시 한 번에** 표시한다(라이브 토큰 푸시·메인 수준 파이프라인 회피). 서브는 terse한 백그라운드 워커라 체감 차이가 작다.
- **과거 대화 백필.** 현재 영구 기록이 없으므로 *이 기능 배포 이후부터* 기록한다("지금부터 기록").
- **서브의 도구 호출 단계 시각화.** v1은 텍스트 응답 + report만 보여준다(도구 활동 요약은 `report_to_main`이 이미 제공). 도구-call 칩은 후속.
- **transcript 회전/압축.** v1은 읽기 시 tail 캡으로 대응, 파일 회전은 후속.
- **서브↔서브 대화.** v1 키스톤 결정(서브↔서브는 별도 범위) 유지.

## 핵심 결정 (브레인스토밍 확정)

| 질문 | 결정 |
|---|---|
| 직접 대화의 성격 | 양방향 OOC 사이드채널 (서브가 대화체로 응답) |
| 직접 메시지의 효력 | 풀 액추에이터 (상태 변경·report_to_main 가능 + 대화체 응답) |
| 응답 표시 | 턴 완료 시 한 번에 (스트리밍 X) |
| 모달 레이아웃 | 메신저형(좌측 사이드바 서브 목록 + 우측 transcript) |
| 진입점 | 기존 StatusBar 도구 드롭다운에 통합 + 안읽음 뱃지로 알림 보강 |

## 설계

검증으로 확인된 provider message 형태:

- **4개 비-Claude provider(Codex/Gemini/Kimi/Antigravity)는 통일 형태**를 emit한다: 텍스트는 `{ type:"assistant", subtype:"text_delta", message:{ role:"assistant", content:<string> } }`, 턴 종료는 `{ type:"result" }`.
- **Claude만** 원시 stream-json을 그대로 emit한다. 텍스트는 `{ type:"stream_event", event:{ type:"content_block_delta", delta:{ type:"text_delta", text } } }`(스트리밍) 또는 `{ type:"assistant", message:{ content:[{ type:"text", text }] } }`(비스트리밍/누적)로 오고, `result` 메시지의 `result`/`result.text`는 폴백이다.

→ "최종 텍스트만 캡처"는 메인의 풀 파이프라인(UTF-8 healing·도구 dedup·history·hooks·TTS)보다 훨씬 단순한 경량 누적기로 가능하다(아래 §2). 단 Claude는 stream_event 경로라 비-Claude의 통일 `text_delta`와 분리 처리하고, 스트림 델타와 최종 assistant 메시지의 텍스트 이중계수를 `sawTextDelta` 가드로 막는다.

### 1. 데이터 모델 — per-sub transcript

파일: `data/sessions/{id}/subagents/{name}/transcript.jsonl` (append-only). 세션 디렉터리 스코프라 페르소나 publish와 무관하지만, 혹시 모를 누출 방지를 위해 publish/clone gitignore·미러 SKIP 목록에 `subagents/*/transcript.jsonl`을 추가한다(`.resume*` 처리와 동일 패턴).

한 줄 = 한 이벤트:

```jsonc
// 서브로 들어가는 작업(디스패치). origin이 트리거 출처.
{ "ts": "2026-06-24T...", "dir": "in",  "kind": "dispatch", "origin": "operator", "text": "..." }
// origin ∈ "operator" | "auto" | "hook" | "delegate"
// 서브의 텍스트 응답(대화/작업 결과).
{ "ts": "...", "dir": "out", "kind": "response", "text": "..." }
// 서브가 report_to_main으로 메인에 보낸 요약(메인 큐에도 들어감).
{ "ts": "...", "dir": "out", "kind": "report", "text": "..." }
```

표시 매핑(§6):
- `dispatch`/`origin:"operator"` → 내 말풍선(우측)
- `response` → 서브 말풍선(좌측)
- `dispatch`/`origin:"auto"|"hook"|"delegate"` → 옅은 시스템 라인(자율 트래픽, 시각 노이즈 최소화)
- `report` → "→메인" 칩

읽기: tail 최근 N개(기본 200)만 반환. 파일은 무한 증가하나 텍스트라 작고, 회전은 후속.

### 2. 캡처 — `SubAgentInstance`가 `message` 구독

서브는 메인의 풀 파이프라인이 필요 없으므로 **최종 텍스트만 모으는 경량 누적기**를 둔다. 상태: `responseBuf: string`, `sawTextDelta: boolean`(턴 단위). 생성자에서 `message` 구독:

```text
this._process.on("message", (d) => {
  const msg = d as Record<string, unknown>;
  const am = msg.message as Record<string, unknown> | undefined;

  // 1) 비-Claude 통일 델타
  if (msg.type === "assistant" && msg.subtype === "text_delta") {
    if (typeof am?.content === "string") { this.responseBuf += am.content; this.sawTextDelta = true; }
    return;
  }
  // 2) Claude 스트리밍 델타
  if (msg.type === "stream_event") {
    const ev = msg.event as Record<string, unknown> | undefined;
    const delta = ev?.delta as Record<string, unknown> | undefined;
    if (ev?.type === "content_block_delta" && delta?.type === "text_delta" && typeof delta.text === "string") {
      this.responseBuf += delta.text; this.sawTextDelta = true;
    }
    return;
  }
  // 3) Claude 비스트리밍 텍스트 (스트림 델타가 없었던 턴만 — 이중계수 방지)
  if (msg.type === "assistant" && !this.sawTextDelta && am) {
    if (typeof am.content === "string") this.responseBuf += am.content;
    else if (Array.isArray(am.content))
      for (const b of am.content) { const bb = b as Record<string, unknown>;
        if (bb.type === "text" && typeof bb.text === "string") this.responseBuf += bb.text; }
    return;
  }
  // 4) 턴 종료 → flush
  if (msg.type === "result") {
    const r = msg.result as Record<string, unknown> | string | undefined;
    const fromResult = typeof r === "string" ? r : (typeof r?.text === "string" ? r.text : "");
    const final = (this.responseBuf.trim() || (fromResult as string).trim());
    this.responseBuf = ""; this.sawTextDelta = false;
    if (final) this.appendTranscript({ dir: "out", kind: "response", text: final });
  }
});
```

- 메인의 `pushTextOnce`/`sawTextDelta` 가드를 축약 차용 — Claude가 스트림 델타와 최종 assistant 메시지에 텍스트를 중복 적재해도 한 번만 센다.
- 비-Claude는 버퍼, Claude는 stream_event 누적, 둘 다 비면 `result.result`/`.text` 폴백.
- 도구 전용 턴(텍스트 없음)은 `final`이 빈 문자열 → transcript에 안 남김(노이즈 방지).
- `appendTranscript`가 파일 append + WS 푸시(§5)를 모두 수행.

### 3. 디스패치 origin 태깅 + OOC 계약 완화

`SubAgentInstance.dispatch(task)` → `dispatch(task, origin)`로 확장(`origin: "operator"|"auto"|"hook"|"delegate"`, 기본 `"delegate"`). 동작:

1. transcript에 `{ dir:"in", kind:"dispatch", origin, text: task }` append.
2. `origin === "operator"`면 페이로드에 OOC 마커를 prepend: `[OPERATOR]\n<task>` (서브가 운영자 직접 메시지임을 인지).
3. 이후 기존 흐름(start/waitForReady/priming/send) 그대로.

`buildSubSystemPrompt`(role preamble)에 한 줄 추가:
> "예외: `[OPERATOR]`로 시작하는 메시지는 인간 운영자가 OOC로 너에게 직접 말하는 것이다 — 그 턴에는 운영자에게 간결한 대화체로 답하라. 필요하면 평소처럼 도구·report_to_main도 쓸 수 있다."

이로써 "사용자에게 말하지 않는다" 계약과 충돌 없이 OOC 모드만 예외 허용.

호출부 origin 매핑(`SubAgentManager.dispatch(name, task, origin)`로 전달):
- auto-trigger(`session-instance.ts` autoDefs 루프) → `"auto"`
- on-assistant hook `dispatch[]` → `"hook"`
- `bridge_delegate` 라우트 → `"delegate"`(기본)
- 신규 user message 라우트 → `"operator"`

### 4. 라우트

**신규 3개:**
- `POST /api/sessions/[id]/subagents/[name]/message` — body `{ text }` → `instance.subAgents.dispatch(name, text, "operator")`. 사용자 직접 입력 경로.
- `GET  /api/sessions/[id]/subagents` — 서브 목록 `[{ name, role, provider, model, running }]`. `SubAgentManager`에 `listDetailed()` 추가.
- `GET  /api/sessions/[id]/subagents/[name]/transcript` — tail 엔트리 배열. (서버에서 jsonl 파싱 후 마지막 N줄.)

**기존 2개 확장:**
- `events` 라우트: `header`가 `[SUB:<name>] <summary>` 패턴이면 파싱해 `instance.subAgents.recordReport(name, summary)`도 호출(메인 큐잉 `queueEvent`는 유지). → report가 transcript에 `kind:"report"`로 남고 WS 푸시.
- `subagents/[name]/dispatch` 라우트: 변경 없음(origin 기본 `delegate`).

### 5. WS 푸시 + 매니저 배선

- `SessionInstance` 생성자에서 `SubAgentManager`에 broadcast 콜백 주입: `new SubAgentManager(id, () => this.getDir(), (ev, data) => this.broadcast(ev, data))`.
- `SubAgentManager`는 콜백을 인스턴스 생성 시 `SubAgentInstance`에 전달.
- `SubAgentInstance.appendTranscript(entry)`: 파일 append + `broadcast("subagent:message", { name: this.name, entry })`.
- `recordReport`도 같은 경로(`appendTranscript({dir:"out", kind:"report", text})`).

### 6. UI — 신규 `SubAgentChatModal.tsx` + StatusBar 통합

**모달**(`createPortal`, 메신저형):
- 좌측 사이드바: `GET /subagents` 목록. 각 항목에 상태점(running)·provider 뱃지·안읽음 카운트.
- 우측: 선택된 서브의 transcript(열 때 `GET .../transcript`로 초기 로드, 이후 WS append) + 하단 입력창(`POST .../message`).
- 마크다운 렌더는 `ChatMessages`가 쓰는 인라인 포매터/렌더러 재사용.
- transcript `kind`/`origin`별 렌더(§1 매핑).

**StatusBar 통합**(`src/components/StatusBar.tsx`):
- 도구 드롭다운(☰)에 "서브에이전트 (N)" 항목 추가(`onSubAgents` + `subAgentUnread` props). 서브 0개면 항목·버튼 미노출(`hasDebugItems`에 합류).
- 안읽음 보강: 미읽음 > 0이면 ☰ 버튼에 작은 점/숫자 배지.

**상태 관리**(`chat/[sessionId]/page.tsx`):
- `subagent:message` WS 핸들러 추가: 모달 열림+해당 서브 포커스면 transcript에 직접 append, 아니면 해당 서브 unread++.
- 모달 열고 서브 포커스 시 그 서브 unread=0.

### 영향 파일

| 파일 | 변경 |
|---|---|
| `src/lib/subagent-instance.ts` | `message` 구독 + 응답 버퍼/`result` flush, `appendTranscript`, `dispatch(task, origin)` + OOC 마커, `buildSubSystemPrompt` 한 줄, broadcast 콜백 수용 |
| `src/lib/subagent-manager.ts` | broadcast 콜백 주입/전달, `dispatch(name,task,origin)`, `recordReport(name,summary)`, `listDetailed()` |
| `src/lib/session-instance.ts` | `SubAgentManager` 생성 시 broadcast 주입, autoDefs/hook 디스패치에 origin 전달 |
| `src/app/api/sessions/[id]/subagents/[name]/message/route.ts` | **신규** user 직접 입력 |
| `src/app/api/sessions/[id]/subagents/route.ts` | **신규** 목록 |
| `src/app/api/sessions/[id]/subagents/[name]/transcript/route.ts` | **신규** transcript tail |
| `src/app/api/sessions/[id]/events/route.ts` | `[SUB:]` 파싱 → `recordReport` |
| `src/components/SubAgentChatModal.tsx` | **신규** 메신저형 모달 |
| `src/components/StatusBar.tsx` | 도구 메뉴 항목 + 안읽음 배지 |
| `src/app/chat/[sessionId]/page.tsx` | 모달 마운트, WS 핸들러, unread 상태 |
| publish/clone gitignore·미러 SKIP | `subagents/*/transcript.jsonl` 추가 |

`ai-process-factory.ts`·5개 provider 프로세스 클래스·`subagent-registry.ts`는 무변경(재사용).

## 알려진 한계 (문서화)

- **디스패치 인터리브.** dispatch는 fire-and-forget이고 빠른 연속 디스패치가 겹치면 응답 버퍼/순서가 드물게 혼선될 수 있다. provider 턴이 직렬 처리되고 `waitForReady` 게이트가 있어 실사용 영향은 작다. 완전 직렬화는 후속.
- **transcript 무한 증가.** append-only. v1은 읽기 tail 캡(N=200)으로 대응. 회전/압축은 후속.
- **autoTrigger 트래픽.** autoTrigger 서브는 매 메인 턴 기록되어 transcript가 빠르게 길어진다. 옅은 시스템 라인으로 시각 노이즈를 줄이되, 기록 자체는 유지(관찰성).
- **OOC report 누출.** "풀 액추에이터" 결정상, 운영자와의 OOC 대화 중 서브가 상태를 바꾸면 `report_to_main`이 메인 큐에 들어갈 수 있다(의도된 동작). 순수 대화(상태 무변경)면 서브가 report하지 않으므로 메인에 새지 않는다.
- **kimi 서브.** kimi는 conversation id를 캡처하지 않아 매 세션 fresh+re-prime이다(기존 동작). transcript는 세션 단위로 누적되므로 영향 없음.

## 검증

- `npx tsc --noEmit` 그린 (next build 금지 — 라이브 `.next`).
- 라이브 스모크(사용자):
  1. 서브 1개 페르소나로 세션 open → 도구 메뉴 "서브에이전트" → 모달 좌측에 서브 표시·running 상태점 확인.
  2. 서브에게 직접 메시지 → 서브가 대화체로 응답(우/좌 말풍선) + `transcript.jsonl`에 `dispatch(operator)`/`response` 기록.
  3. 서브가 상태 변경 후 `report_to_main` → "→메인" 칩 + 메인 다음 턴에 `[SUB:]` 합류 확인.
  4. auto-trigger 서브가 매 메인 턴 옅은 시스템 라인으로 transcript에 쌓이는지.
  5. 모달 닫은 상태에서 서브 응답 도착 시 도구 메뉴/☰ 안읽음 배지 증가 → 열면 클리어.
  6. provider별 1회(claude 메인 + v2.1 핀으로 다른 provider 서브) 응답 캡처 동작.
