# Panel Custom Tools Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 패널에서 `__panelBridge.runTool(name, args)`로 페르소나별 서버사이드 JavaScript 스크립트를 실행할 수 있게 한다.

**Architecture:** API 엔드포인트가 세션 `tools/{name}.js`를 동적 import()로 로드하여 실행. context 객체로 세션 데이터 접근, 반환값(variables/data)을 파일에 자동 반영. 3개 패널 컴포넌트에 bridge 메서드 추가. 양방향 싱크 지원.

**Tech Stack:** Node.js dynamic `import()`, Next.js App Router API routes

**Spec:** `docs/superpowers/specs/2026-03-12-panel-tools-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/app/api/sessions/[id]/tools/[name]/route.ts` | Create | 툴 실행 API 엔드포인트 |
| `src/components/PanelSlot.tsx` | Modify | `__panelBridge.runTool()` 추가 |
| `src/components/ModalPanel.tsx` | Modify | `__panelBridge.runTool()` 추가 |
| `src/components/DockPanel.tsx` | Modify | `__panelBridge.runTool()` 추가 |
| `src/lib/session-manager.ts` | Modify | 양방향 싱크/diff에 tools 항목 추가 |
| `panel-spec.md` | Modify | 커스텀 툴 섹션 추가 |
| `CLAUDE.md` | Modify | 툴 시스템 문서화 |

---

## Chunk 1: API + Bridge

### Task 1: 툴 실행 API 엔드포인트

**Files:**
- Create: `src/app/api/sessions/[id]/tools/[name]/route.ts`

- [ ] **Step 1: API 엔드포인트 작성**

```typescript
import * as fs from "fs";
import * as path from "path";
import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

const PROTECTED_FILES = new Set([
  "session.json", "builder-session.json", "layout.json",
  "chat-history.json", "package.json", "tsconfig.json",
]);

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; name: string }> }
) {
  const { id, name } = await params;

  // Path traversal check
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    return NextResponse.json({ error: "Invalid tool name" }, { status: 400 });
  }

  const svc = getServices();
  const sessionDir = svc.sessions.getSessionDir(id);
  const toolPath = path.join(sessionDir, "tools", `${name}.js`);

  if (!fs.existsSync(toolPath)) {
    return NextResponse.json({ error: `Tool "${name}" not found` }, { status: 404 });
  }

  // Parse args
  let args: Record<string, unknown> = {};
  try {
    const body = await req.json();
    args = typeof body?.args === "object" && body.args !== null ? body.args : {};
  } catch {
    // empty args is fine
  }

  // Build context
  const varsPath = path.join(sessionDir, "variables.json");
  let variables: Record<string, unknown> = {};
  try {
    variables = JSON.parse(fs.readFileSync(varsPath, "utf-8"));
  } catch {}

  // Load custom data files (same logic as panel-engine)
  const SYSTEM_JSON = new Set([
    "variables.json", "session.json", "builder-session.json",
    "comfyui-config.json", "layout.json", "chat-history.json",
    "package.json", "tsconfig.json", "character-tags.json",
    "voice.json", "chat-options.json", "policy-context.json",
  ]);
  const data: Record<string, unknown> = {};
  try {
    for (const f of fs.readdirSync(sessionDir)) {
      if (f.endsWith(".json") && !SYSTEM_JSON.has(f)) {
        try {
          data[f.replace(".json", "")] = JSON.parse(
            fs.readFileSync(path.join(sessionDir, f), "utf-8")
          );
        } catch {}
      }
    }
  } catch {}

  const context = { variables: { ...variables }, data, sessionDir };

  // Execute tool with timeout
  try {
    const toolUrl = `file://${toolPath.replace(/\\/g, "/")}?t=${Date.now()}`;
    const mod = await import(toolUrl);
    const fn = typeof mod.default === "function" ? mod.default : mod;
    if (typeof fn !== "function") {
      return NextResponse.json({ error: "Tool does not export a function" }, { status: 500 });
    }

    const resultPromise = fn(context, args);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Tool execution timed out (10s)")), 10_000)
    );
    const result = await Promise.race([resultPromise, timeoutPromise]) as {
      variables?: Record<string, unknown>;
      data?: Record<string, Record<string, unknown>>;
      result?: unknown;
    } | undefined;

    // Apply variables patch
    if (result?.variables && typeof result.variables === "object") {
      try {
        const current = JSON.parse(fs.readFileSync(varsPath, "utf-8"));
        const merged = { ...current, ...result.variables };
        fs.writeFileSync(varsPath, JSON.stringify(merged, null, 2), "utf-8");
      } catch {}
    }

    // Apply data file patches
    if (result?.data && typeof result.data === "object") {
      for (const [fileName, patch] of Object.entries(result.data)) {
        if (!fileName.endsWith(".json") || fileName.includes("/") || fileName.includes("\\") || fileName.includes("..")) continue;
        if (PROTECTED_FILES.has(fileName)) continue;
        const filePath = path.join(sessionDir, fileName);
        try {
          let current: Record<string, unknown> = {};
          if (fs.existsSync(filePath)) {
            current = JSON.parse(fs.readFileSync(filePath, "utf-8"));
          }
          const merged = { ...current, ...patch };
          fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), "utf-8");
        } catch {}
      }
    }

    return NextResponse.json({ ok: true, result: result?.result ?? null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Tool execution failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

- [ ] **Step 2: 커밋**

```bash
git add src/app/api/sessions/[id]/tools/[name]/route.ts
git commit -m "feat(tools): add panel tool execution API endpoint"
```

---

### Task 2: 패널 브리지에 runTool 추가

**Files:**
- Modify: `src/components/PanelSlot.tsx`
- Modify: `src/components/ModalPanel.tsx`
- Modify: `src/components/DockPanel.tsx`

- [ ] **Step 1: 3개 컴포넌트에 runTool 메서드 추가**

각 컴포넌트의 bridge 객체에 `updateData` 메서드 뒤에 추가:

```typescript
      async runTool(name: string, args?: Record<string, unknown>) {
        if (!sessionId) return { ok: false, error: "No session" };
        const res = await fetch(`/api/sessions/${sessionId}/tools/${encodeURIComponent(name)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ args: args || {} }),
        });
        return res.json();
      },
```

- [ ] **Step 2: 빌드 확인**

```bash
npm run build
```

- [ ] **Step 3: 커밋**

```bash
git add src/components/PanelSlot.tsx src/components/ModalPanel.tsx src/components/DockPanel.tsx
git commit -m "feat(tools): add __panelBridge.runTool() to all panel components"
```

---

## Chunk 2: Sync + Docs

### Task 3: 양방향 싱크에 tools 항목 추가

**Files:**
- Modify: `src/lib/session-manager.ts`

세션 생성 시 `tools/`는 `copyDirRecursive`가 이미 복사하므로 추가 로직 불필요. 싱크/diff만 추가.

- [ ] **Step 1: getSyncDiff()에 tools 항목 추가**

`getSyncDiff()` 메서드에서 `// Check skills` 블록 바로 앞에 추가:

```typescript
    // Check tools (custom panel tools — *.js files only, not subdirectories)
    const pTools = path.join(personaDir, "tools");
    const sTools = path.join(sessionDir, "tools");
    result.push({ key: "tools", label: "툴 (tools/)", hasChanges: this.toolsDiffer(pTools, sTools) });
```

- [ ] **Step 2: getReverseSyncDiff()에 tools 항목 추가**

`getReverseSyncDiff()` 메서드에서 `// Check skills` 블록 바로 앞에 추가:

```typescript
    // Check tools (reverse direction)
    const sTools = path.join(sessionDir, "tools");
    const pTools = path.join(personaDir, "tools");
    result.push({ key: "tools", label: "툴 (tools/)", hasChanges: this.toolsDiffer(sTools, pTools) });
```

- [ ] **Step 3: syncPersonaToSessionSelective()에 tools 싱크 추가**

`// Sync skills/` 블록 바로 앞에 추가:

```typescript
    // Sync tools/ (custom panel tools — *.js files only)
    if (elements.tools) {
      const personaTools = path.join(personaDir, "tools");
      const sessionTools = path.join(sessionDir, "tools");
      if (fs.existsSync(personaTools)) {
        if (!fs.existsSync(sessionTools)) fs.mkdirSync(sessionTools, { recursive: true });
        for (const file of fs.readdirSync(personaTools)) {
          if (file.endsWith(".js")) {
            fs.copyFileSync(path.join(personaTools, file), path.join(sessionTools, file));
          }
        }
      }
    }
```

- [ ] **Step 4: syncSessionToPersonaSelective()에 역방향 tools 싱크 추가**

`// Sync skills/` 관련 블록 앞에 추가 (reverse sync 함수에는 skills 블록이 없으므로, 파일 동기화 루프 뒤에 추가):

```typescript
    // Sync tools/ (session → persona, *.js files only)
    if (elements.tools) {
      const sessionTools = path.join(sessionDir, "tools");
      const personaTools = path.join(personaDir, "tools");
      if (fs.existsSync(sessionTools)) {
        if (!fs.existsSync(personaTools)) fs.mkdirSync(personaTools, { recursive: true });
        for (const file of fs.readdirSync(sessionTools)) {
          if (file.endsWith(".js")) {
            fs.copyFileSync(path.join(sessionTools, file), path.join(personaTools, file));
          }
        }
      }
    }
```

- [ ] **Step 5: toolsDiffer 헬퍼 메서드 추가**

session-manager.ts의 private 헬퍼 메서드들 근처에 추가:

```typescript
  /** Compare tools/ directories (*.js files only) */
  private toolsDiffer(dir1: string, dir2: string): boolean {
    if (!fs.existsSync(dir1) && !fs.existsSync(dir2)) return false;
    if (!fs.existsSync(dir1) || !fs.existsSync(dir2)) return true;
    const jsFiles1 = fs.readdirSync(dir1).filter(f => f.endsWith(".js")).sort();
    const jsFiles2 = fs.readdirSync(dir2).filter(f => f.endsWith(".js")).sort();
    if (jsFiles1.length !== jsFiles2.length) return true;
    for (let i = 0; i < jsFiles1.length; i++) {
      if (jsFiles1[i] !== jsFiles2[i]) return true;
      if (this.fileDiffers(path.join(dir1, jsFiles1[i]), path.join(dir2, jsFiles2[i]))) return true;
    }
    return false;
  }
```

- [ ] **Step 6: syncPersonaToSession (full sync)에 tools 추가**

`syncPersonaToSession()` 메서드의 elements 객체에 `tools: true` 추가:

```typescript
  syncPersonaToSession(id: string): void {
    this.syncPersonaToSessionSelective(id, {
      panels: true, variables: true, layout: true, opening: true,
      skills: true, instructions: true, worldview: true, characterTags: true,
      dataFiles: true, voice: true, chatOptions: true, tools: true,
    });
  }
```

- [ ] **Step 7: 커밋**

```bash
git add src/lib/session-manager.ts
git commit -m "feat(tools): add tools/ to bidirectional sync and diff"
```

---

### Task 4: panel-spec.md에 커스텀 툴 섹션 추가

**Files:**
- Modify: `panel-spec.md`

- [ ] **Step 1: Bridge API 테이블에 항목 추가**

기존 Bridge API 테이블 (`| `__panelBridge.sessionId` |` 행 뒤)에 추가:

```markdown
| `__panelBridge.updateData(fileName, patch)` | 커스텀 데이터 파일을 부분 업데이트한다. `fileName`은 확장자 포함 (예: `"inventory.json"`). `patch`는 `{ key: value }` 객체. |
| `__panelBridge.runTool(name, args)` | 서버사이드 커스텀 툴을 실행한다. `name`은 `tools/` 폴더 내 `.js` 파일명 (확장자 제외). `args`는 툴에 전달할 인자 객체. 반환값은 `{ ok, result }`. |
```

- [ ] **Step 2: 주의사항 섹션 뒤에 커스텀 툴 섹션 추가**

`## 인라인 패널` 섹션 바로 앞에 새 섹션 추가:

```markdown
---

## 서버사이드 커스텀 툴

AI 에이전트를 거치지 않고 서버에서 직접 로직을 실행할 수 있다. 게임 메카닉(전투 계산, 아이템 조합, 이동), 데이터 변환, 랜덤 이벤트 등 결정적 로직에 유용하다.

### 툴 파일 구조

```
personas/{name}/tools/
├── attack.js       # 전투 로직
├── craft.js        # 제작 시스템
└── travel.js       # 이동 시스템
```

`tools/` 폴더에 `.js` 파일을 넣으면 파일명이 툴 이름이 된다. 세션 생성 시 자동 복사되며, 양방향 싱크를 지원한다.

### 스크립트 인터페이스

각 `.js` 파일은 단일 async 함수를 `module.exports`로 내보낸다:

```javascript
// tools/attack.js
module.exports = async function(context, args) {
  // context.variables  — variables.json 내용 (읽기용 사본)
  // context.data       — 커스텀 데이터 파일들 { inventory: {...}, world: {...} }
  //                      (키는 파일명에서 .json 제거된 형태)
  // context.sessionDir — 세션 디렉토리 절대 경로 (직접 파일 I/O 가능)

  const { target } = args;
  const damage = Math.floor(Math.random() * context.variables.attack) + 1;

  return {
    variables: { lastAction: `${target}에게 ${damage} 데미지` },  // variables.json 패치
    data: { "world.json": { lastBattle: target } },               // 커스텀 데이터 패치
    result: { success: true, damage }                              // 패널에 반환
  };
};
```

### 반환값

| 필드 | 타입 | 설명 |
|------|------|------|
| `variables` | `Record<string, unknown>` | `variables.json`에 shallow merge. 생략 가능. |
| `data` | `Record<string, Record<string, unknown>>` | 파일명(확장자 포함) → 패치 객체. 각 파일에 shallow merge. 생략 가능. |
| `result` | `unknown` | 패널에 그대로 전달되는 임의 데이터. 생략 가능. |

`variables`나 `data`가 있으면 서버가 파일에 반영 후 패널이 자동 재렌더링된다.

### 패널에서 호출

```javascript
const res = await __panelBridge.runTool('attack', { target: 'goblin' });
// res = { ok: true, result: { success: true, damage: 7 } }
```

### D) 전투 시스템 예시

툴 스크립트 (`tools/attack.js`):

```javascript
module.exports = async function(context, args) {
  const { target } = args;
  const enemies = context.data.world?.enemies || [];
  const enemy = enemies.find(e => e.name === target);
  if (!enemy || enemy.hp <= 0) {
    return { result: { success: false, message: `${target}을(를) 공격할 수 없습니다.` } };
  }

  const atk = context.variables.attack || 10;
  const damage = Math.floor(Math.random() * atk) + 1;
  const crit = Math.random() < 0.15;
  const finalDmg = crit ? damage * 2 : damage;
  const newHp = Math.max(0, enemy.hp - finalDmg);

  const updatedEnemies = enemies.map(e =>
    e.name === target ? { ...e, hp: newHp } : e
  );

  return {
    variables: { lastAction: `${target} 공격 → ${finalDmg} 데미지${crit ? ' (크리티컬!)' : ''}` },
    data: { "world.json": { enemies: updatedEnemies } },
    result: { success: true, damage: finalDmg, crit, targetHp: newHp,
      message: `${target}에게 ${finalDmg} 데미지!${crit ? ' 크리티컬!' : ''} (남은 HP: ${newHp})` }
  };
};
```

패널 HTML:

```html
<style>
  .enemy-row { display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-bottom:1px solid #1a1a2e; }
  .atk-btn { background:#c0392b; color:white; border:none; border-radius:6px; padding:4px 12px; font-size:11px; cursor:pointer; }
  .atk-btn:hover { opacity:0.85; }
  .atk-btn:disabled { opacity:0.3; cursor:not-allowed; }
  .battle-log { margin-top:8px; font-size:12px; min-height:20px; }
</style>

{{#each world.enemies}}
  {{#if (gt this.hp 0)}}
  <div class="enemy-row">
    <span>{{this.name}} — HP {{this.hp}}/{{this.maxHp}}</span>
    <button class="atk-btn" data-target="{{this.name}}">공격</button>
  </div>
  {{/if}}
{{/each}}
<div class="battle-log" id="log"></div>

<script>
  const root = document.currentScript.getRootNode();
  root.querySelectorAll('.atk-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '...';
      const res = await __panelBridge.runTool('attack', { target: btn.dataset.target });
      const log = root.querySelector('#log');
      if (res.result?.success) {
        log.textContent = res.result.message;
        log.style.color = res.result.crit ? '#f1c40f' : '#4dff91';
      } else {
        log.textContent = res.result?.message || '실패';
        log.style.color = '#ff4d6a';
      }
    });
  });
</script>
```

### E) 제작 시스템 예시

툴 스크립트 (`tools/craft.js`):

```javascript
module.exports = async function(context, args) {
  const { recipe } = args;
  const recipes = context.data.recipes?.list || [];
  const inv = context.data.inventory?.items || {};

  const r = recipes.find(x => x.name === recipe);
  if (!r) return { result: { success: false, message: '알 수 없는 레시피' } };

  for (const [item, qty] of Object.entries(r.materials)) {
    if ((inv[item] || 0) < qty) {
      return { result: { success: false, message: `${item}이(가) ${qty}개 필요합니다 (보유: ${inv[item] || 0})` } };
    }
  }

  const newItems = { ...inv };
  for (const [item, qty] of Object.entries(r.materials)) newItems[item] -= qty;
  newItems[r.result] = (newItems[r.result] || 0) + 1;

  return {
    data: { "inventory.json": { items: newItems } },
    result: { success: true, message: `${r.result}을(를) 제작했습니다!` }
  };
};
```

패널에서 호출:

```html
<button onclick="(async()=>{
  const res = await __panelBridge.runTool('craft', { recipe: '회복 포션' });
  // 패널 자동 재렌더링으로 인벤토리 갱신
})()">회복 포션 제작</button>
```

### 주의사항

- 스크립트는 서버 프로세스 내에서 실행된다. 무한루프 주의.
- 실행 제한 시간: 10초. 초과 시 에러 반환.
- `context.variables`와 `context.data`는 읽기용 사본이다. 직접 수정해도 파일에 반영되지 않으며, 반드시 `return`의 `variables`/`data`로 반환해야 한다.
- `data` 반환의 키는 파일명 확장자를 포함해야 한다 (예: `"world.json"`, `"inventory.json"`).
- `session.json`, `layout.json` 등 시스템 파일은 수정할 수 없다.
- 여러 버튼의 빠른 연타는 race condition을 유발할 수 있다. 클릭 시 `btn.disabled = true`로 중복 방지를 권장한다.
```

- [ ] **Step 3: 기존 Bridge API 테이블의 `updateVariables` 항목 뒤 설명도 업데이트**

`| Bridge API |` 행의 커스텀 데이터 파일 컬럼을 수정:

기존: `| Bridge API | `__panelBridge.updateVariables()` | 직접 fetch로 수정 가능 |`
변경: `| Bridge API | `__panelBridge.updateVariables()` | `__panelBridge.updateData()` |`

- [ ] **Step 4: 커밋**

```bash
git add panel-spec.md
git commit -m "docs: add custom tools section to panel-spec.md"
```

---

### Task 5: CLAUDE.md 업데이트

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Key Conventions에 커스텀 툴 항목 추가**

`- **Panel bridge methods**:` 항목 뒤에 추가:

```markdown
- **Custom panel tools**: 페르소나 `tools/` 디렉토리의 `.js` 파일은 패널에서 `__panelBridge.runTool(name, args)`로 호출 가능한 서버사이드 스크립트. CommonJS (`module.exports = async function(context, args) {...}`). 세션 생성 시 자동 복사, 양방향 싱크 지원. 10초 타임아웃.
```

- [ ] **Step 2: API Routes 테이블에 추가**

`/api/sessions/[id]/variables` 행 뒤에 추가:

```markdown
| `/api/sessions/[id]/tools/[name]` | POST | Execute custom panel tool |
```

- [ ] **Step 3: Data Model의 personas 섹션에 tools/ 추가**

```markdown
│   ├── tools/                      # Custom panel tool scripts (.js)
```

- [ ] **Step 4: 커밋**

```bash
git add CLAUDE.md
git commit -m "docs: add custom panel tools to CLAUDE.md"
```

---

### Task 6: 빌드 검증

- [ ] **Step 1: 빌드**

```bash
npm run build
```

Expected: 성공
