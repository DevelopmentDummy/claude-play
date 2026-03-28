# 턴 기반 연출 오케스트레이션

패널 시스템의 가장 미묘한 부분은 **대화 턴 사이클에 맞춰 UI를 시간차로 제어하는 기법**이다. 단순한 API 호출이 아니라 "언제 보여주고 언제 숨기는가"의 안무(choreography)다.

---

## 핵심 아키텍처: 2-Phase 턴 분리

하나의 게임 턴에 "행동 결과"와 "시간 진행"이라는 두 가지 의미 단위가 있을 때, 이를 별도 AI 턴으로 분리한다:

```
Phase 1: [엔진: 행동 처리] → [애니메이션] → [queueEvent + sendMessage] → [AI: 행동 서사]
                                                                              ↓ turnEnd
Phase 2: [엔진: 시간 진행] → [팝업: 생일/계절/해금] → [sendMessage(silent)] → [AI: 전환 서사]
```

**왜 분리하는가:**
- "검술 연습을 마쳤다"와 "겨울이 찾아왔다"는 다른 서사 단위 — 한 응답에 섞으면 산만해짐
- 팝업(생일 🎂, 해금 🔓)이 **두 서사 사이에** 등장하여 자연스러운 극적 전환점이 됨
- 시간 진행에 중요 이벤트가 없으면 Phase 2를 건너뛰어 AI 토큰/시간 절약
- 각 AI 응답이 짧고 집중적 — 프롬프트도 단순해지고 서사 품질도 올라감

**조건부 2턴:**
- Phase 2 엔진(`turn_transition`)이 `needs_narration: true`를 반환할 때만 AI 서사 요청
- 단순 해금만 있으면 팝업만 보여주고 AI 턴 추가 안 함
- 기준: 생일, 스트레스 폭발, 계절 이벤트, 대회 참가 가능, 엔딩 알림, 나이 변경

**Silent Message:**
Phase 2의 AI 서사 요청은 `sendMessage(text, { silent: true })`로 보낸다. 유저 채팅에 보이지 않으므로 AI가 자연스럽게 이어서 쓴 것처럼 보인다.

---

## 턴 사이클 이해

```
[유저 입력] → [엔진 실행 (즉시)] → [AI 응답 스트리밍] → [turnEnd] → [다음 유저 입력]
```

| 시점 | 특성 | 활용 |
|------|------|------|
| 패널 버튼 클릭 | 유저 액션, 즉시 실행 | 엔진 호출, 데이터 변경 |
| 엔진 결과 반환 | 데이터는 이미 갱신됨 | 애니메이션 시작, 결과 표시 |
| `sendMessage` 호출 | AI에게 메시지 전송, **모달이 자동 닫힘** | 서사 요청 |
| `sendMessage(_, { silent })` | AI에게 전달, **UI에 안 보임**, 팝업 안 클리어 | 시스템 트리거 |
| AI 스트리밍 중 | `isStreaming = true` | 버튼 비활성화 |
| `turnEnd` 이벤트 | AI 응답 완료, 유저 턴 | 지연 UI, Phase 2 트리거 |

**핵심 통찰:** 엔진은 AI보다 먼저 실행되지만, 연출 효과(팝업, 모달 전환)는 AI 응답이 끝난 뒤에 보여줘야 한다. 이 "시간차"가 몰입감의 핵심이다.

---

## 패턴 1: 지연 팝업 (Deferred Popup)

엔진이 팝업을 결정하지만, AI의 서사가 끝난 뒤에 보여준다.

```javascript
async function finalize(result) {
  // 1. 엔진 결과를 이벤트 헤더로 적재
  await __panelBridge.queueEvent(buildSummary(result));

  // 2. AI에게 서사 요청 (이 시점에서 모달이 자동 닫힘)
  __panelBridge.sendMessage('[스케줄 진행]');

  // 3. 팝업은 AI 응답 완료 후에 표시
  if (result.popups && result.popups.length > 0) {
    const pendingPopups = [...result.popups]; // 클로저로 캡처

    // 이전 리스너 정리 (중복 방지)
    if (window.__popupTurnEndUnsub) {
      window.__popupTurnEndUnsub();
      window.__popupTurnEndUnsub = null;
    }

    // turnEnd 원샷 훅
    window.__popupTurnEndUnsub = __panelBridge.on('turnEnd', async () => {
      // 즉시 자기 자신을 해제 (원샷)
      if (window.__popupTurnEndUnsub) {
        window.__popupTurnEndUnsub();
        window.__popupTurnEndUnsub = null;
      }
      // AI 서사가 끝난 뒤에야 팝업 표시
      await __panelBridge.updateVariables({ __popups: pendingPopups });
    });
  }
}
```

**왜 이렇게 하는가:**
- 엔진이 "레벨 업!" 팝업을 결정 → AI가 "올리브가 성장을 느꼈다..." 서사 → 서사가 끝나면 화면 중앙에 팝업 등장
- 팝업이 AI 응답 도중에 뜨면 서사를 읽는 흐름이 끊긴다
- `turnEnd` 원샷 훅으로 정확히 AI 완료 시점에 트리거

---

## 패턴 2: 지연 모달 열기 (Deferred Modal Open)

모험 패널처럼 "AI가 서사를 끝낸 뒤 모달을 열어야 하는" 경우.

```javascript
// 엔진이 모험 시작을 결정했지만, 모달은 AI 응답 후에
if (result.adventure_started) {
  // 이전 리스너 정리
  if (window.__advTurnEndUnsub) {
    window.__advTurnEndUnsub();
    window.__advTurnEndUnsub = null;
  }

  window.__advTurnEndUnsub = __panelBridge.on('turnEnd', () => {
    if (window.__advTurnEndUnsub) {
      window.__advTurnEndUnsub();
      window.__advTurnEndUnsub = null;
    }
    // 데이터가 실제로 존재하는지 확인 후 열기
    const adv = __panelBridge.data?.__adventure;
    if (adv && adv.active && adv.status === 'encounter') {
      __panelBridge.openModal('adventure', true);
    }
  });
}
```

**핵심:** `turnEnd` 훅 안에서 데이터를 다시 확인한다. 엔진 실행 시점과 훅 실행 시점 사이에 데이터가 바뀔 수 있기 때문.

---

## 패턴 3: sendMessage 후 패널 복원

`sendMessage`는 모든 모달/독 패널을 자동으로 닫는다. 하지만 독 패널처럼 계속 보여야 하는 것은 다시 열어야 한다.

```javascript
// AI에게 메시지 전송 (이때 advance 독 패널이 닫힘)
__panelBridge.sendMessage('[스케줄 진행]');

// 다음 슬롯이 남아있으면 독 패널 다시 열기
if (!result.month_advanced && !result.adventure_started) {
  setTimeout(() => {
    __panelBridge.openModal('advance', true); // true = 필수 (닫기 불가)
  }, 500); // 약간의 딜레이로 sendMessage의 닫기 동작 이후에 실행
}
```

**조건부 복원:** 모험이 시작되면 advance가 아니라 adventure 모달이 열려야 하므로, advance를 다시 열지 않는다.

---

## 패턴 4: 스트리밍 가드 (Streaming Guard)

AI가 응답 중일 때 유저의 조작을 막는다.

```javascript
const advBtn = shadow.querySelector('#advBtn');
let _running = false;

function syncStreaming(streaming) {
  if (_running) return; // 자체 애니메이션 중이면 무시
  if (advBtn) {
    advBtn.disabled = !!streaming;
    advBtn.textContent = streaming ? '⏳ 응답 대기 중...' : '▶ 스케줄 진행';
  }
}

// 초기 상태 체크
if (window.__bridgeIsStreaming) syncStreaming(true);

// 상태 변경 감지
window.addEventListener('__bridge_streaming_change', (e) => syncStreaming(e.detail));
```

**이중 가드:** `_running`(자체 애니메이션)과 `isStreaming`(AI 응답) 두 가지를 모두 체크.

---

## 패턴 5: 애니메이션 잠금 (Animation Lock)

`autoRefresh: false` 패널에서 애니메이션이 진행 중일 때 `turnEnd` 재빌드를 방지한다.

```javascript
let _animating = false;

// 애니메이션 시작
advBtn.addEventListener('click', async () => {
  _animating = true;
  // ... 일일 시뮬레이션 애니메이션 (수 초간 진행) ...
  await finalize(result); // finalize에서 _animating = false
});

// turnEnd 재빌드 — 애니메이션 중이면 무시
__panelBridge.on('turnEnd', () => {
  if (_animating) return;
  setTimeout(() => buildPanel(), 300); // 데이터 안정화 대기
});
```

**300ms 딜레이:** `turnEnd` 직후 데이터 파일 쓰기가 비동기로 완료되는 것을 기다리는 안전장치.

---

## 패턴 6: AI 설정 → 인라인 트리거 → 모달 (3단 연출)

AI가 데이터를 설정하고, 인라인 패널이 버튼을 보여주고, 유저가 클릭하면 모달이 열리는 3단 흐름.

**가치관 시스템 예시:**

1. **AI 턴**: AI가 서사를 쓰고 `__values_prompt`를 설정, 응답에 `$PANEL:values-trigger$` 토큰 삽입
2. **인라인 패널**: values-trigger 패널이 렌더링되어 "💭 가치관 선택" 버튼 표시
3. **유저 클릭**: 버튼 클릭 → `openModal('values', 'dismissible')` → 선택 모달 열림
4. **선택 완료**: 선택지 클릭 → 효과 적용 → 모달 닫기 → `queueEvent`로 AI에게 결과 전달

```javascript
// values-trigger.html (인라인 패널)
const vp = __panelBridge.data.__values_prompt;
if (!vp || !vp.choices?.length) return; // 데이터 없으면 렌더링 안 함

shadow.querySelector('#vtRoot').classList.add('show');
shadow.querySelector('#vtBtn')?.addEventListener('click', () => {
  __panelBridge.openModal('values', 'dismissible');
});
```

```javascript
// values.html (모달 패널) — 선택 완료 시
setTimeout(async () => {
  // 효과 적용 + 모달 닫기
  await __panelBridge.updateVariables({ __values_prompt: null, ...effects });
  await __panelBridge.closeModal('values');

  // 플래그 저장
  await __panelBridge.updateData('game-state.json', { flags: merged });

  // AI에게 선택 결과를 다음 메시지에 첨부
  await __panelBridge.queueEvent(`[VALUES_CHOICE]\nchosen: ${chosen.label}\neffects: ...`);

  // 크로스 패널 신호 (인라인 버튼 비활성화용)
  window.dispatchEvent(new CustomEvent('values-chosen'));
}, 500); // 선택 애니메이션 여유
```

**왜 AI가 모달을 직접 열지 않는가:**
- AI가 `__modals.values = true`를 설정하면 서사 도중에 모달이 뜬다
- 대신 AI가 인라인 트리거 버튼을 삽입하면, 유저가 서사를 다 읽은 뒤 자기 타이밍에 버튼을 누른다
- 유저에게 **주도권**을 준다

---

## 패턴 7: 위상 기반 패널 가시성 (Phase-based Visibility)

게임 상태(phase)에 따라 패널을 자동으로 보이고 숨긴다.

```javascript
function buildPanel() {
  const d = __panelBridge.data;
  const phase = d.turn_phase || 'setup';
  const cur = d.current_slot || 0;

  // executing 위상이 아니거나 모든 슬롯 완료 → 독 패널 숨김
  if (phase !== 'executing' || cur >= 3) {
    __panelBridge.closeModal('advance');
    el.style.display = 'none';
    return;
  }
  // ... 패널 렌더링 ...
}
```

패널이 스스로 "지금 보여야 하는 상황인가?"를 판단한다. `autoRefresh: false`이므로 `turnEnd`마다 이 판단을 다시 수행.

---

## 패턴 8: 원샷 훅과 리스너 정리

`turnEnd` 훅을 한 번만 실행하고 즉시 해제하는 패턴. 리스너 누적을 방지한다.

```javascript
// 저장: window 전역에 unsubscribe 함수 보관
if (window.__myHookUnsub) {
  window.__myHookUnsub();       // 기존 리스너 해제
  window.__myHookUnsub = null;
}

window.__myHookUnsub = __panelBridge.on('turnEnd', () => {
  // 즉시 자기 해제 (원샷)
  if (window.__myHookUnsub) {
    window.__myHookUnsub();
    window.__myHookUnsub = null;
  }
  // 실제 로직
  doSomething();
});
```

**window 전역을 쓰는 이유:**
- `autoRefresh: false` 패널은 재렌더링 시 스크립트가 다시 실행됨
- 이전 렌더의 리스너가 남아있을 수 있음
- `window.__myHookUnsub`에 저장해두면 다음 렌더에서 정리 가능

---

## 패턴 9: 크로스 패널 통신

서로 다른 패널 간에 신호를 보내는 패턴. Shadow DOM으로 격리되어 있으므로 `window` 이벤트를 사용.

```javascript
// 패널 A: 신호 발송
window.dispatchEvent(new CustomEvent('values-chosen'));

// 패널 B: 신호 수신
window.addEventListener('values-chosen', () => {
  btn.disabled = true;
  btn.style.opacity = '0.4';
});
```

**사용 예시:**
- values 모달에서 선택 완료 → values-trigger 인라인 버튼 비활성화
- competition 모달 완료 → advance 패널 상태 갱신

---

## 종합: 슬롯 진행 전체 오케스트레이션 (2-Phase)

### Slot 1, 2 (단일 Phase)
```
유저: [▶ 스케줄 진행] 클릭
  ↓
패널: engine.advance_slot (활동만)
  ↓
패널: 일일 시뮬레이션 애니메이션
  ↓
패널: finalize()
  ├─ queueEvent([SLOT_RESULT] 활동 정보만)
  ├─ sendMessage('[스케줄 진행]')
  ├─ setTimeout → openModal('advance') — 독 패널 복원
  └─ on('turnEnd') → 활동 팝업 (대성공 등)
  ↓
AI: 활동 서사 + 이미지 생성
  ↓
turnEnd → 팝업 → advance 패널 rebuild (다음 슬롯 준비)
```

### Slot 3 + 중요 이벤트 (2-Phase)
```
유저: [▶ 스케줄 진행] 클릭
  ↓
Phase 1:
  패널: engine.advance_slot (활동만, pending_transition: true)
  패널: 애니메이션
  패널: finalize()
    ├─ queueEvent([SLOT_RESULT])
    ├─ sendMessage('[스케줄 진행]')
    └─ on('turnEnd') → setupTransitionHook
  ↓
  AI: 활동 서사 ("올리브는 마지막 검술 수련을 마쳤다...")
  ↓
Phase 2 (turnEnd 트리거):
  패널: engine.turn_transition (월 진행, 해금, 생일, 계절 등)
  패널: 🎂 팝업 표시 (생일, 계절, 해금)
  패널: sendMessage([MONTH_END], { silent: true })
  ↓
  AI: 월말 서사 ("그리고 올리브의 13번째 생일이 찾아왔다...")
       (유저에겐 AI가 자연스럽게 이어서 쓴 것처럼 보임)
  ↓
turnEnd → advance 패널 rebuild → setup 위상 → 다음 달 스케줄
```

### Slot 3 + 별일 없음 (Phase 2 생략)
```
Phase 1: (위와 동일)
  AI: 활동 서사
  ↓
Phase 2 (turnEnd):
  패널: engine.turn_transition (해금만 발생, needs_narration: false)
  패널: 🔓 팝업 표시 (해금)
  (AI 추가 턴 없음 — 바로 setup 위상으로 복귀)
```

---

## 설계 원칙 요약

1. **행동 결과와 시간 진행을 분리** — 한 턴에 두 개의 서사 단위가 있으면 2-Phase로 나눠 각각 집중된 AI 응답을 받는다
2. **엔진은 즉시, 연출은 지연** — 데이터는 빠르게 갱신하되, 시각 효과는 서사 후에
3. **조건부 2턴** — 시간 진행에 중요 이벤트가 있을 때만 Phase 2 AI 서사 요청, 없으면 생략
4. **Silent Message로 심리스 연결** — Phase 2는 유저에게 보이지 않는 메시지로 트리거하여 AI가 자연스럽게 이어쓴 것처럼 보이게
5. **팝업은 서사 사이의 극적 전환점** — Phase 1 서사와 Phase 2 서사 사이에 팝업이 등장하여 자연스러운 비트 생성
6. **유저에게 주도권** — AI가 모달을 직접 열지 않고, 인라인 트리거로 유저가 선택
7. **원샷 훅으로 정확한 타이밍** — `turnEnd` 리스너를 한 번만 실행하고 즉시 해제
8. **sendMessage의 부수 효과 인지** — 모든 모달이 닫히므로, 유지할 패널은 setTimeout으로 복원 (`silent` 메시지는 모달을 닫지 않음)
9. **이중 잠금** — 애니메이션 중 + AI 스트리밍 중 모두 유저 입력 차단
10. **위상(phase) 기반 자동 숨김** — 패널이 스스로 현재 상태를 판단하여 가시성 제어
11. **window 전역으로 크로스 패널/크로스 렌더** — Shadow DOM 격리를 넘어서는 유일한 통신 수단
