# comfyui-graph.ts Slice 3 — injectCoupleBranchLoras 추출 (설계+플랜)

> Wave 6·7([comfyui-graph 추출](./2026-05-31-comfyui-graph-extraction-design.md), [LoRA 클러스터](./2026-05-31-comfyui-graph-lora-cluster-design.md))의 후속.
> 이번엔 **순수 verbatim이 아니라 param injection** — 함수가 fs 로더(`this.loadLoraTriggers`)에 의존하므로 triggerTable을 인자로 주입한다. behavior-preserving.

## 목표

`ComfyUIClient.injectCoupleBranchLoras`(comfyui-client.ts 403–468)를 `src/lib/comfyui-graph.ts`로 추출한다.
이 메서드의 유일한 `this.` 의존은 line 414 `const triggerTable = this.loadLoraTriggers();` 하나다.
이를 파라미터로 끌어올려 함수를 순수화한다.

## TS 제약 → 파라미터 위치

현재 시그니처: `(prompt, availableLoRAs, lorasLeft?, lorasRight?)` — 끝이 optional. 필수 `triggerTable`을
optional 뒤에 둘 수 없다(required-after-optional 금지). 따라서 **3번째 파라미터**로 삽입한다.

```ts
export function injectCoupleBranchLoras(
  prompt: Record<string, unknown>,
  availableLoRAs: string[],
  triggerTable: Record<string, string>,
  lorasLeft?: Array<{ name: string; strength: number }>,
  lorasRight?: Array<{ name: string; strength: number }>
): void
```

## 설계

### `src/lib/comfyui-graph.ts` (추가)
- 기존 함수들 아래에 `export function injectCoupleBranchLoras(...)` 추가.
- 본문은 comfyui-client.ts의 현재 본문 그대로(409–467) — **단, line 414
  `const triggerTable = this.loadLoraTriggers();` 한 줄만 삭제**(이제 파라미터로 주입됨).
  본문 내 `triggerTable[lora.name]` 참조는 그대로(파라미터로 해소).
- 새 import 불필요(lo라 타입 인라인, 외부 심볼 없음).

### `src/lib/comfyui-client.ts`
- comfyui-graph import에 `injectCoupleBranchLoras` 추가.
- private 메서드 `injectCoupleBranchLoras`(403–468) 삭제.
- 호출부(line 732) repoint — `this.loadLoraTriggers()`를 **인라인으로 호출해 3번째 인자로 전달**:
  ```ts
  injectCoupleBranchLoras(prompt, models.loras, this.loadLoraTriggers(), lorasLeft, lorasRight);
  ```
- `loadLoraTriggers`는 클래스 private 메서드로 **유지**(line 737의 injectTriggerTags 경로 + 새 호출부에서 사용).

## 동작 보존 불변식
1. **로드 타이밍 동일**: `this.loadLoraTriggers()`를 block 4c(`features.lora_couple_branches` 게이트) 안에서,
   동기로, 호출부에서 인라인 호출 → 원래 메서드 본문 안에서 로드되던 것과 호출 시점·횟수 동일.
   line 737의 별도 로드는 손대지 않음. 두 feature 모두 켜졌을 때의 "2회 로드"도 그대로 보존.
   (중복 로드 dedup은 이번 비목표 — 추출만.)
2. **본문 byte-동일**(line 414 제거 외): 그래프 수술 로직(regionNodes, validLoras 필터, LoraLoader 노드 생성,
   clip rewire, 트리거 태그 주입, console.log) 무변경. in-place 변형(prompt[nodeId]=…, targetInputs.clip/text) 보존.

## 검증
1. `npm run build` — TS strict. 누락 호출부는 컴파일 에러.
2. 전역 grep `this\.injectCoupleBranchLoras` → 0건. (`this.loadLoraTriggers`는 2곳 남는 게 정상.)
3. 적대적 토큰대조: 본문이 line 414 제거 + 파라미터 추가 외 byte-동일, 호출부가 `this.loadLoraTriggers()`를
   3번째 인자로 정확히 넘기는지, 로드 타이밍/게이트 보존.
4. 수동 스모크(선택, ComfyUI GPU): scene-couple 워크플로(lora_couple_branches feature) + 좌/우 LoRA 설정으로 1회 생성.

## 비목표
- block 4c/4d의 triggerTable 중복 로드 dedup(별도 trivial 후속).
- checkpoint 계열/`processDetailerChain`/히스토리 파서는 다음 슬라이스.

## 구현 단계 (subagent-driven)
1. comfyui-graph.ts에 함수 추가(line 414 제거, triggerTable 3번째 param) → build → commit
   (`feat(comfyui-graph): extract injectCoupleBranchLoras with injected triggerTable`).
2. comfyui-client.ts: import 추가 + 메서드 삭제 + 호출부 repoint(`this.loadLoraTriggers()` 인라인 전달) →
   build + grep 0 → commit (`refactor(comfyui-client): use extracted injectCoupleBranchLoras`).
3. 최종 build + grep + 사용자 미커밋 파일 무오염 확인.
