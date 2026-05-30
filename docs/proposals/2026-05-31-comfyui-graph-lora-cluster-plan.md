# comfyui-graph.ts LoRA 클러스터 완성 (Wave 7) 구현 플랜

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** `injectTriggerTags`/`injectBaseLoRAs`/`applyDynamicLoRAs`를 comfyui-graph.ts로 verbatim 이동 + 호출부 3곳 repoint. behavior-preserving.

Spec: [2026-05-31-comfyui-graph-lora-cluster-design.md](./2026-05-31-comfyui-graph-lora-cluster-design.md)

> ⚠️ **불변식:** 본문 한 글자도 바꾸지 말 것. in-place 변형 보존. 세 메서드 모두 현재 `this.` 참조 0개(검증됨)라 헤더(`private X(`→`export function X(`)만 바뀜.

---

### Task 1: comfyui-graph.ts에 3개 함수 추가

**Files:**
- Modify: `src/lib/comfyui-graph.ts`
- Read-source: `src/lib/comfyui-client.ts` (lines 469–514, 1051–1065, 1068–1145)

- [ ] **Step 1: 원본 본문 읽기** — comfyui-client.ts에서 세 메서드 본문을 실제 파일에서 읽는다(전사 금지).
- [ ] **Step 2: 타입 import 추가** — comfyui-graph.ts 상단(헤더 주석 아래)에:
```ts
import type { WorkflowPackageMeta } from "./workflow-resolver";
```
- [ ] **Step 3: 3개 함수 추가** — 기존 4개 함수 아래에 `export function`으로 본문 그대로 추가:
  - `export function injectTriggerTags(prompt: Record<string, unknown>, meta: WorkflowPackageMeta, triggerTable: Record<string, string>, activeLoRAs: string[]): void`
  - `export function injectBaseLoRAs(prompt: Record<string, unknown>, baseLoras: Array<{ name: string; strength: number }>): void`
  - `export function applyDynamicLoRAs(prompt: Record<string, unknown>, loras: Array<{ name: string; strength: number }>, availableLoRAs: string[]): void`
  - 본문 내 `findLoraInjectionAnchors(...)`/`appendLoraChain(...)` 호출은 같은 모듈 로컬 함수라 그대로 둔다.
- [ ] **Step 4: 빌드** — Run: `npm run build` → 통과(새 export는 미사용이어도 경고 없음).
- [ ] **Step 5: 커밋** (이 파일만 stage — NEVER `git add -A`)
```bash
git add src/lib/comfyui-graph.ts
git commit -m "feat(comfyui-graph): add trigger-tag + LoRA-injection orchestrators"
```

---

### Task 2: comfyui-client.ts repoint

**Files:**
- Modify: `src/lib/comfyui-client.ts`

- [ ] **Step 1: import 확장** — 기존 `from "./comfyui-graph"` import 블록에 3개 추가:
```ts
import {
  pruneUnavailableLoRAs,
  collectActiveLoRAs,
  findLoraInjectionAnchors,
  appendLoraChain,
  injectTriggerTags,
  injectBaseLoRAs,
  applyDynamicLoRAs,
} from "./comfyui-graph";
```
- [ ] **Step 2: 3개 private 메서드 삭제** — `injectTriggerTags`, `injectBaseLoRAs`, `applyDynamicLoRAs` 정의를 클래스에서 제거.
- [ ] **Step 3: 호출부 3곳 repoint** (메서드명으로 찾아서):
  - `this.injectBaseLoRAs(prompt, baseLoras)` → `injectBaseLoRAs(prompt, baseLoras)`
  - `this.applyDynamicLoRAs(prompt, loras, models.loras)` → `applyDynamicLoRAs(prompt, loras, models.loras)`
  - `this.injectTriggerTags(prompt, pkg.meta, triggerTable, activeLoRAs)` → `injectTriggerTags(prompt, pkg.meta, triggerTable, activeLoRAs)`
- [ ] **Step 4: 빌드 + grep**
  - Run: `npm run build` → 통과. (`WorkflowPackageMeta`는 잔여 사용처가 있어 import 유지; 만약 빌드가 unused라 하면 그때만 제거.)
  - 전역 grep `this\.(injectTriggerTags|injectBaseLoRAs|applyDynamicLoRAs)` → **0건**.
- [ ] **Step 5: 커밋** (이 파일만 stage)
```bash
git add src/lib/comfyui-client.ts
git commit -m "refactor(comfyui-client): use extracted LoRA cluster from comfyui-graph"
```

---

### Task 3: 최종 검증
- [ ] `npm run build` 성공.
- [ ] `this.(injectTriggerTags|injectBaseLoRAs|applyDynamicLoRAs)` grep 0건.
- [ ] comfyui-client.ts가 7개 함수를 comfyui-graph에서 import하고 호출부가 함수 호출로 바뀜 확인.
- [ ] `git status --short` — 사용자 미커밋 파일이 여전히 `M`이고 내 커밋 미포함 확인.
