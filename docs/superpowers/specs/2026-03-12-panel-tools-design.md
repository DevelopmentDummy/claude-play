# Panel Custom Tools Design

## Overview

페르소나별 커스텀 툴(서버사이드 JavaScript)을 등록하여, 패널에서 AI 에이전트를 거치지 않고 직접 서버 로직을 실행할 수 있게 한다. 게임 메카닉(전투 계산, 아이템 조합, 맵 이동), 데이터 변환, 랜덤 이벤트 등 AI가 불필요한 결정적 로직에 활용한다.

## Requirements

- 페르소나 `tools/` 폴더에 `.js` 파일을 넣으면 자동 등록 (컨벤션 기반)
- 세션 생성 시 페르소나 `tools/` → 세션 `tools/`로 복사 (기존 skills 복사와 동일)
- 서버 프로세스 내에서 인프로세스 실행 (`import()`)
- `__panelBridge.runTool(name, args)` → API → 스크립트 실행 → 결과 반환
- 스크립트는 `context` 객체로 세션 데이터에 접근, 반환값으로 파일 업데이트 지시
- 반환값의 `variables`/`data` 패치를 서버가 자동 반영 후 패널 리프레시

## Architecture

### Tool File Convention

```
personas/{name}/tools/
├── skills/            # 기존 Claude Code 스킬 (변경 없음)
├── attack.js          # 커스텀 툴
├── craft.js
└── travel.js
```

세션 생성 시 `tools/*.js` 파일이 세션 디렉토리 `tools/`로 복사된다.

### Script Interface

각 `.js` 파일은 단일 async 함수를 `module.exports`로 내보낸다:

```javascript
// tools/attack.js
module.exports = async function(context, args) {
  // context.variables  — variables.json 내용 (읽기용 사본)
  // context.data       — 커스텀 데이터 파일들 { "inventory": {...}, "world": {...} }
  // context.sessionDir — 세션 디렉토리 절대 경로 (직접 파일 I/O 가능)

  const { target } = args;
  const player = context.variables;
  const enemies = context.data.world?.enemies || [];
  const enemy = enemies.find(e => e.name === target);

  if (!enemy) {
    return { result: { success: false, message: `${target}을(를) 찾을 수 없습니다.` } };
  }

  const damage = Math.floor(Math.random() * player.attack) + 1;
  const newEnemyHp = Math.max(0, enemy.hp - damage);

  // 월드 데이터에서 적 HP 갱신
  const updatedEnemies = enemies.map(e =>
    e.name === target ? { ...e, hp: newEnemyHp } : e
  );

  return {
    variables: {                                    // variables.json 패치 (선택)
      lastAction: `${target}에게 ${damage} 데미지`
    },
    data: {                                         // 커스텀 데이터 파일 패치 (선택)
      "world.json": { enemies: updatedEnemies }
    },
    result: {                                       // 패널에 반환할 결과 (선택)
      success: true,
      damage,
      targetHp: newEnemyHp,
      message: `${target}에게 ${damage} 데미지를 입혔다! (남은 HP: ${newEnemyHp})`
    }
  };
};
```

### Return Value

| 필드 | 타입 | 설명 |
|------|------|------|
| `variables` | `Record<string, unknown>` | `variables.json`에 shallow merge |
| `data` | `Record<string, Record<string, unknown>>` | 파일명 → 패치 객체. 각 파일에 shallow merge |
| `result` | `unknown` | 패널에 그대로 전달되는 임의 데이터 |

모든 필드는 선택적. `variables`나 `data`가 있으면 서버가 파일에 반영 후 패널 리프레시를 트리거한다.

### API Endpoint

`POST /api/sessions/[id]/tools/[name]`

- Request body: `{ args: { ... } }` (툴에 전달할 인자)
- 세션 `tools/{name}.js` 파일을 동적 `import()`로 로드하여 실행
- 반환값의 `variables`/`data`를 파일에 반영
- Response: `{ ok: true, result: ... }` 또는 `{ error: "..." }`

### Panel Bridge Method

```javascript
__panelBridge.runTool(name, args) → Promise<{ ok: boolean, result: unknown }>
```

### Security

- 툴 이름에 path traversal 방지 (`/`, `\`, `..` 차단)
- 세션 디렉토리 내 `tools/` 폴더의 `.js` 파일만 실행 허용
- `data` 반환값의 파일명도 동일한 path traversal 검증
- protected 시스템 파일 (`session.json`, `layout.json` 등) 쓰기 차단

### Module Cache

`import()`는 Node.js 모듈 캐시를 사용하므로, 동일 파일의 두 번째 호출부터는 캐시된 모듈을 사용한다. 개발 중 파일을 수정하면 캐시가 남아 있을 수 있으므로, 로드 시 `?t=timestamp` 쿼리를 붙여 캐시를 무효화한다.

### Sync (양방향 싱크)

기존 `skills/` 싱크와 동일한 패턴으로 `tools/*.js` 파일도 양방향 싱크에 포함한다. `tools/skills/`는 기존 스킬 싱크에서 처리하므로 제외하고, `tools/` 루트의 `.js` 파일만 대상.

**세션 생성 시**: 페르소나 `tools/*.js` → 세션 `tools/`로 복사 (기존 createSession 로직에 추가)

**Forward sync** (persona → session): `elements.tools === true`이면 페르소나의 `tools/*.js`를 세션으로 복사

**Reverse sync** (session → persona): `elements.tools === true`이면 세션의 `tools/*.js`를 페르소나로 복사

**Diff**: `getSyncDiff()` / `getReverseSyncDiff()`에 tools 항목 추가. `tools/` 디렉토리의 `.js` 파일만 비교 (skills/ 서브디렉토리 제외)

**SyncModal UI**: 싱크 모달에 "툴 (tools/)" 항목 표시

## File Changes

| File | Change Type | Description |
|------|-------------|-------------|
| `src/app/api/sessions/[id]/tools/[name]/route.ts` | Create | 툴 실행 API 엔드포인트 |
| `src/components/PanelSlot.tsx` | Modify | `__panelBridge.runTool()` 추가 |
| `src/components/ModalPanel.tsx` | Modify | `__panelBridge.runTool()` 추가 |
| `src/components/DockPanel.tsx` | Modify | `__panelBridge.runTool()` 추가 |
| `src/lib/session-manager.ts` | Modify | 세션 생성 시 tools/*.js 복사, 양방향 싱크/diff에 tools 항목 추가 |
| `panel-spec.md` | Modify | 커스텀 툴 섹션 및 예시 추가 |
| `CLAUDE.md` | Modify | 툴 시스템 문서화 |

## Example Use Cases

### 전투 시스템
```javascript
// tools/attack.js — 데미지 계산, 크리티컬, 회피
// tools/defend.js — 방어 자세, 피해 감소 버프
// tools/use-item.js — 아이템 사용, 인벤토리 차감
```

### 제작 시스템
```javascript
// tools/craft.js — 레시피 확인, 재료 차감, 아이템 생성
module.exports = async function(context, args) {
  const { recipe } = args;
  const inv = context.data.inventory;
  const recipes = context.data.recipes;

  const r = recipes.list.find(x => x.name === recipe);
  if (!r) return { result: { error: "알 수 없는 레시피" } };

  // 재료 확인
  for (const [item, qty] of Object.entries(r.materials)) {
    if ((inv.items[item] || 0) < qty) {
      return { result: { error: `${item}이(가) 부족합니다` } };
    }
  }

  // 재료 차감 + 결과물 추가
  const newItems = { ...inv.items };
  for (const [item, qty] of Object.entries(r.materials)) {
    newItems[item] -= qty;
  }
  newItems[r.result] = (newItems[r.result] || 0) + 1;

  return {
    data: { "inventory.json": { items: newItems } },
    result: { success: true, created: r.result }
  };
};
```

### 이동 시스템
```javascript
// tools/travel.js — 거리 계산, 시간 경과, 랜덤 이벤트
module.exports = async function(context, args) {
  const { destination } = args;
  const world = context.data.world;
  const current = context.variables.location;

  const route = world.routes.find(r =>
    (r.from === current && r.to === destination) ||
    (r.from === destination && r.to === current)
  );

  if (!route) return { result: { error: "갈 수 없는 경로" } };

  // 랜덤 이벤트
  const events = ["평온한 여행", "도적 조우", "상인 발견", "폭풍우"];
  const event = events[Math.floor(Math.random() * events.length)];

  return {
    variables: {
      location: destination,
      day: context.variables.day + route.days,
    },
    result: { arrived: destination, days: route.days, event }
  };
};
```

### 패널에서 호출 예시

```html
<style>
  .action-btn {
    background: #2a3a5e; border: 1px solid #3a4a6e; border-radius: 8px;
    padding: 8px 14px; color: #e0e0e0; cursor: pointer; font-size: 12px;
  }
  .action-btn:hover { background: #3a4a6e; border-color: #6c63ff; }
  .action-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .result-msg { margin-top: 8px; font-size: 12px; color: #a0a0b0; }
</style>

<div>
  {{#each world.enemies}}
    {{#if (gt this.hp 0)}}
    <div style="display:flex; justify-content:space-between; align-items:center; padding:4px 0;">
      <span>{{this.name}} (HP: {{this.hp}})</span>
      <button class="action-btn attack-btn" data-target="{{this.name}}">공격</button>
    </div>
    {{/if}}
  {{/each}}
</div>
<div class="result-msg" id="result"></div>

<script>
  const root = document.currentScript.getRootNode();
  root.querySelectorAll('.attack-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '...';
      const res = await __panelBridge.runTool('attack', { target: btn.dataset.target });
      const msg = root.querySelector('#result');
      if (res.result?.success) {
        msg.textContent = res.result.message;
        msg.style.color = '#4dff91';
      } else {
        msg.textContent = res.result?.message || '실패';
        msg.style.color = '#ff4d6a';
      }
      // 패널은 variables/data 변경 시 자동 재렌더링되므로 버튼 상태 복원 불필요
    });
  });
</script>
```
