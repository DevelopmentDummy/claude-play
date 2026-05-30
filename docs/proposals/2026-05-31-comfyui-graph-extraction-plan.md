# comfyui-graph.ts 추출 (Wave 6 / Slice 1) 구현 플랜

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** `ComfyUIClient`에서 리프 순수 그래프 수술 함수 4개 + 인터페이스 2개를 신설 `src/lib/comfyui-graph.ts`로 **본문 그대로** 추출하고 호출부 6곳을 repoint한다. behavior-preserving.

**Architecture:** 순수 code-move. 신설 모듈은 `this`/fs/network 무의존 함수만 보유. 클래스는 import해서 호출.

**Tech Stack:** TypeScript strict, Next.js. 검증 = `npm run build` + 전역 grep + (선택) 수동 generate 스모크.

Spec: [2026-05-31-comfyui-graph-extraction-design.md](./2026-05-31-comfyui-graph-extraction-design.md)

> ⚠️ **불변식(절대 위반 금지):** 함수 본문을 한 글자도 바꾸지 말 것. `pruneUnavailableLoRAs`/`appendLoraChain`의 prompt **in-place 변형**과 `appendLoraChain`의 `string|null` 반환을 모두 보존. "순수해 보이니 return-new로" 같은 개선 금지.

---

### Task 1: comfyui-graph.ts 생성 (4 함수 + 2 인터페이스 verbatim 이동)

**Files:**
- Create: `src/lib/comfyui-graph.ts`
- Read-source: `src/lib/comfyui-client.ts` (lines 70–78, 349–419, 479–491, 494–536, 539–596)

- [ ] **Step 1: 원본 본문 정확히 읽기** — `comfyui-client.ts`에서 다음을 그대로 읽어온다(전사하지 말고 실제 파일 내용 사용):
  - 인터페이스: lines 70–78 (`LoraChainEndpoint`, `LoraInjectionAnchors`)
  - `pruneUnavailableLoRAs`: lines 349–419
  - `collectActiveLoRAs`: lines 479–491
  - `findLoraInjectionAnchors`: lines 494–536 (함수-로컬 `CLIP_LOADER_TYPES` const 포함)
  - `appendLoraChain`: lines 539–596

- [ ] **Step 2: 신설 파일 작성** — `src/lib/comfyui-graph.ts`:
  - 파일 상단 doc 주석 1줄(예: `// 순수 ComfyUI prompt-그래프 수술 헬퍼. ComfyUIClient에서 추출(Wave 6 Slice 1). this/fs/network 무의존.`)
  - 두 인터페이스를 `export interface` 로 선언(본문 동일).
  - 4개 함수를 `export function` 으로 선언. 각 함수는 클래스 메서드 본문을 **그대로** 옮기되 메서드 헤더 `private fnName(` → `export function fnName(` 로만 변경. 본문/타입 어노테이션/주석 모두 보존.
  - 이 4개 함수가 본문에서 쓰는 외부 식별자가 있는지 확인: `this.` 참조 없음(검증됨), 모듈/전역 식별자만 사용. 만약 본문이 어떤 import도 요구하지 않으면 import 구문 없음. (TS가 누락을 알려줌.)

- [ ] **Step 3: 빌드 확인** — Run: `npm run build`. 신설 모듈은 아직 미사용이지만 자체 타입 에러가 없어야 함. (exported 함수는 unused 경고 없음.) 실패 시 누락 import/타입을 보완.

- [ ] **Step 4: 커밋** (이 파일만 stage — NEVER `git add -A`; 레포에 사용자 미커밋 파일 있음)
```bash
git add src/lib/comfyui-graph.ts
git commit -m "feat(comfyui-graph): extract pure LoRA-chain graph-surgery helpers"
```

---

### Task 2: comfyui-client.ts repoint (선언 삭제 + import + 호출부 6곳)

**Files:**
- Modify: `src/lib/comfyui-client.ts`

- [ ] **Step 1: import 추가** — 상단 import 블록(현재 `./workflow-resolver`, `./endpoints` import 부근)에 추가:
```ts
import {
  pruneUnavailableLoRAs,
  collectActiveLoRAs,
  findLoraInjectionAnchors,
  appendLoraChain,
} from "./comfyui-graph";
```
  (1256/1326의 `const anchors`는 추론 타입이라 `LoraInjectionAnchors` 명시 import는 빌드가 요구할 때만 추가.)

- [ ] **Step 2: 인터페이스 선언 삭제** — lines 70–78의 `LoraChainEndpoint`/`LoraInjectionAnchors` 선언 제거(이제 comfyui-graph 소유). `DetailerModuleTemplate`(80–89) 등 다른 인터페이스는 건드리지 않음.

- [ ] **Step 3: 4개 private 메서드 선언 삭제** — `pruneUnavailableLoRAs`, `collectActiveLoRAs`, `findLoraInjectionAnchors`, `appendLoraChain` 메서드 정의를 클래스에서 제거. (Task1에서 본문이 신설 모듈로 옮겨짐.)

- [ ] **Step 4: 호출부 6곳 repoint** — `this.X(` → `X(`:
  - line 971: `this.pruneUnavailableLoRAs(prompt, models.loras)` → `pruneUnavailableLoRAs(prompt, models.loras)`
  - line 985: `this.collectActiveLoRAs(prompt)` → `collectActiveLoRAs(prompt)`
  - line 1256: `this.findLoraInjectionAnchors(prompt)` → `findLoraInjectionAnchors(prompt)`
  - line 1262: `this.appendLoraChain(...)` → `appendLoraChain(...)`
  - line 1326: `this.findLoraInjectionAnchors(prompt)` → `findLoraInjectionAnchors(prompt)`
  - line 1328: `this.appendLoraChain(...)` → `appendLoraChain(...)`
  (라인 번호는 삭제 작업으로 이동하므로, 메서드명 기준으로 찾아 치환.)

- [ ] **Step 5: 빌드 + 잔존 참조 grep**
  - Run: `npm run build` → TS strict 통과. (누락 호출부가 있으면 `this.X`가 존재하지 않는 메서드라 컴파일 에러로 드러남 → 수정.)
  - Run (전역 grep): `this\.(pruneUnavailableLoRAs|collectActiveLoRAs|findLoraInjectionAnchors|appendLoraChain)` → **0건**이어야 함.

- [ ] **Step 6: 커밋** (이 파일만 stage)
```bash
git add src/lib/comfyui-client.ts
git commit -m "refactor(comfyui-client): use extracted comfyui-graph helpers, drop private copies"
```

---

### Task 3: 최종 검증

- [ ] **Step 1: 빌드** — Run: `npm run build` → 성공.
- [ ] **Step 2: 잔존 참조 0 확인** — `this.(pruneUnavailableLoRAs|collectActiveLoRAs|findLoraInjectionAnchors|appendLoraChain)` 전역 grep 0건.
- [ ] **Step 3: 새 모듈 사용 확인** — `comfyui-client.ts`가 `from "./comfyui-graph"` 로 4개 함수를 import하고 호출부 6곳이 함수 호출로 바뀌었는지 확인.
- [ ] **Step 4: 미커밋 사용자 파일 무오염** — `git status --short` 에서 사용자 파일(`builder-prompt.md`, `data/**/SKILL.md`, `session-shared.md`, `src/mcp/claude-play-mcp-server.mjs`, 스펙 doc)이 여전히 `M`이고 내 커밋에 미포함 확인.
