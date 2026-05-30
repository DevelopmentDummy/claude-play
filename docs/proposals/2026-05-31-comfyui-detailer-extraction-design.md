# processDetailerChain 추출 (Wave 10) 설계+플랜

> 거대 클래스 분해(⑥) 후속. detailer 체인 prompt-그래프 수술을 comfyui-graph.ts로 추출. Slice 3 패턴
> (loader 결과를 파라미터로 주입). behavior-preserving.

## 대상
`ComfyUIClient.processDetailerChain`(comfyui-client.ts 769–~950). 유일한 `this.` 의존은 781번
`const modules = this.loadDetailerModules();` 하나(781 이후 다음 `this.`는 953=다른 메서드). 호출부 1곳(690, buildPrompt).

## 타입 의존
- `DetailerChainConfig` — `./workflow-resolver`의 타입(이미 client가 import).
- `DetailerModuleTemplate` — client 로컬 인터페이스(81). 사용처: client 잔존(757 캐시 필드, 760 loadDetailerModules 반환) + graph 이동(826 enabledModules, 새 modules 인자). → **comfyui-graph.ts로 옮겨 export**, client가 import back.

## TS 제약
현재 시그니처 끝이 `paramDefs?` optional. 필수 `modules`를 그 뒤에 못 둠 → **4번째 파라미터**(paramDefs? 앞)로 삽입.

```ts
export function processDetailerChain(
  prompt: Record<string, unknown>,
  chainConfig: DetailerChainConfig,
  params: Record<string, unknown>,
  modules: Record<string, DetailerModuleTemplate>,   // ← line 781 this.loadDetailerModules() 대체
  paramDefs?: Record<string, { default?: unknown }>
): void
```

## 설계

### `src/lib/comfyui-graph.ts`
- import 추가: `import type { DetailerChainConfig } from "./workflow-resolver";` (기존 WorkflowPackageMeta import 옆).
- `export interface DetailerModuleTemplate { ... }` (client 81에서 그대로 이동).
- `export function processDetailerChain(...)` — client 본문 그대로(769–950) 이동, **단 line 781 한 줄만 삭제**(modules는 이제 파라미터). 본문 내 `modules`/`getParam`/`DetailerModuleTemplate` 참조는 그대로 해소.

### `src/lib/comfyui-client.ts`
- comfyui-graph import에 추가: `processDetailerChain` (함수) + `type DetailerModuleTemplate` (757/760용).
- 로컬 `DetailerModuleTemplate` 인터페이스(81) 삭제.
- `processDetailerChain` private 메서드 삭제.
- `loadDetailerModules` + `detailerModulesCache`는 **유지**(this.workflowsDir/캐시 의존).
- 호출부(690) repoint: `processDetailerChain(prompt, pkg.meta.detailer_chain, params, this.loadDetailerModules(), pkg.meta.params)`.

## 동작 보존 불변식
1. **로드 타이밍 동일**: `this.loadDetailerModules()`를 호출부에서 인라인 호출 → detailer_chain feature 게이트 안, 동기. loadDetailerModules는 캐시(this.detailerModulesCache) 있어 call-time/body-time 동치. early-return `if (!modules || Object.keys(modules).length===0) return;`는 함수 안에 그대로(modules는 이제 인자).
2. **본문 byte-동일**(line 781 제거 + 파라미터 추가 외). in-place 변형 보존.

## 검증
1. `npm run build` — TS strict.
2. 전역 grep `this\.processDetailerChain` → 0건. (`this.loadDetailerModules`는 새 호출부 1곳으로 유지.)
3. 적대적 토큰대조: 본문 byte-동일, 인터페이스 이동 정확, 호출부가 loadDetailerModules 4번째 인자로 전달, 로드 타이밍 보존.
