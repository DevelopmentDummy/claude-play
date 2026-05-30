# comfyui-graph.ts 추출 (Wave 6 / Slice 1) 설계

> 2026-05-30 "서비스 전반 개선" 작업의 Wave 6. "거대 클래스 분해"의 **가장 안전한 첫 슬라이스**.
> 진입점: [IMPROVEMENT-STATUS.md](./IMPROVEMENT-STATUS.md). 근거: 멀티에이전트 understand 워크플로(40개 메서드 순수성 분류).

## 목표

`ComfyUIClient`(`src/lib/comfyui-client.ts`, 2034줄)에서 **리프 레벨 순수 그래프 수술 함수 4개**를
신설 `src/lib/comfyui-graph.ts`로 추출한다. behavior-preserving. 클래스의 navigability를 높이고
순수 로직을 격리한다.

테스트 프레임워크가 없으므로 안전성은 ① TypeScript strict 빌드(누락 참조 = 컴파일 에러) ②
레포 전역 grep ③ 수동 generate 스모크에 의존한다.

## 선정 근거 (왜 이 4개가 "unimpeachably safe")

understand 워크플로가 40개 메서드를 분류한 결과, 다음 4개는 **`this`-state 0, fs/network 0,
sibling 메서드 호출 0** 인 리프 함수이고 시그니처가 **이미 완전히 파라미터화**(prompt + plain-data 인자)
되어 있다. 따라서 `private X(` → `export function X(` 로 바꾸면 **본문이 그대로 이동**한다.

| 함수 | 현재 위치 | 시그니처(이동 후) | 비고 |
|---|---|---|---|
| `pruneUnavailableLoRAs` | 349–419 | `(prompt, availableLoRAs: string[]): void` | prompt **in-place 변형**(delete/rewire), console.log만 부수효과 |
| `collectActiveLoRAs` | 479–491 | `(prompt): string[]` | 읽기 전용, 변형 없음 |
| `findLoraInjectionAnchors` | 494–536 | `(prompt): LoraInjectionAnchors \| null` | 읽기 전용. 함수-로컬 const `CLIP_LOADER_TYPES`(521)는 함수 본문과 함께 이동 |
| `appendLoraChain` | 539–596 | `(prompt, loras, anchors, startIdHint?, titlePrefix?): string \| null` | prompt **in-place 변형 + 반환값** 둘 다 load-bearing |

동반 이동 인터페이스(70–78, 이 4개 함수만 사용):
```ts
export interface LoraChainEndpoint { nodeId: string; outputIndex: number; }
export interface LoraInjectionAnchors { model: LoraChainEndpoint; clip: LoraChainEndpoint; }
```

## 호출부 (검증 완료, 전부 클래스 내부)

`private` 메서드라 `comfyui-client.ts` 밖 참조는 없다(grep 확인). 클래스 내 6개 호출부:

| 라인 | 호출 | 소속 메서드 |
|---|---|---|
| 971 | `this.pruneUnavailableLoRAs(prompt, models.loras)` | buildPrompt |
| 985 | `this.collectActiveLoRAs(prompt)` | buildPrompt |
| 1256 | `this.findLoraInjectionAnchors(prompt)` | injectBaseLoRAs |
| 1262 | `this.appendLoraChain(prompt, baseLoras, anchors, 100, "base-lora")` | injectBaseLoRAs |
| 1326 | `this.findLoraInjectionAnchors(prompt)` | applyDynamicLoRAs |
| 1328 | `this.appendLoraChain(prompt, validNewLoras, anchors, 200, "dynamic-lora")` | applyDynamicLoRAs |

각 호출부에서 `this.X(` → `X(` 로 치환한다. 1256/1326의 `const anchors = ...` 는 추론 타입이라
`LoraInjectionAnchors` 명시 import가 필요 없을 수 있다(빌드가 알려줌).

## 설계

### 신설 `src/lib/comfyui-graph.ts`
- 상단에 두 인터페이스를 `export interface` 로 선언.
- 4개 함수를 `comfyui-client.ts` 의 **현재 본문 그대로** 옮겨 `export function` 으로 선언.
  - `private` 키워드 제거, `this.` 참조 없음(이미 검증)이라 본문 변경 0.
  - `findLoraInjectionAnchors` 의 함수-로컬 `CLIP_LOADER_TYPES` const는 함수 안에 그대로 둔다.
- 필요한 import만(현재 본문이 쓰는 것). 이 4개 함수는 외부 타입/모듈 의존이 없으므로 import 불필요할
  가능성이 높다(`workflow-resolver` 타입은 이 슬라이스 함수들이 쓰지 않음 — 그건 injectTriggerTags용).

### `comfyui-client.ts` 수정
- 인터페이스 선언 70–78 삭제(이제 comfyui-graph 소유).
- 4개 private 메서드 선언 삭제.
- 상단 import에 추가: `import { pruneUnavailableLoRAs, collectActiveLoRAs, findLoraInjectionAnchors, appendLoraChain } from "./comfyui-graph";` (+ TS가 요구하면 타입도).
- 호출부 6곳 `this.X(` → `X(`.

## 동작 보존 불변식 (절대 위반 금지)
1. **in-place 변형 유지**: `pruneUnavailableLoRAs`/`appendLoraChain` 은 전달된 `prompt` 객체를 참조로
   변형한다. 호출부는 반환값이 아니라 변형된 prompt를 읽는다. "순수하게 보이니 새 객체 반환으로 바꾸자"
   같은 리팩터는 **buildPrompt 동작을 조용히 깨뜨린다** — 금지.
2. **`appendLoraChain` 반환값 유지**: `string | null` 반환이 호출부의 console.log 게이팅에 쓰인다.
   변형과 반환 둘 다 보존.
3. **본문 한 글자도 바꾸지 않음**: 이동은 순수 code-move. 로직 "개선" 금지.

## 검증
1. `npm run build` — TS strict 통과. 호출부 누락 시 `this.X` 는 더 이상 존재하지 않는 메서드라
   **컴파일 에러**로 즉시 드러남(silent 런타임 실패 경로 없음).
2. 레포 전역 grep: `this.pruneUnavailableLoRAs|this.collectActiveLoRAs|this.findLoraInjectionAnchors|this.appendLoraChain`
   → 0건이어야 함.
3. 적대적 리뷰: 이동 전/후 본문 byte-동일성, in-place 변형/반환 보존, 인터페이스 이동 누락 확인.
4. 수동 스모크(선택, ComfyUI GPU): 실제 이미지 생성 1회 — LoRA 체인이 적용된 워크플로로 prune/anchor/append 경로를 태움.

## 비목표 (이 슬라이스 한정)
- `injectTriggerTags` 는 다음 슬라이스(1b) — pure지만 `workflow-resolver` 타입 import를 끌어와 모듈
  import 표면을 넓히므로 첫 슬라이스에서 제외.
- `injectBaseLoRAs`/`applyDynamicLoRAs`(orchestrator, sibling 호출), `injectCoupleBranchLoras`
  (`this.loadLoraTriggers` 의존), checkpoint 계열, detailer, 히스토리 파서, fs/network 메서드는 후속 슬라이스.
- 위임 래퍼 중간단계 생략(TS strict가 하드 게이트라 불필요한 간접층).
