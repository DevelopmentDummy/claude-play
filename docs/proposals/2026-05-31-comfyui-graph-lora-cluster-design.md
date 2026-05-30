# comfyui-graph.ts LoRA 클러스터 완성 (Wave 7 / Slice 1b+2) 설계

> Wave 6 Slice 1([comfyui-graph 추출](./2026-05-31-comfyui-graph-extraction-design.md))의 직속 후속.
> "LoRA/트리거 그래프 수술" 클러스터를 comfyui-graph.ts로 마저 모은다. behavior-preserving.

## 목표

`ComfyUIClient`에서 LoRA/트리거 prompt-그래프 수술 메서드 3개를 `src/lib/comfyui-graph.ts`로 추가 추출한다.

| 함수 | 현재 위치 | 시그니처 | 비고 |
|---|---|---|---|
| `injectTriggerTags` | 469–514 | `(prompt, meta: WorkflowPackageMeta, triggerTable, activeLoRAs): void` | prompt inputs **in-place 변형**, `WorkflowPackageMeta` 타입 필요 |
| `injectBaseLoRAs` | 1051–1065 | `(prompt, baseLoras): void` | findLoraInjectionAnchors+appendLoraChain 호출 |
| `applyDynamicLoRAs` | 1068–1145 | `(prompt, loras, availableLoRAs): void` | 2-phase override/inject, 동일 헬퍼 호출 |

## 핵심 관찰 (왜 verbatim 이동인가)

Wave 6 Slice 1이 `injectBaseLoRAs`/`applyDynamicLoRAs` 내부의 anchor-헬퍼 호출을 이미
`this.findLoraInjectionAnchors`/`this.appendLoraChain` → `findLoraInjectionAnchors`/`appendLoraChain`
(comfyui-graph import)로 repoint했다. 그 결과 **이 두 orchestrator는 현재 `this.` 참조가 0개**다.
`injectTriggerTags`도 원래부터 `this.` 0개. 따라서 셋 다 **완전 verbatim 이동**이며, comfyui-graph.ts
내부에서 `findLoraInjectionAnchors`/`appendLoraChain` 호출은 같은 모듈의 로컬 함수로 자연 해소된다.

검증(grep): `this.(injectTriggerTags|injectBaseLoRAs|applyDynamicLoRAs)` 호출부는 buildPrompt 3곳뿐
(768·772·785), 다른 호출자 없음.

## 설계

### `src/lib/comfyui-graph.ts` 확장
- 상단에 `import type { WorkflowPackageMeta } from "./workflow-resolver";` 추가(injectTriggerTags 전용).
- 3개 함수를 comfyui-client.ts **현재 본문 그대로** 옮겨 `export function`으로 선언. `private` 제거 외
  본문/타입/주석 무변경. 내부의 `findLoraInjectionAnchors`/`appendLoraChain` 호출은 그대로 둠(로컬 해소).

### `src/lib/comfyui-client.ts` 수정
- 기존 comfyui-graph import에 3개 함수 추가:
  `injectTriggerTags, injectBaseLoRAs, applyDynamicLoRAs`.
- 3개 private 메서드 정의 삭제.
- 호출부 3곳 `this.X(` → `X(`:
  - 768 `this.injectBaseLoRAs(prompt, baseLoras)`
  - 772 `this.applyDynamicLoRAs(prompt, loras, models.loras)`
  - 785 `this.injectTriggerTags(prompt, pkg.meta, triggerTable, activeLoRAs)`
- `WorkflowPackageMeta` import는 comfyui-client.ts에서 계속 사용(잔여 3회)되므로 **유지**.

## 동작 보존 불변식 (Wave 6과 동일)
1. **본문 한 글자도 변경 없음** — 순수 code-move.
2. **in-place 변형 유지** — injectTriggerTags(inputs[field] 갱신), applyDynamicLoRAs(prompt delete/rewire).
3. 로직 "개선" 금지.

## 검증
1. `npm run build` — TS strict. 누락 호출부는 컴파일 에러로 드러남.
2. 전역 grep `this.(injectTriggerTags|injectBaseLoRAs|applyDynamicLoRAs)` → 0건.
3. 적대적 토큰대조: 이동 전(현재 main HEAD)/후 본문 byte-동일(들여쓰기+헤더 외), 호출부 인자 동일, 인터페이스/타입 import 정확성.
4. 수동 스모크(선택, ComfyUI GPU): base LoRA 설정 + dynamic LoRA + 트리거 태그가 적용되는 워크플로 1회 생성.

## 비목표 (다음 슬라이스)
- `injectCoupleBranchLoras`(`this.loadLoraTriggers` 의존 → triggerTable 파라미터화 필요), checkpoint 계열,
  `processDetailerChain`(detailer-modules map 주입), 히스토리 파서(→ comfyui-history.ts)는 후속.
