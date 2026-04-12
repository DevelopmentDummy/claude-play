# ComfyUI Workflow Packages Design

## Problem

현재 ComfyUI 이미지 생성은 사전 정의된 워크플로우 템플릿(portrait, scene 등 7개)에서 `_meta.params`의 고정된 node+field 매핑으로 파라미터를 치환하는 방식이다. 새로운 노드 조합이나 다른 워크플로우 구조를 쓰려면 직접 JSON 파일을 만들어 폴더에 넣어야 하고, 워크플로우별로 다른 파라미터 셋이나 복잡한 패치 로직을 지원할 수 없다.

## Goal

- AI가 MCP 도구를 통해 워크플로우 패키지를 리스팅, 조회, 생성/수정, 삭제할 수 있게 한다
- 워크플로우별로 고유한 파라미터 스키마와 해석기(resolver)를 묶은 패키지 단위로 관리한다
- 기존 7개 워크플로우를 새 패키지 구조로 마이그레이션한다

## Design

### 1. Workflow Package Structure

각 워크플로우는 `data/tools/comfyui/skills/generate-image/workflows/{name}/` 디렉토리로 관리된다.

```
workflows/
├── portrait/
│   ├── workflow.json      # ComfyUI API format 원본
│   ├── params.json        # 선언적 파라미터 스키마 + 노드 매핑 + 패키지 메타데이터
│   └── resolver.mjs       # (선택) 커스텀 리졸버
├── scene/
│   ├── workflow.json
│   └── params.json
├── my-controlnet/
│   ├── workflow.json
│   ├── params.json
│   └── resolver.mjs       # 복잡한 패치 로직이 필요한 경우
└── ...
```

#### workflow.json

ComfyUI API format의 원본 워크플로우. `{"nodeId": {"class_type": "...", "inputs": {...}}, ...}` 형태. 기존의 노드별 `_meta` 필드는 유지해도 되고 없어도 된다 (리졸버가 처리하므로).

기존에 워크플로우 최상위에 있던 `_meta.params`는 `params.json`으로 분리되므로 `workflow.json`에서는 제거한다.

#### params.json

워크플로우가 받는 파라미터의 스키마, 노드 매핑, 패키지 메타데이터를 선언적으로 정의한다.

```json
{
  "description": "캐릭터 초상 (832x1216 세로) — LoRA + FaceDetailer + 4x Upscale",
  "features": {
    "checkpoint_auto": true,
    "lora_injection": true,
    "lora_couple_branches": false,
    "seed_randomize": true,
    "trigger_tags": true
  },
  "outputs": {
    "main": { "node": "41", "type": "image" }
  },
  "params": {
    "prompt": {
      "node": "2",
      "field": "text",
      "type": "string",
      "required": true,
      "description": "이미지 생성 프롬프트"
    },
    "negative_prompt": {
      "node": "3",
      "field": "text",
      "type": "string",
      "default": "bad quality, worst quality, worst detail, sketch, censored, watermark"
    },
    "width": {
      "node": "4",
      "field": "width",
      "type": "number",
      "default": 832
    },
    "height": {
      "node": "4",
      "field": "height",
      "type": "number",
      "default": 1216
    },
    "steps": {
      "node": "5",
      "field": "steps",
      "type": "number",
      "default": 24
    },
    "cfg": {
      "node": "5",
      "field": "cfg",
      "type": "number",
      "default": 6.5
    },
    "seed": {
      "node": "5",
      "field": "seed",
      "type": "number",
      "default": -1
    }
  }
}
```

필드 정의:
- `description`: 패키지 설명 (AI가 워크플로우 선택 시 참고)
- `features`: 이 워크플로우에 적용할 런타임 변환 플래그 (Section 2 참조)
- `outputs`: 워크플로우의 출력 정보 (기존 `_meta.outputs` 대체)
- `params`: 파라미터 매핑
  - `node`: 대상 노드 ID (문자열)
  - `field`: 해당 노드의 `inputs` 내 필드명
  - `type`: `"string"` | `"number"` | `"boolean"` | `"object"` | `"array"`
  - `required`: true이면 필수 파라미터
  - `default`: 기본값 (required가 아닐 때)
  - `description`: 파라미터 설명 (AI가 참고)

#### resolver.mjs (선택)

커스텀 리졸버. 존재하면 기본 리졸버(파라미터 치환 단계) 대신 이 파일의 함수가 파라미터 치환을 담당한다. 런타임 변환(checkpoint, LoRA 등)은 리졸버 이후에 별도로 실행된다 (Section 2의 파이프라인 참조).

```javascript
// resolver.mjs
/**
 * @param {Record<string, any>} workflow - workflow.json의 파싱된 내용 (deep copy)
 * @param {Record<string, any>} params - MCP에서 전달된 파라미터
 * @param {object} context - 추가 컨텍스트
 * @param {string} context.sessionDir - 세션 디렉토리 경로
 * @param {object} context.config - comfyui-config.json 내용
 * @param {object} context.models - 사용 가능한 모델 목록 {checkpoints, loras, ...}
 * @param {function} context.defaultResolve - 내장 기본 리졸버 함수 (부분 위임 가능)
 * @returns {Record<string, any>} 파라미터가 치환된 워크플로우
 */
export default function resolve(workflow, params, context) {
  // 기본 리졸버로 공통 파라미터를 먼저 처리한 뒤 추가 로직 적용 가능
  const patched = context.defaultResolve(workflow, params, context);
  // 커스텀 로직...
  return patched;
}
```

### 2. Prompt Build Pipeline

현재 `buildPrompt()`는 파라미터 치환 외에도 체크포인트 자동 선택, LoRA 주입/프루닝, scene-couple 분기, 트리거 태그 주입, 시드 랜덤화 등의 런타임 변환을 수행한다. 리졸버는 이 파이프라인의 한 단계로 위치한다.

**실행 순서:**

```
1. 패키지 로드
   └─ workflow.json + params.json 읽기

2. 파라미터 검증
   └─ params.json의 type/required 기반으로 MCP 입력 검증. 알 수 없는 키는 무시.

3. 리졸버 (파라미터 치환)
   ├─ resolver.mjs 있음 → 커스텀 리졸버 호출
   └─ 없음 → 기본 리졸버 (node+field 매핑으로 단순 치환)

4. 런타임 변환 (features 플래그에 따라 선택 실행)
   ├─ checkpoint_auto: CheckpointLoaderSimple 노드의 ckpt_name을 사용 가능한 모델로 교체
   ├─ lora_injection: base LoRA 주입 + 동적 LoRA override/injection + 프루닝
   ├─ lora_couple_branches: scene-couple용 좌/우 CLIP 브랜치 LoRA 주입
   ├─ trigger_tags: 활성 LoRA의 트리거 태그를 프롬프트에 자동 삽입
   └─ seed_randomize: seed가 -1이면 랜덤 값으로 교체

5. 제출
   └─ ComfyUI /prompt 엔드포인트로 전송
```

`features` 플래그로 각 런타임 변환을 워크플로우별로 on/off할 수 있다. 예를 들어 체크포인트가 없는 워크플로우(이미지 후처리 등)는 `checkpoint_auto: false`로 설정한다.

커스텀 리졸버는 3단계만 대체한다. 4단계(런타임 변환)는 리졸버 이후 항상 실행되므로, 리졸버가 LoRA나 체크포인트를 직접 관리할 필요 없이 파라미터 치환에만 집중하면 된다.

### 3. Dynamic Import Mechanics

`resolver.mjs`의 동적 로딩 시 고려사항:

- **Windows 호환**: `pathToFileURL()`로 파일 경로를 `file://` URL로 변환하여 `import()` 호출
- **캐시 무효화**: `resolver.mjs`가 편집된 후에도 ESM 캐시가 이전 버전을 반환하는 문제 방지를 위해, import 시 `?t={mtime}` 쿼리 파라미터를 URL에 추가하여 캐시 버스팅
- **에러 처리**: resolver 로드/실행 중 에러 발생 시 generation 자체를 실패 처리 (기본 리졸버로 폴백하지 않음). 에러 메시지에 resolver 파일 경로 포함

```typescript
// 로더 예시
import { pathToFileURL } from "node:url";

async function loadResolver(resolverPath: string) {
  const stat = fs.statSync(resolverPath);
  const url = `${pathToFileURL(resolverPath)}?t=${stat.mtimeMs}`;
  const mod = await import(url);
  return mod.default;
}
```

### 4. MCP Tool

#### `comfyui_workflow`

단일 MCP 도구로 워크플로우 패키지의 CRUD를 모두 처리한다.

```
action: "list" | "get" | "save" | "delete"
```

도구의 description은 간결하게 기능을 요약하고, 상세 사용법은 별도 스킬 문서를 참조하도록 안내한다.

**inputSchema:**

```javascript
{
  action: z.enum(["list", "get", "save", "delete"]),
  name: z.string().optional(),                     // get/save/delete 시 패키지 이름
  workflow: z.record(z.unknown()).optional(),       // save 시 workflow.json 내용
  params: z.record(z.unknown()).optional(),         // save 시 params.json 내용
  resolver: z.string().nullable().optional(),       // save 시 resolver.mjs 소스코드 (null이면 기존 resolver 삭제)
}
```

**action별 동작:**

- **list**: `workflows/` 하위 디렉토리를 순회, 각 패키지의 `name` + `params.json`의 `description` + 파라미터 요약 반환
- **get**: 특정 패키지의 `workflow.json`, `params.json` 내용, `resolver.mjs` 소스코드 (있으면) 반환
- **save**: `name`으로 디렉토리 생성(또는 덮어쓰기), `workflow.json`과 `params.json` 저장.
  - `resolver`가 문자열이면 → `resolver.mjs`로 저장
  - `resolver`가 `null`이면 → 기존 `resolver.mjs` 삭제
  - `resolver`가 생략(undefined)이면 → 기존 `resolver.mjs` 유지
  - 쓰기는 임시 디렉토리에 먼저 쓴 뒤 rename으로 원자적 교체 (부분 쓰기 방지)
  - 패키지 이름 검증: 영문, 숫자, 하이픈, 언더스코어만 허용
- **delete**: 패키지 디렉토리 삭제

### 5. Usage Skill

MCP 도구와 별도로, AI가 `comfyui_workflow` 도구를 효과적으로 사용하기 위한 스킬 문서를 작성한다. 이 스킬은 MCP 서버의 SKILL.md 또는 세션 시스템 프롬프트로 로드된다.

스킬 문서에 포함할 내용:
- 각 action별 필수/선택 파라미터와 호출 예시
- 새 워크플로우 등록 시 workflow JSON 분석 → params.json 추출 가이드라인
- features 플래그 설정 가이드 (어떤 워크플로우에 어떤 플래그가 필요한지)
- resolver.mjs 작성 가이드 (인터페이스, context 객체 필드, defaultResolve 활용)
- `comfyui_generate`와의 연동 (워크플로우 이름으로 참조)
- 주의사항 (이름 규칙, 필수 파라미터 누락, resolver 에러 시 동작 등)

스킬 문서의 위치와 형태는 기존 프로젝트의 MCP 스킬 관리 방식을 따른다.

### 6. Existing Code Changes

#### comfyui-client.ts

- `buildPrompt()` 리팩터:
  - 기존: `workflows/{name}.json` 로드 → `_meta.params` 매핑 → 런타임 변환 혼재
  - 변경: 패키지 로드 → 파라미터 검증 → 리졸버 → features 기반 런타임 변환 (5단계 파이프라인)
  - `workflow.json` + `params.json` 분리 로드
  - `resolver.mjs` 존재 시 dynamic import (Section 3), 없으면 내장 기본 리졸버
  - 런타임 변환들을 `features` 플래그로 조건부 실행하도록 분리
  - scene-couple 전용 `loras_left`/`loras_right` 로직은 `lora_couple_branches` 플래그로 게이팅

#### claude-play-mcp-server.mjs

- `comfyui_workflow` 도구 등록 추가
- `comfyui_generate`의 `template` enum 제거 → 동적으로 존재하는 패키지 이름을 받음
- description에 스킬 참조 안내 추가

### 7. Migration

기존 7개 워크플로우 파일을 패키지 디렉토리로 변환한다.

#### 일반 워크플로우 (5개)

`portrait`, `scene`, `scene-real`, `profile`, `portrait-couple`:
- `{name}.json` → `{name}/workflow.json` (최상위 `_meta.params` 제거)
- 기존 `_meta.params` + `_meta.description` + `_meta.outputs` → `{name}/params.json`으로 추출
- `features`는 기존 `buildPrompt()` 동작에 맞게 설정 (대부분 `checkpoint_auto`, `lora_injection`, `seed_randomize`, `trigger_tags` = true)

#### scene-couple

- 동일하게 패키지 디렉토리로 변환
- `features.lora_couple_branches: true` 설정
- 기존 `buildPrompt()` 내의 워크플로우 이름 기반 분기 (`workflowName === "scene-couple"`)를 features 플래그 기반으로 전환

#### face-crop

현재 `face-crop.json` 워크플로우 파일이 존재하지만, 실제 face-crop 로직은 `ComfyUIClient.faceCrop()` 메서드에서 인라인으로 워크플로우를 빌드한다 (`comfyui-client.ts:1192-1264`). 이 메서드는 이미지 업로드 → 인라인 워크플로우 생성 → 제출의 특수한 흐름을 가진다.

처리 방침:
- `face-crop`은 패키지로 마이그레이션하지 않고, 기존 `faceCrop()` 인라인 로직을 유지한다
- `face-crop.json` 파일이 존재하면 삭제하되, `faceCrop()` 메서드는 그대로 둔다
- 이 워크플로우는 AI가 직접 호출하는 것이 아니라 프로필 이미지 자동 생성 등 내부 로직에서 사용되므로, MCP 패키지 관리 대상이 아니다

#### 마이그레이션 후 정리

- 기존 플랫 `{name}.json` 파일은 삭제
- `buildPrompt()`에서 레거시 플랫 파일 로딩 코드 제거 (이중 지원 없음, 깨끗하게 전환)

### 8. File I/O Strategy

`comfyui_workflow` MCP 도구는 API 라우트를 거치지 않고 MCP 서버 내에서 직접 파일시스템에 접근한다. 현재 `readComfyConfig()` 등이 `sessionDir` 기반으로 직접 `fs`를 쓰는 기존 패턴과 동일하다.

워크플로우 디렉토리 경로: `sessionDir`에서 역추적하여 `data/tools/comfyui/skills/generate-image/workflows/`를 참조한다.
