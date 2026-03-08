# Dynamic LoRA Chain Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** AI가 이미지 생성 요청마다 특수 LoRA(포즈, 액션, 상황)를 동적으로 선택하고 체인에 삽입할 수 있게 한다. 기본 LoRA(퀄리티, 스타일, 아트)는 워크플로우 템플릿에 고정된 채로 유지한다.

**Architecture:** MCP 도구 `comfyui_generate`와 `generate_image`에 `loras` 파라미터를 추가한다. `comfyui-client.ts`의 `buildPrompt()`가 워크플로우의 기존 LoRA 체인 뒤에 동적 LoRA 노드를 삽입하고, 하류 노드(CLIP, KSampler, FaceDetailer)의 model/clip 참조를 새 체인의 마지막 노드로 갱신한다. AI에게는 사용 가능한 LoRA 치트시트를 제공한다.

**Tech Stack:** TypeScript, ComfyUI API (workflow JSON), MCP (zod schema), Handlebars

---

### Task 1: `comfyui-client.ts` — `buildPrompt()`에 동적 LoRA 삽입 로직 추가

**Files:**
- Modify: `src/lib/comfyui-client.ts:424-503` (buildPrompt method)

**Step 1: `GenerateRequest` 인터페이스에 `loras` 필드 추가**

`src/lib/comfyui-client.ts`의 `GenerateRequest` 인터페이스를 수정:

```typescript
interface GenerateRequest {
  workflow: string;
  params: Record<string, unknown>;
  filename: string;
  sessionDir: string;
  extraFiles?: Record<string, string>;
  loras?: Array<{ name: string; strength: number }>;
}
```

**Step 2: `buildPrompt()` 메서드 시그니처에 `loras` 파라미터 추가**

```typescript
private async buildPrompt(
  workflowName: string,
  params: Record<string, unknown>,
  sessionDir?: string,
  loras?: Array<{ name: string; strength: number }>
): Promise<object> {
```

**Step 3: `buildPrompt()` 끝에 동적 LoRA 삽입 로직 추가**

`pruneUnavailableLoRAs()` 호출과 param injection 사이에 삽입:

```typescript
// After pruneUnavailableLoRAs and before param injection:

// Dynamic LoRA injection: append after existing chain
if (loras && loras.length > 0) {
  // Find the last LoraLoader node ID in the current chain
  const loraNodeIds = Object.entries(prompt)
    .filter(([, n]) => (n as Record<string, unknown>).class_type === "LoraLoader")
    .map(([id]) => id)
    .sort((a, b) => Number(a) - Number(b));

  const lastLoraId = loraNodeIds.length > 0 ? loraNodeIds[loraNodeIds.length - 1] : null;

  if (lastLoraId) {
    // Filter to only available LoRAs
    const validLoras = loras.filter(l => models.loras.length === 0 || models.loras.includes(l.name));

    let prevId = lastLoraId;
    const dynamicStartId = 200; // Dynamic LoRAs use IDs 200+

    for (let i = 0; i < validLoras.length; i++) {
      const nodeId = String(dynamicStartId + i);
      const lora = validLoras[i];
      prompt[nodeId] = {
        class_type: "LoraLoader",
        inputs: {
          lora_name: lora.name,
          strength_model: lora.strength,
          strength_clip: lora.strength,
          model: [prevId, 0],
          clip: [prevId, 1],
        },
        _meta: { title: `dynamic-lora-${i}` },
      };
      prevId = nodeId;
    }

    // Rewire downstream nodes: anything referencing old lastLoraId's outputs
    // should now reference the new chain's last node
    if (validLoras.length > 0) {
      const newLastId = prevId;
      for (const [nodeId, node] of Object.entries(prompt)) {
        if (nodeId === newLastId) continue;
        const n = node as Record<string, unknown>;
        if (Number(nodeId) >= dynamicStartId && Number(nodeId) < dynamicStartId + validLoras.length) continue;
        const inputs = n.inputs as Record<string, unknown> | undefined;
        if (!inputs) continue;
        for (const [key, value] of Object.entries(inputs)) {
          if (Array.isArray(value) && value.length === 2 && value[0] === lastLoraId) {
            inputs[key] = [newLastId, value[1]];
          }
        }
      }
    }

    if (validLoras.length > 0) {
      console.log(`[comfyui] Injected ${validLoras.length} dynamic LoRAs after node ${lastLoraId}`);
    }
    if (validLoras.length < loras.length) {
      const skipped = loras.filter(l => !validLoras.includes(l));
      console.log(`[comfyui] Skipped ${skipped.length} unavailable dynamic LoRAs: ${skipped.map(l => l.name).join(", ")}`);
    }
  }
}
```

**Step 4: `generate()` 메서드에서 `loras` 전달**

```typescript
async generate(req: GenerateRequest): Promise<GenerateResult> {
  try {
    const prompt = await this.buildPrompt(
      req.workflow, req.params, req.sessionDir, req.loras
    ) as Record<string, unknown>;
    return this.submitAndWait(prompt, req.filename, req.sessionDir, req.extraFiles);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}
```

**Step 5: 수동 테스트**

서버 시작 후 curl로 테스트:
```bash
curl -s -X POST http://localhost:3340/api/tools/comfyui/generate \
  -H "Content-Type: application/json" \
  -d @/tmp/test-lora.json
```
`/tmp/test-lora.json`:
```json
{
  "workflow": "portrait",
  "params": { "prompt": "masterpiece, best quality, 1girl, test" },
  "filename": "test-dynamic-lora.png",
  "loras": [
    { "name": "some_pose_lora.safetensors", "strength": 0.6 }
  ]
}
```
Expected: 서버 로그에 `[comfyui] Injected 1 dynamic LoRAs` 또는 unavailable 스킵 메시지

**Step 6: 커밋**

```bash
git add src/lib/comfyui-client.ts
git commit -m "feat: add dynamic LoRA injection to buildPrompt()"
```

---

### Task 2: API 라우트와 MCP 도구에 `loras` 파라미터 전달

**Files:**
- Modify: `src/app/api/tools/comfyui/generate/route.ts:47-142`
- Modify: `src/mcp/claude-bridge-mcp-server.mjs:296-378` (comfyui_generate tool)
- Modify: `src/mcp/claude-bridge-mcp-server.mjs:408-448` (generate_image tool)

**Step 1: API 라우트에 `loras` 필드 수용**

`src/app/api/tools/comfyui/generate/route.ts`의 body 타입에 추가:

```typescript
const body = (await req.json()) as {
  workflow?: string;
  params?: Record<string, unknown>;
  raw?: Record<string, unknown>;
  filename?: string;
  extraFiles?: Record<string, string>;
  persona?: string;
  loras?: Array<{ name: string; strength: number }>;
};
```

`client.generate()` 호출 시 `loras` 전달:

```typescript
: await client.generate({
    workflow: body.workflow!,
    params: body.params || {},
    filename: safeName,
    sessionDir: targetDir,
    extraFiles: body.extraFiles,
    loras: body.loras,
  });
```

**Step 2: MCP `comfyui_generate` 도구에 `loras` 스키마 추가**

`claude-bridge-mcp-server.mjs`의 `comfyui_generate` inputSchema에 추가:

```javascript
loras: z.array(z.object({
  name: z.string(),
  strength: z.number().min(-5).max(5),
})).optional(),
```

payload 구성 시 `loras` 포함:

```javascript
const payload = withPersona(
  input.raw
    ? { raw: input.raw, filename, extraFiles: input.extraFiles, ... }
    : {
        workflow,
        params,
        filename,
        extraFiles: input.extraFiles,
        loras: input.loras,
        ...(input.persona ? { persona: input.persona } : {}),
      }
);
```

**Step 3: MCP `generate_image` 도구에 `loras` 스키마 추가**

```javascript
loras: z.array(z.object({
  name: z.string(),
  strength: z.number().min(-5).max(5),
})).optional(),
```

payload에 포함:

```javascript
const payload = withPersona({
  workflow: input.template || COMFY_DEFAULT_TEMPLATE,
  params: { ... },
  filename: ...,
  loras: input.loras,
  ...
});
```

**Step 4: 커밋**

```bash
git add src/app/api/tools/comfyui/generate/route.ts src/mcp/claude-bridge-mcp-server.mjs
git commit -m "feat: pass dynamic loras through API route and MCP tools"
```

---

### Task 3: LoRA 치트시트 파일 생성 및 스킬 문서 업데이트

**Files:**
- Create: `data/tools/comfyui/skills/generate-image/lora-cheatsheet.md`
- Modify: `data/tools/comfyui/skills/generate-image/SKILL.md`

**Step 1: LoRA 치트시트 생성**

`data/tools/comfyui/skills/generate-image/lora-cheatsheet.md`:

```markdown
# Dynamic LoRA Cheatsheet

이 파일은 이미지 생성 시 동적으로 선택 가능한 특수 LoRA 목록이다.
기본 LoRA(퀄리티, 스타일)는 워크플로우에 이미 포함되어 있으므로 여기에 없다.

## 사용 방법

`generate_image` 또는 `comfyui_generate` 도구의 `loras` 파라미터로 전달:

```json
{
  "loras": [
    { "name": "example_pose_lora.safetensors", "strength": 0.6 },
    { "name": "another_lora.safetensors", "strength": 0.5 }
  ]
}
```

## 사용 가능한 LoRA

> **이 목록은 사용자가 실제 보유한 LoRA에 맞게 수정해야 한다.**
> 사용 불가능한 LoRA는 자동으로 스킵되므로 안전하게 요청할 수 있다.

### 포즈/액션 계열

| LoRA 파일명 | 강도 권장 | 용도 | 트리거 태그 |
|---|---|---|---|
| `example_pose.safetensors` | 0.5~0.7 | 특정 포즈 | `pose_tag` |

### 상황/분위기 계열

| LoRA 파일명 | 강도 권장 | 용도 | 트리거 태그 |
|---|---|---|---|
| `example_situation.safetensors` | 0.4~0.6 | 특정 상황 | `situation_tag` |

## 규칙

- 강도는 보통 0.3~0.7 범위. 1.0 이상은 과적합 위험
- 너무 많은 LoRA를 동시에 사용하면 품질 저하 (3개 이내 권장)
- 기존 워크플로우의 base LoRA와 충돌할 수 있으므로 결과를 확인하며 조절
- 사용 불가능한 LoRA는 자동 스킵됨 (에러 없음)
```

**Step 2: SKILL.md에 동적 LoRA 섹션 추가**

SKILL.md의 "## 규칙" 섹션 바로 위에 추가:

```markdown
---

## 동적 LoRA 체인

기본 LoRA(퀄리티, 스타일, 아트)는 워크플로우에 고정되어 있다.
특수 포즈, 액션, 상황에 대한 LoRA는 요청마다 동적으로 추가할 수 있다.

### 사용 방법

`generate_image` 또는 `comfyui_generate` 도구에 `loras` 파라미터 추가:

```json
{
  "template": "portrait",
  "prompt": "1girl, elf, silver hair, ...",
  "loras": [
    { "name": "pose_lora.safetensors", "strength": 0.6 }
  ]
}
```

### 치트시트

사용 가능한 동적 LoRA 목록은 `./lora-cheatsheet.md`를 참조하라.

### 주의사항

- 동적 LoRA는 기본 체인의 **뒤에** 삽입된다
- 사용 불가능한 LoRA는 자동 스킵 (에러 없음)
- 동시 3개 이내 권장
- 강도 범위: 0.3~0.7 (과적합 주의)
```

**Step 3: 커밋**

```bash
git add data/tools/comfyui/skills/generate-image/lora-cheatsheet.md data/tools/comfyui/skills/generate-image/SKILL.md
git commit -m "docs: add dynamic LoRA cheatsheet and update SKILL.md"
```

---

### Task 4: 통합 테스트

**Step 1: 서버 재시작**

```bash
npm run dev
```

**Step 2: LoRA 목록 확인**

```bash
curl -s http://localhost:3340/api/tools/comfyui/models | jq '.loras[:5]'
```

Available LoRA 목록에서 실제 이름을 확인하고 치트시트에 반영.

**Step 3: 동적 LoRA 포함 생성 테스트**

실제 사용 가능한 LoRA로 테스트:

```bash
cat > /tmp/test-dynamic.json << 'EOF'
{
  "workflow": "portrait",
  "params": { "prompt": "masterpiece, best quality, 1girl, smile" },
  "filename": "test-dynamic.png",
  "loras": [
    { "name": "ACTUAL_LORA_NAME.safetensors", "strength": 0.5 }
  ]
}
EOF
curl -s -X POST http://localhost:3340/api/tools/comfyui/generate \
  -H "Content-Type: application/json" \
  -d @/tmp/test-dynamic.json
```

Expected: `{"status":"queued","path":"images/test-dynamic.png"}`
서버 로그: `[comfyui] Injected 1 dynamic LoRAs after node 107`

**Step 4: 사용 불가능한 LoRA 스킵 테스트**

```json
{
  "loras": [
    { "name": "nonexistent_lora.safetensors", "strength": 0.5 }
  ]
}
```

Expected: 서버 로그에 스킵 메시지, 이미지는 정상 생성 (기본 체인만)

**Step 5: 커밋**

```bash
git commit -m "test: verify dynamic LoRA chain integration"
```

---

## 설계 요약

```
워크플로우 JSON (portrait.json)
┌──────────────────────────────────────────────────┐
│ Checkpoint(1) → LoRA 100→101→...→107 (base)     │  ← 고정 (템플릿)
│                                                  │
│ buildPrompt() 동적 삽입:                          │
│              → LoRA 200→201→202 (dynamic)        │  ← AI 선택
│                                                  │
│ CLIP(2), KSampler(5), FaceDetailer(21)           │
│   ↑ model/clip 참조를 마지막 동적 노드로 갱신      │
└──────────────────────────────────────────────────┘
```

- **Base LoRA** (node 100-107): 퀄리티, 스타일, 아트 — 세션 고정
- **Dynamic LoRA** (node 200+): 포즈, 액션, 상황 — AI가 매 요청 선택
- 사용 불가능한 LoRA → 자동 스킵 (pruneUnavailableLoRAs와 동일 원리)
- MCP 도구 스키마: `loras: [{name, strength}]` 배열
