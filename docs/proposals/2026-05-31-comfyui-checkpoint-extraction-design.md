# comfyui-checkpoint.ts 추출 (Wave 11) 설계+플랜

> 거대 클래스 분해(⑥)의 **최고난도 슬라이스** — checkpoint 해석/호환성 5개 메서드를 다중 주입으로
> 신설 `src/lib/comfyui-checkpoint.ts`로 추출. behavior-preserving.

## 대상 + 주입 (understand 워크플로 + 본문 정독 확인)

| 함수 | 현 위치 | this-의존 | 처리 |
|---|---|---|---|
| `readDirConfig(dir)` | 336–353 | 없음(순수 fs) | verbatim |
| `loadCheckpointRegistry()` | 439–450 | 없음(순수 fs) | verbatim |
| `findCompatiblePackages(registryEntry, excludeName)` | 452–475 | `this.workflowsDir`×3 (456·458·460) | **workflowsDir 3번째 파라미터** 주입; 본문 `this.workflowsDir`→`workflowsDir` |
| `resolveCheckpoint(availableCheckpoints, sessionDir?)` | 393–437 | `this.checkpointName`(396), `this.readDirConfig`(413) | **checkpointName 2번째 파라미터** 주입; `this.checkpointName`→`checkpointName`, `this.readDirConfig`→`readDirConfig`(모듈 로컬) |
| `validateCheckpointCompatibility(prompt, pkg)` | 477–528 | `this.loadCheckpointRegistry`(495), `this.findCompatiblePackages`(517) | **workflowsDir 3번째 파라미터** 주입; `this.loadCheckpointRegistry`→`loadCheckpointRegistry`(로컬), `this.findCompatiblePackages(entry, pkg.name)`→`findCompatiblePackages(entry, pkg.name, workflowsDir)` |

`checkpointName` getter(96–102: `this.config.checkpoint || process.env.COMFYUI_CHECKPOINT || "model.safetensors"`)는 호출부(579)서 `this.checkpointName`로 계속 사용 → **클래스에 유지**.

## 신설 모듈 시그니처
```ts
import type { WorkflowPackageMeta } from "./workflow-resolver";

export function readDirConfig(dir: string): { checkpoint?: string; baseLoras?: Array<{ name: string; strength: number }> }
export function loadCheckpointRegistry(): Record<string, Record<string, string>>
export function findCompatiblePackages(registryEntry: Record<string, string>, excludeName: string, workflowsDir: string): string[]
export function resolveCheckpoint(availableCheckpoints: string[], checkpointName: string, sessionDir?: string): string
export function validateCheckpointCompatibility(prompt: Record<string, unknown>, pkg: { name: string; meta: WorkflowPackageMeta }, workflowsDir: string): void
```
타입: `WorkflowPackageMeta`(findCompatiblePackages 463 `as WorkflowPackageMeta`, validateCheckpointCompatibility pkg.meta) → workflow-resolver에서 import.

## comfyui-client.ts 수정
- import 추가: 위 5개 함수 from `"./comfyui-checkpoint"`.
- 5개 private 메서드(336–353, 393–437, 439–450, 452–475, 477–528) 삭제. `loadLoraTriggers`(355–390)는 **사이에 끼어있으니 건드리지 말 것**(체크포인트 클러스터 아님, 유지).
- `checkpointName` getter(96–102) 유지.
- 호출부 repoint (메서드명 기준):
  - `this.readDirConfig(sessionDir)` ×2 (558·604) → `readDirConfig(sessionDir)`
  - `this.resolveCheckpoint(models.checkpoints, sessionDir)` (579) → `resolveCheckpoint(models.checkpoints, this.checkpointName, sessionDir)`
  - `this.validateCheckpointCompatibility(prompt, pkg)` (586) → `validateCheckpointCompatibility(prompt, pkg, this.workflowsDir)`
  - `loadCheckpointRegistry`/`findCompatiblePackages`는 호출부가 클러스터 내부뿐(495·517) — 모듈 로컬로 해소, client 호출부 없음.

## 동작 보존 불변식
1. **주입값 동치**: `this.checkpointName`(getter, 순수 read)·`this.workflowsDir`(string field)를 호출부서 평가해 전달 → 함수 내부서 읽던 것과 값·타이밍 동일(부수효과 없음). resolveCheckpoint의 글로벌/dir config 오버라이드 로직은 함수 내부에 그대로 — `configured`가 주입된 checkpointName으로 초기화될 뿐.
2. **본문 byte-동일**(this.→param/local 치환 외). throw 메시지·console.log·필터 무변경. readDirConfig/loadCheckpointRegistry는 완전 verbatim.

## 검증
1. `npm run build` — TS strict.
2. 전역 grep `this\.(readDirConfig|resolveCheckpoint|loadCheckpointRegistry|findCompatiblePackages|validateCheckpointCompatibility)` → 0건. (`this.checkpointName`·`this.workflowsDir`는 유지.)
3. 적대적 토큰대조: 5함수 본문이 명시된 this.→param/local 치환 외 byte-동일, 호출부 주입 정확, getter 유지.
