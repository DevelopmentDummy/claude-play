# 앱 모드 페르소나 기술 명세

> **독자**: 빌더 AI. 사용자가 "게임처럼", "시뮬레이션", "NPC들이 알아서 움직이는", "채팅 말고 화면에서 조작하는"
> 페르소나를 원할 때 이 문서를 읽고 만든다. 일반 RP 페르소나는 이 문서가 필요 없다 — `panel-spec.md`를 보라.
>
> 설계 근거: `docs/specs/2026-09-12-app-mode-platform-design.md`. 동작하는 최소 예제: `scripts/fixtures/app-mode-stub/`.

## 0. 앱 모드가 뭔가

보통 페르소나는 **중앙 채팅 + 주변 패널**이다. 앱 모드는 그 전제를 뒤집는다:

- **전용 앱 화면**이 메인 영역을 차지한다 (타일맵, 대시보드, 보드게임판 — 뭐든)
- 플레이의 중심은 유저↔AI 대화 턴이 아니라 **앱에서의 조작**이다
- 캐릭터/관리자 역할을 맡은 **AI 스레드들이 각자 주기로 자기 턴을 돈다**
- 메인 서술자는 조용히 있다가 유저가 말을 걸 때만 깨어난다

**언제 쓰나**: 세계가 유저 없이도 굴러가야 할 때. NPC가 자기 삶을 살아야 할 때. 조작이 서술보다 중요할 때.
**언제 쓰지 마나**: 대화가 본체인 RP. 앱 모드는 훨씬 복잡하고, 채팅 페르소나로 되는 일을 굳이 이걸로 하지 마라.

## 1. 구성 요소 다섯 개

| 파일 | 역할 | 없으면 |
|---|---|---|
| `layout.json`의 `app` 블록 | 앱 모드 스위치 | 앱 모드가 아예 안 켜진다 |
| `app/index.html` | 앱 화면 (HTML+CSS+JS 한 파일 또는 자산 분리) | 화면이 안 뜬다 |
| `tools/world.js` | **월드 엔진** — 규칙이 사는 유일한 곳 | 아무것도 안 돌아간다 |
| `roles/*.md` | 역할 지침 (같은 역할의 스레드들이 공유) | 스레드가 빈 역할로 돈다 |
| `subagents.json`의 `roles`/`threads` | 어떤 역할이 있고 몇 개가 도는지 | 스레드가 안 뜬다 |
| `world.json` | 월드 초기 상태 | 엔진이 빈 상태에서 시작 (보통 시드를 준다) |

## 2. `layout.json`

```jsonc
{
  "app": {
    "entry": "app/index.html",   // 필수. 세션 디렉토리 기준 경로
    "engine": "world",           // tools/{engine}.js. 기본 "world"
    "worldFile": "world.json",   // 월드 상태 파일. 기본 "world.json"
    "worldTickMs": 1000          // 월드 시계 간격(ms). 기본 1000, 하한 100.
                                 // AI 턴과 무관하게 이 주기로 step()이 불린다
  },
  "chat": {
    "mode": "dock"               // "normal"(기존) | "dock"(앱+하단 챗) | "hidden"(앱만)
  },
  "panels": { "position": "hidden" },
  "theme": { "...": "평소처럼" }
}
```

`engine`·`worldFile`은 **경로 구분자 없는 단일 이름**이어야 한다 (`/`·`\`·`..` 넣으면 앱 모드가 통째로 꺼진다).
`chat.mode`는 기존 `chat.maxWidth`/`chat.align`에 **추가**되는 필드다 — 기존 키를 지우지 마라.

처음 만들 때는 `"dock"`을 권한다. 챗이 남아 있어야 사용자가 AI와 대화하며 디버깅할 수 있다.

## 3. 월드 엔진 (`tools/world.js`) — 가장 중요한 파일

### 3.1 계약

기존 커스텀 도구와 같은 형식이다: CommonJS 함수 하나를 export하고, `args.action`으로 분기하고,
`{ variables?, data?, result? }`를 반환한다. 반환한 `data` 패치는 **코어가** 원자적으로 적용한다.

```js
module.exports = async function world(ctx, args) {
  const w = (ctx.data && ctx.data.world) || {};   // world.json의 현재 내용
  switch (args.action) {
    case "observe":  { /* 읽기 전용 */ }
    case "submit":   { /* 의도를 큐에 넣기만 */ }
    case "step":     { /* 큐를 꺼내 규칙 적용 */ }
    case "snapshot": { /* 앱 렌더용 상태 */ }
  }
};
```

| action | 누가 부르나 | 해야 하는 일 | 상태 변경 |
|---|---|---|---|
| `observe(observerId, since)` | 코어(매 틱), 메인 턴 시작 | 그 관찰자가 **지금 보는 것**을 텍스트로 | 금지 |
| `submit(observerId, intent)` | 스레드·앱 | 의도를 큐에 **추가만**. 검증 금지 | 큐만 |
| `step()` | 코어(**월드 시계**마다 1회) | 도착해 있는 의도를 꺼내 검증·적용 + **시간 경과** | 여기서만 |
| `snapshot()` | 앱 | 렌더에 필요한 상태 | 금지 |

### 3.2 절대 어기면 안 되는 세 가지

**① 규칙은 `step()`에만 둔다.** `submit`은 아무것도 검증하지 않는다. 유저 조작도 스레드 의도와 **같은 `submit`을
탄다** — 그래야 규칙이 한 곳에만 존재한다. "유저니까 봐준다" 같은 분기를 `submit`에 넣지 마라.

**② 의도 큐는 배열이 아니라 키 있는 객체다.**

```js
// ✅ 올바름 — 형제 키가 보존되므로 동시 제출이 안전하다
return { data: { world: { $merge: "deep",
  intents: { [`${id}__${seq}`]: { seq, at: Date.now(), observerId: id, intent } } } } };

// ❌ 틀림 — 패치 적용기가 배열을 "교체"하므로, 동시에 제출한 두 스레드 중
//    나중 것이 먼저 것을 지운다. 의도가 조용히 사라진다.
return { data: { world: { intents: [...w.intents, newIntent] } } };
```

키에 `.`을 넣지 마라 — 드레인이 dot-path(`$unset: ["intents.a__1"]`)라 깨진다. `{observerId}__{seq}` 형식을 쓰라.
처리 순서는 키 순서가 아니라 각 항목의 `seq`/`at`으로 정렬해서 정한다.

**③ `step()`은 의도가 없어도 불린다 — 시간은 계속 흐른다.**

월드 시계(`layout.app.worldTickMs`, 기본 1초)가 AI와 **무관하게** `step()`을 부른다. AI 스레드는
백그라운드에서 각자 돌다가 끝날 때 `submit`으로 큐에 넣고, `step()`은 그때그때 **도착해 있는 것만** 꺼낸다.
윈도우 메시지 펌프와 같다 — 메시지가 있으면 처리하고 없으면 넘어간다.

따라서 `step()`은 두 가지를 한다:

```js
case "step": {
  const entries = Object.entries(state.intents).sort((a,b) => a[1].seq - b[1].seq);
  // (1) 도착해 있는 의도 처리 — 0건일 수 있다. 정상이다
  //     한 번에 여러 건이 와 있으면 같이 보고 경합을 판정할 수 있다
  // (2) 의도와 무관한 세계 진행 — 시간, 배고픔, 작물 성장, 이동 중인 개체의 한 칸 전진…
  //     이걸 (1) 안에만 넣으면 AI가 조용할 때 세계가 얼어붙는다
}
```

늦게 도착한 의도는 다음 틱에 처리된다. 관측 시점과 적용 시점이 어긋나는 것은 **전제**다 —
스레드가 본 세계는 이미 움직였을 수 있으니, 규칙에 맞지 않으면 기각하고 사유를 남겨라.

`worldTickMs`는 게임 페이싱이다. 1초면 부드럽고, 5초면 턴제에 가깝다. 스레드의 `intervalMs`(AI가 얼마나
자주 생각하는가)와는 **별개로** 잡으라 — 월드 틱은 LLM을 태우지 않으므로 촘촘해도 비용이 없다.

**④ 엔진은 기억을 못 가진다.** 코어가 매 호출 모듈 캐시를 비우므로 모듈 스코프 변수는 다음 호출에 사라진다.
모든 상태는 `world.json`에 있어야 한다. 그리고 실행 시간은 **10초**가 상한이다 — 무거운 계산을 넣지 마라.

### 3.3 `observe`가 실제로 해야 하는 일

관측은 **계층**이다. 관찰자마다 다른 걸 봐야 한다:

- **월드 공통** — 시간/날씨/공개 사건. 모두 동일
- **역할 스코프** — 역할의 `scope` 값에 따라. 관리자는 전역 집계, 행위자는 주변만
- **관찰자 자신** — 소지품·목표·관계, 그리고 **그 관찰자의 `memory`**
- **직전 틱 피드백** — 기각된 의도와 **사유** (이게 없으면 스레드가 같은 실수를 반복한다)

> ⚠️ **기억 전달은 엔진 책임이다.** 스레드의 대화 기록은 주기적으로 버려지고, 그때 스레드를 되살리는 것은
> 역할 지침 + 정체성 파라미터 + **네가 `observe`에 담아 보낸 것**뿐이다. `observe`에 `memory`를 넣지 않으면
> 리셋된 스레드는 자기 과거를 완전히 잃는다. 플랫폼은 기억을 저장하지도 주입하지도 않는다.

`args.since`가 `null`이면 **전체 스냅샷**, 값이 있으면 그 이후 **변화분**만 주면 된다. 관측은 매 틱마다 모든
스레드에 가므로 토큰 비용을 여기가 지배한다. 델타를 지원하면 비용이 크게 준다 (안 해도 동작은 한다).

`main`이라는 `observerId`로도 불린다 — 유저가 채팅으로 말을 걸 때다. 이때는 전지적 요약을 주라.

### 3.4 `step()`이 해야 하는 일

0. **의도와 무관한 세계 진행을 먼저 처리한다** — 시간, 자원, 이동, 상태 변화. 큐가 비어 있어도 이건 돈다
1. 큐의 의도를 `seq` 순으로 정렬해 꺼낸다 (0건일 수 있다)
2. 월드 규칙으로 검증한다. **같은 배치의 경합을 판정할 수 있다** — 두 스레드가 같은 자원을 노리면
   먼저 온 쪽을 이기게 하든, 둘 다 기각하든, 주사위를 굴리든 네가 정한다
3. 적용 결과를 상태에 쓰고, **기각은 사유를 `feedback`에 남긴다** (다음 `observe`가 실어 보낸다)
4. 소비한 의도 키를 `$unset`으로 지운다
5. 스레드를 늘리거나 줄여야 하면 `result.threads`를 반환한다 (§5)

## 4. 역할과 스레드 (`subagents.json`)

**역할 = 템플릿, 스레드 = 인스턴스.** 같은 역할에서 스레드 여러 개가 뜨고 지침은 한 벌이다.
정체성은 스폰 시 주입되는 `params`가 갖는다.

```jsonc
{
  "version": 2,
  "roles": [
    {
      "name": "villager",
      "role": "마을 주민",
      "instructions": "roles/villager.md",   // 세션 루트 기준
      "scope": "local",                       // 엔진이 해석하는 가시 범위 태그
      "loop": {
        "mode": "loop",          // "loop"(주기적) | "onAssistantTurn" | "none"
        "intervalMs": 10000,     // 하한 5000. 짧게 잡을수록 토큰을 태운다
        "resetEveryTurns": 40    // 이 턴수마다 컨텍스트를 버리고 재prime
      },
      "emitSummary": false,      // 앱 모드에선 보통 false (메인을 깨우지 않는다)
      "delegable": false
      // "model": "sonnet"       // 생략하면 세션 모델 상속. 빈번한 루프엔 가벼운 모델이 유리
    }
  ],
  "threads": [
    { "threadId": "villager_01", "role": "villager", "params": { "entityId": "villager_01" } },
    { "threadId": "villager_02", "role": "villager", "params": { "entityId": "villager_02" } }
  ]
}
```

- `threadId`: 소문자/숫자/`_`/`-`만. **`.` 금지.** 이게 `observerId`로 쓰인다
- `params`: 이 스레드가 월드의 **누구/무엇인지**. 역할 지침에서 "네 `entityId`가 너다"라고 알려주라
- 상한은 `threads[]` + (구형) `subagents[]`의 **합계 12개**. 넘기면 매니페스트 전체가 로드에 실패해
  **서브·스레드가 하나도 안 뜬다**
- 기존 v1 `subagents[]`와 공존할 수 있다 (일반 서브에이전트 + 앱 스레드 혼용 가능)

### 역할 지침(`roles/*.md`)에 반드시 넣을 것

역할 지침은 같은 역할의 **모든 스레드가 공유**한다. "너는 철수다"라고 쓰면 안 된다 — `params`가 그 역할을 한다.

```markdown
너는 마을 주민이다.

- `observerId`는 `[THREAD]` 블록의 `threadId`다. 다른 스레드를 사칭하지 마라.
- 행동하려면 run_tool("world", { action: "submit", observerId: "<네 id>", intent: {...} }) 를 한 번만 호출한다.
- 의도에 `memory`로 한 줄 기억을 실어라. 네 대화 기록은 주기적으로 버려지고,
  그때 너를 되살리는 건 이 지침 + params + 관측뿐이다. 적지 않은 것은 사라진다.
- 제출 후엔 한 줄만 답하고 턴을 끝내라. 서사를 쓰지 마라 — 사용자에게 보이지 않는다.
- 기각당하면 다음 관측에 사유가 온다. 그걸 보고 다시 판단하라.
```

## 5. 스레드를 런타임에 늘리고 줄이기

월드에서 개체가 태어나거나 죽으면 스레드도 그래야 한다. `step()`이 반환한다:

```js
return {
  data: { world: { /* 상태 패치 */ } },
  result: {
    threads: {
      spawn: [{ threadId: "villager_07", role: "villager", params: { entityId: "villager_07" } }],
      despawn: ["villager_03"],
    },
  },
};
```

코어가 `threads.json`에 반영하고 프로세스를 띄우거나 죽인다. 세션을 닫았다 열어도 복원된다
(매니페스트가 아니라 `threads.json`이 살아있는 목록의 진실이다).

## 6. 앱 화면 (`app/index.html`)

패널과 같은 shadow DOM이지만 **정책이 반대**다: **한 번만 마운트되고 다시 렌더되지 않는다.**
그래서 캔버스·`requestAnimationFrame` 루프·이벤트 리스너가 살아남는다.

```html
<style>
  :host { display: block; height: 100%; }
  /* layout.json의 theme 토큰을 쓸 수 있다: var(--text), var(--bg), var(--accent), var(--border) */
</style>
<div id="root">…</div>
<script>
  // `shadow`와 `sessionId`가 주어진다. 이 스크립트는 앱 수명 동안 딱 한 번 실행된다.

  // 상태는 재렌더가 아니라 이벤트로 온다. detail은 패널 컨텍스트와 같은 모양이고,
  // world.json의 내용은 detail.world 에 있다.
  window.addEventListener("__bridge_evt:stateChanged", (e) => {
    const world = (e.detail || {}).world || {};
    draw(world);          // 직접 DOM을 갱신하라. innerHTML을 통째로 갈아끼워도 되지만
                          // 그러면 네 리스너도 날아가니 주의.
  });

  // 유저 조작 → 반드시 submit을 탄다
  async function act(intent) {
    return window.__panelBridge.runTool("world", {
      action: "submit", observerId: "user", intent,
    });
  }
</script>
```

**쓸 수 있는 것**: `window.__panelBridge`의 `runTool`·`updateVariables`·`updateData`·`updateLayout`·
`sendMessage`·`openModal`/`closeModal`·`showPopup` (패널과 동일).

**하지 말아야 하는 것**:
- `__panelBridge.updateData("world", …)`로 월드를 직접 고치기 → **403으로 막힌다.** `submit`을 타라
- 외부 CDN 로드 (오프라인·CSP 문제) — 필요한 코드는 `app/`에 두고 상대 경로로 참조하라
- 무거운 초기 렌더. 앱 파일은 세션 파일 라우트로 서빙되므로 이미지·JS는 `app/` 아래 상대 경로로 둔다

앱 스크립트 오류는 격리되어 셸을 죽이지 않고 화면 상단에 빨간 띠로 표시된다.

## 7. 메인 서술자는 어떻게 되나

살아있지만 **자동으로 말하지 않는다**. 깨어나는 건 유저가 채팅으로 말을 걸 때뿐이다.
그때 `observe("main")`의 현재 월드 요약이 `[WORLD]` 헤더로 붙는다.

따라서 `session-instructions.md`에는 "너는 앱 화면 옆의 해설자이고, 유저가 물을 때만 답하며,
월드 상태는 `[WORLD]` 헤더로 온다"는 취지를 적으라. 메인이 월드를 직접 고치려 들면 안 된다 —
필요하면 메인도 `run_tool("world", { action: "submit", observerId: "main", … })`을 타야 한다.

## 8. 만들기 순서 (권장)

1. **월드의 규칙을 사용자와 합의한다.** 어떤 개체가 있고, 무엇을 할 수 있고, 무엇이 금지되는가.
   이게 `step()`이 된다. 여기가 흐릿하면 나머지가 전부 흔들린다
2. `world.json` 스키마를 정하고 시드를 쓴다
3. `tools/world.js`를 쓴다 — `observe`/`submit`/`step`/`snapshot`. **§3.2의 세 가지를 지켜라**
4. `bridge_define_role`로 역할과 스레드를 정의한다 (JSON을 손으로 쓰지 마라)
5. `roles/*.md`를 쓴다
6. `app/index.html`을 쓴다 — 처음엔 텍스트 HUD로 충분하다. 그림은 나중에
7. `layout.json`에 `app` 블록을 넣고 `chat.mode: "dock"`으로 시작한다
8. 사용자에게 세션을 열어보게 하고, **틱이 도는지·의도가 적용되는지·기각 사유가 돌아오는지** 확인한다

## 9. 체크리스트

- [ ] `layout.json`에 `app.entry`가 있고 `engine`·`worldFile`에 경로 구분자가 없는가?
- [ ] 의도 큐가 **배열이 아니라 키 있는 객체**인가? 키에 `.`이 없는가?
- [ ] `submit`이 검증을 하지 않고, 모든 규칙이 `step()`에 있는가?
- [ ] 유저 조작도 `submit`을 타는가? (앱이 `updateData`로 월드를 고치려 하지 않는가)
- [ ] `observe`가 그 관찰자의 `memory`와 **직전 기각 사유**를 실어 보내는가?
- [ ] `step()`이 소비한 의도를 `$unset`으로 지우는가?
- [ ] **큐가 비어 있어도** `step()`이 세계를 진행시키는가? (시간·자원·이동) — AI가 조용할 때 얼어붙지 않는가?
- [ ] 엔진이 모듈 스코프에 상태를 두지 않는가? 10초 안에 끝나는가?
- [ ] 역할 지침이 "너는 특정 개인"이 아니라 **역할**을 설명하고, 정체성은 `params`에서 오는가?
- [ ] `threads[]` + `subagents[]` 합계가 12개 이하인가?
- [ ] `intervalMs`가 5000 이상이고, 스레드 수 × 빈도가 감당할 만한가?
- [ ] 앱 스크립트가 `stateChanged`로 갱신하고, 스스로 재마운트하지 않는가?
- [ ] `session-instructions.md`가 메인의 새 역할(조용한 해설자)을 반영하는가?
