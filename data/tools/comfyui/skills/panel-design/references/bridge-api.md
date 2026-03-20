# Bridge API 레퍼런스

패널 HTML의 `<script>` 태그 안에서 `window.__panelBridge`로 접근한다.

---

## 메서드

### `sendMessage(text: string, opts?: { silent?: boolean }): void`
채팅에 사용자 메시지를 즉시 전송. AI가 이 메시지에 응답한다.
모달 패널에서 호출 시 해당 모달이 자동 닫힌다.

**`{ silent: true }` 옵션**: AI에게 메시지를 보내되 채팅 UI에 표시하지 않는다. 히스토리에도 저장되지 않고, 팝업도 클리어하지 않는다. AI 응답은 정상적으로 표시되어 유저에게는 AI가 자연스럽게 이어서 쓴 것처럼 보인다.

```javascript
__panelBridge.sendMessage('동의한다');
__panelBridge.sendMessage(`${destination}(으)로 이동합니다`);

// Silent: 유저에게 안 보이는 시스템 트리거
__panelBridge.sendMessage('[MONTH_END]\n...월 전환 정보...', { silent: true });
```

**Silent Message 용도:**
- 2-Phase 턴의 Phase 2 트리거 (시간 진행 서사 요청)
- 시스템 이벤트에 대한 AI 반응 요청
- 유저 액션 없이 AI 턴을 자동 시작해야 할 때

### `fillInput(text: string): void`
입력창 커서 위치에 텍스트 삽입. 전송하지 않으므로 사용자가 편집 후 직접 전송.

```javascript
__panelBridge.fillInput('OOC: 다음 턴에 ');
```

### `updateVariables(patch: object): void`
`variables.json`을 shallow merge로 부분 업데이트. 패널 자동 재렌더링.

```javascript
__panelBridge.updateVariables({ mood: '행복', stress: 10 });
```

### `updateData(fileName: string, patch: object): void`
커스텀 데이터 파일을 shallow merge로 부분 업데이트. `fileName`은 확장자 포함.

```javascript
__panelBridge.updateData('inventory.json', { items: { '회복포션': 3 } });
__panelBridge.updateData('game-state.json', { dark_path: true });
```

### `updateLayout(patch: object): void`
`layout.json`을 deep merge로 부분 업데이트. 실시간 반영.

```javascript
__panelBridge.updateLayout({ panels: { dockWidth: 500 } });
__panelBridge.updateLayout({ theme: { accent: '#6c63ff' } });
__panelBridge.updateLayout({ panels: { placement: { newPanel: 'right' } } });
```

### `openModal(name: string, mode?: string): void`
모달/독 패널을 연다. 모달 그룹 로직이 자동 적용되어 같은 그룹의 다른 모달이 닫힌다.

- `mode` 생략 또는 `undefined` → `true` (필수 모달, 닫기 불가)
- `mode = "dismissible"` → 자유롭게 닫기 가능

```javascript
__panelBridge.openModal('inventory', 'dismissible');
__panelBridge.openModal('setup'); // 필수 모달
```

### `closeModal(name: string): void`
모달/독 패널을 닫는다.

```javascript
__panelBridge.closeModal('inventory');
```

### `closeAllModals(except?: string[]): void`
모든 모달을 닫는다. `except` 배열에 포함된 모달은 유지.

```javascript
__panelBridge.closeAllModals();
__panelBridge.closeAllModals(['portrait']); // portrait만 유지
```

### `queueEvent(header: string): void`
다음 사용자 메시지에 이벤트 헤더를 첨부. 누적 가능. OOC 메시지에는 첨부 안 됨.

```javascript
await __panelBridge.queueEvent('[아이템사용: 회복포션 → HP +50]');
await __panelBridge.queueEvent('[위치이동: 마을 → 숲 (2시간 경과)]');
```

AI가 받게 되는 메시지:
```
[아이템사용: 회복포션 → HP +50]
[위치이동: 마을 → 숲 (2시간 경과)]
다음 방으로 이동하자
```

**사용 판단 기준:**
- `sendMessage`로 직접 AI에 전송 → `queueEvent` 불필요 (이미 인지)
- AI가 직접 엔진 호출 → 불필요 (자기가 요청한 일)
- 순수 UI 조작 (탭 전환 등) → 불필요
- **패널에서 데이터만 변경하고 AI에게 알려야 할 때** → 사용

### `runTool(name: string, args: object): Promise<{ ok, result }>`
서버사이드 커스텀 툴 실행. `name`은 `tools/` 내 `.js` 파일명 (확장자 제외).

```javascript
const res = await __panelBridge.runTool('engine', {
  action: 'buy_item', item: '회복포션'
});
// res = { ok: true, result: { success: true, item: '회복포션', newGold: 450 } }

if (!res.ok) { /* 서버 에러 */ }
if (!res.result?.success) { /* 로직 실패 (골드 부족 등) */ }
```

### `showPopup(template: string, opts?: object): void`
팝업 이펙트를 큐에 추가. `template`은 `popups/` 내 `.html` 파일명 (확장자 제외).

```javascript
await __panelBridge.showPopup('level-up', {
  duration: 5000,       // 표시 시간 ms (기본 4000)
  vars: { level: 10 }   // 해당 팝업에만 적용할 추가 변수
});
```

### `on(event: string, handler: function): function`
브릿지 이벤트 구독. 반환값은 구독 해제 함수.

```javascript
const off = __panelBridge.on('turnEnd', () => {
  const d = __panelBridge.data;
  shadow.querySelector('.hp').textContent = d.hp;
});

// 구독 해제
off();
```

---

## 이벤트

| 이벤트 | detail | 설명 |
|--------|--------|------|
| `turnStart` | 없음 | AI가 응답 시작 (스트리밍 시작) |
| `turnEnd` | 없음 | AI 응답 완료, 사용자 턴 |
| `imageUpdated` | `{ filename: string }` | 세션 이미지 파일 생성/덮어쓰기 |

```javascript
// AI 응답 완료 시 최신 데이터로 DOM 갱신
__panelBridge.on('turnEnd', () => {
  const d = __panelBridge.data;
  shadow.querySelector('.gold').textContent = `${d.gold}G`;
});

// 이미지 갱신 감지
__panelBridge.on('imageUpdated', (detail) => {
  const img = shadow.querySelector(`img[data-name="${detail.filename}"]`);
  if (img) img.src = img.src.replace(/[?&]_t=\d+/, '') + '?_t=' + Date.now();
});
```

**이벤트 중복 등록 주의:**
`autoRefresh: true` 패널에서는 재렌더링마다 스크립트가 다시 실행되어 리스너가 누적된다.
- `autoRefresh: false`인 패널에서만 `on()`을 사용하거나
- 구독 해제 로직을 추가하라

---

## 읽기 전용 속성

### `__panelBridge.data`
전체 템플릿 컨텍스트 객체. `variables.json` 값은 루트 레벨, 커스텀 데이터는 파일명 키.

```javascript
const d = __panelBridge.data;

// variables.json 값 (루트)
d.hp              // 40
d.gold            // 805
d.location        // "집"
d.__modals        // { inventory: false, schedule: false, ... }
d.__imageBase     // "/api/sessions/{id}/files?path=images/"

// 커스텀 데이터 (파일명 키)
d.world           // world.json 전체 객체
d.inventory       // inventory.json 전체 객체
d['event-log']    // event-log.json (하이픈 포함 키)
d['game-state']   // game-state.json
```

### `__panelBridge.sessionId`
현재 세션 ID (string).

### `__panelBridge.isStreaming`
AI가 현재 응답 중인지 (boolean). 스트리밍 중 버튼 비활성화 등에 활용.

---

## 이미지 리소스

세션 `images/` 디렉토리의 이미지를 패널에서 사용하는 방법.

### Handlebars (권장 — 정적 이미지)
```html
<img src="{{__imageBase}}tavern-bg.png" />
<div style="background-image: url({{__imageBase}}panel-bg.png)"></div>
```

`{{__imageBase}}`는 자동 치환:
- 세션: `/api/sessions/{id}/files?path=images/`
- 빌더: `/api/personas/{name}/images?file=`

파일명만 붙이면 된다 (`images/` 프리픽스 불필요).

### JavaScript (동적 이미지 교체)
```javascript
const base = __panelBridge.data.__imageBase;
const img = shadow.querySelector('.scene-img');
img.src = base + 'scene.png';

// 캐시 바스팅 (이미지 갱신 감지 시)
img.src = base + 'scene.png?_t=' + Date.now();
```

### 이미지 갱신 감지
```javascript
__panelBridge.on('imageUpdated', (detail) => {
  if (detail.filename === 'standing_portrait.png') {
    const img = shadow.querySelector('#portrait');
    img.src = __panelBridge.data.__imageBase + 'standing_portrait.png?_t=' + Date.now();
    img.style.display = 'block';
    shadow.querySelector('.placeholder').style.display = 'none';
  }
});
```

### 이미지 존재 확인 패턴
```javascript
const testImg = new Image();
testImg.onload = () => {
  shadow.querySelector('#portrait').src = base + 'portrait.png';
  shadow.querySelector('#portrait').style.display = 'block';
  shadow.querySelector('.placeholder').style.display = 'none';
};
testImg.onerror = () => { /* 이미지 없음 — placeholder 유지 */ };
testImg.src = base + 'portrait.png?' + Date.now();
```

---

## 종합 예제: 엔진 호출 → 결과 표시 → AI 알림

```html
<button class="use-btn" data-item="회복포션">사용</button>
<div class="feedback" id="feedback"></div>

<script>
(function() {
  // shadow는 자동 주입됨
  shadow.querySelectorAll('.use-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const feedback = shadow.querySelector('#feedback');

      const res = await __panelBridge.runTool('engine', {
        action: 'use_item', item: btn.dataset.item
      });

      if (res.result?.success) {
        // 즉시 UI 피드백
        const fx = Object.entries(res.result.effects || {})
          .map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${v}`)
          .join(', ');
        feedback.textContent = `✅ ${res.result.item} 사용 → ${fx}`;
        feedback.style.color = '#4dcc7a';

        // AI에게 알림 (다음 메시지에 첨부)
        await __panelBridge.queueEvent(
          `[아이템사용: ${res.result.item}×${res.result.quantity} → ${fx}]`
        );
        // 패널이 자동 재렌더링되어 수량 갱신됨
      } else {
        feedback.textContent = `❌ ${res.result?.message || '실패'}`;
        feedback.style.color = '#f07070';
        btn.disabled = false;
      }
    });
  });
})();
</script>
```
