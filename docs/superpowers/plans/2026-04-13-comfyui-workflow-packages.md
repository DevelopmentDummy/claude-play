# ComfyUI Workflow Packages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 워크플로우를 패키지(workflow.json + params.json + optional resolver.mjs) 단위로 관리하고, AI가 MCP 도구를 통해 CRUD할 수 있게 한다.

**Architecture:** 기존 플랫 JSON 워크플로우를 디렉토리 기반 패키지로 마이그레이션. `buildPrompt()`를 5단계 파이프라인(로드 → 검증 → 리졸버 → 런타임 변환 → 제출)으로 리팩터. 단일 MCP 도구 `comfyui_workflow`로 CRUD 제공, 상세 사용법은 SKILL.md로 분리.

**Tech Stack:** TypeScript, Node.js ESM dynamic import, zod schema validation

**Spec:** `docs/superpowers/specs/2026-04-13-comfyui-workflow-packages-design.md`

---

## File Structure

### New Files
- `src/lib/workflow-resolver.ts` — 기본 리졸버 + 커스텀 리졸버 로더 + 파라미터 검증
- `data/tools/comfyui/skills/manage-workflows/SKILL.md` — `comfyui_workflow` 도구 사용 스킬

### Modified Files
- `src/lib/comfyui-client.ts` — `buildPrompt()` 리팩터 (5단계 파이프라인)
- `src/mcp/claude-play-mcp-server.mjs` — `comfyui_workflow` 도구 등록 + `comfyui_generate` template enum 제거

### Migrated Files (data/, gitignored)
- `data/tools/comfyui/skills/generate-image/workflows/{name}.json` → `{name}/workflow.json` + `{name}/params.json`

---

## Task 1: workflow-resolver.ts — 기본 리졸버 + 로더

기존 `buildPrompt()` 내 파라미터 치환 로직과 커스텀 리졸버 dynamic import를 독립 모듈로 분리한다.

**Files:**
- Create: `src/lib/workflow-resolver.ts`

- [ ] **Step 1: 타입 정의 작성**

```typescript
// src/lib/workflow-resolver.ts
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "node:url";

export interface ParamDef {
  node: string;
  field: string;
  type?: "string" | "number" | "boolean" | "object" | "array";
  required?: boolean;
  default?: unknown;
  description?: string;
}

export interface WorkflowFeatures {
  checkpoint_auto?: boolean;
  lora_injection?: boolean;
  lora_couple_branches?: boolean;
  seed_randomize?: boolean;
  trigger_tags?: boolean;
}

export interface WorkflowOutputDef {
  node: string;
  type?: string;
  description?: string;
}

export interface WorkflowPackageMeta {
  description?: string;
  features?: WorkflowFeatures;
  outputs?: Record<string, WorkflowOutputDef>;
  params: Record<string, ParamDef>;
}

export interface ResolverContext {
  sessionDir?: string;
  config?: Record<string, unknown>;
  models?: { checkpoints: string[]; loras: string[] };
  defaultResolve: ResolverFn;
}

export type ResolverFn = (
  workflow: Record<string, unknown>,
  params: Record<string, unknown>,
  context: ResolverContext
) => Record<string, unknown>;
```

- [ ] **Step 2: 패키지 로드 함수 작성**

```typescript
export interface WorkflowPackage {
  name: string;
  workflow: Record<string, unknown>;
  meta: WorkflowPackageMeta;
  resolverPath?: string; // resolver.mjs가 존재하면 절대 경로
}

/**
 * 워크플로우 패키지 디렉토리에서 workflow.json + params.json을 로드한다.
 * @param workflowsDir workflows/ 루트 디렉토리 절대 경로
 * @param name 패키지 이름 (디렉토리명)
 */
export function loadPackage(workflowsDir: string, name: string): WorkflowPackage {
  const pkgDir = path.join(workflowsDir, name);

  if (!fs.existsSync(pkgDir) || !fs.statSync(pkgDir).isDirectory()) {
    throw new Error(`Workflow package "${name}" not found at ${pkgDir}`);
  }

  const workflowPath = path.join(pkgDir, "workflow.json");
  if (!fs.existsSync(workflowPath)) {
    throw new Error(`workflow.json not found in package "${name}"`);
  }
  const workflow = JSON.parse(fs.readFileSync(workflowPath, "utf-8"));

  const paramsPath = path.join(pkgDir, "params.json");
  if (!fs.existsSync(paramsPath)) {
    throw new Error(`params.json not found in package "${name}"`);
  }
  const meta: WorkflowPackageMeta = JSON.parse(fs.readFileSync(paramsPath, "utf-8"));

  if (!meta.params || typeof meta.params !== "object") {
    throw new Error(`params.json in package "${name}" has no params field`);
  }

  const resolverPath = path.join(pkgDir, "resolver.mjs");
  const hasResolver = fs.existsSync(resolverPath);

  return {
    name,
    workflow,
    meta,
    resolverPath: hasResolver ? resolverPath : undefined,
  };
}
```

- [ ] **Step 3: 패키지 목록 함수 작성**

```typescript
export interface WorkflowPackageSummary {
  name: string;
  description?: string;
  params: Record<string, { type?: string; required?: boolean; description?: string }>;
  hasResolver: boolean;
}

/**
 * workflows/ 디렉토리의 모든 패키지를 요약 목록으로 반환한다.
 */
export function listPackages(workflowsDir: string): WorkflowPackageSummary[] {
  if (!fs.existsSync(workflowsDir)) return [];

  const entries = fs.readdirSync(workflowsDir, { withFileTypes: true });
  const results: WorkflowPackageSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const paramsPath = path.join(workflowsDir, entry.name, "params.json");
    if (!fs.existsSync(paramsPath)) continue;

    try {
      const meta: WorkflowPackageMeta = JSON.parse(fs.readFileSync(paramsPath, "utf-8"));
      const paramSummary: Record<string, { type?: string; required?: boolean; description?: string }> = {};
      for (const [k, v] of Object.entries(meta.params || {})) {
        paramSummary[k] = { type: v.type, required: v.required, description: v.description };
      }
      results.push({
        name: entry.name,
        description: meta.description,
        params: paramSummary,
        hasResolver: fs.existsSync(path.join(workflowsDir, entry.name, "resolver.mjs")),
      });
    } catch {
      // 잘못된 params.json은 건너뜀
    }
  }

  return results;
}
```

- [ ] **Step 4: 기본 리졸버 작성**

```typescript
/**
 * 기본 리졸버: params.json의 node+field 매핑으로 단순 치환.
 */
export function defaultResolve(
  workflow: Record<string, unknown>,
  params: Record<string, unknown>,
  context: ResolverContext
): Record<string, unknown> {
  // context에서 meta를 참조하지 않으므로, 호출 시 클로저로 meta를 바인딩
  // → resolveWorkflow()에서 처리
  return workflow;
}

/**
 * 파라미터 검증 + 기본 리졸버를 결합한 내부 함수.
 * params.json의 매핑을 기반으로 workflow를 패치한다.
 */
function applyDefaultResolve(
  workflow: Record<string, unknown>,
  mcpParams: Record<string, unknown>,
  paramDefs: Record<string, ParamDef>
): Record<string, unknown> {
  for (const [paramName, paramDef] of Object.entries(paramDefs)) {
    const value = mcpParams[paramName] !== undefined
      ? mcpParams[paramName]
      : paramDef.default;

    if (value === undefined && paramDef.required) {
      throw new Error(`Required parameter "${paramName}" not provided`);
    }
    if (value === undefined) continue;

    const node = workflow[paramDef.node] as Record<string, unknown> | undefined;
    if (!node) continue;

    const inputs = node.inputs as Record<string, unknown> | undefined;
    if (!inputs) {
      node.inputs = { [paramDef.field]: value };
    } else {
      inputs[paramDef.field] = value;
    }
  }
  return workflow;
}
```

- [ ] **Step 5: 커스텀 리졸버 로더 + resolveWorkflow 통합 함수 작성**

```typescript
/**
 * 커스텀 리졸버를 dynamic import로 로드한다.
 * Windows 호환을 위해 pathToFileURL 사용, 캐시 버스팅을 위해 mtime 쿼리 추가.
 */
async function loadCustomResolver(resolverPath: string): Promise<ResolverFn> {
  const stat = fs.statSync(resolverPath);
  const url = `${pathToFileURL(resolverPath)}?t=${stat.mtimeMs}`;
  const mod = await import(url);
  if (typeof mod.default !== "function") {
    throw new Error(`resolver.mjs at ${resolverPath} does not export a default function`);
  }
  return mod.default as ResolverFn;
}

/**
 * 워크플로우 패키지를 리졸브한다. (파이프라인 2~3단계)
 * 1. workflow.json을 deep copy
 * 2. 커스텀 리졸버가 있으면 그것을, 없으면 기본 리졸버를 실행
 *
 * 런타임 변환(checkpoint, LoRA 등)은 이 함수 밖에서 실행한다.
 */
export async function resolveWorkflow(
  pkg: WorkflowPackage,
  mcpParams: Record<string, unknown>,
  context: Omit<ResolverContext, "defaultResolve">
): Promise<Record<string, unknown>> {
  // Deep copy workflow
  const workflow = JSON.parse(JSON.stringify(pkg.workflow)) as Record<string, unknown>;

  // Strip top-level _meta if present (legacy compat)
  delete workflow._meta;

  // Build full context with defaultResolve bound to this package's paramDefs
  const fullContext: ResolverContext = {
    ...context,
    defaultResolve: (wf, params) => applyDefaultResolve(wf, params, pkg.meta.params),
  };

  if (pkg.resolverPath) {
    // 커스텀 리졸버
    const customResolve = await loadCustomResolver(pkg.resolverPath);
    return customResolve(workflow, mcpParams, fullContext);
  } else {
    // 기본 리졸버
    return applyDefaultResolve(workflow, mcpParams, pkg.meta.params);
  }
}
```

- [ ] **Step 6: 파라미터 검증 함수 작성**

```typescript
/**
 * MCP에서 전달된 파라미터를 params.json의 type/required 기반으로 검증한다.
 * 알 수 없는 키는 무시한다.
 */
export function validateParams(
  mcpParams: Record<string, unknown>,
  paramDefs: Record<string, ParamDef>
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  for (const [name, def] of Object.entries(paramDefs)) {
    const value = mcpParams[name];
    if (value === undefined) {
      if (def.required && def.default === undefined) {
        errors.push(`Required parameter "${name}" is missing`);
      }
      continue;
    }

    if (def.type) {
      const actualType = Array.isArray(value) ? "array" : typeof value;
      if (def.type === "array" && !Array.isArray(value)) {
        errors.push(`Parameter "${name}" expected array, got ${typeof value}`);
      } else if (def.type !== "array" && actualType !== def.type) {
        errors.push(`Parameter "${name}" expected ${def.type}, got ${actualType}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
```

- [ ] **Step 7: 빌드 확인**

Run: `cd "c:/repository/claude bridge" && npx tsc --noEmit`
Expected: 에러 없음 (또는 기존 에러만)

- [ ] **Step 8: 커밋**

```bash
cd "c:/repository/claude bridge"
git add src/lib/workflow-resolver.ts
git commit -m "feat: workflow-resolver.ts — 패키지 로드/리스팅/기본 리졸버/커스텀 리졸버 로더"
```

---

## Task 2: 기존 워크플로우 마이그레이션 스크립트

기존 7개 플랫 JSON 워크플로우를 패키지 디렉토리 구조로 변환하는 일회성 스크립트를 작성하고 실행한다.

**Files:**
- Create: `scripts/migrate-workflows.mjs` (일회성, 실행 후 삭제 가능)
- Migrate: `data/tools/comfyui/skills/generate-image/workflows/*.json` → `*/workflow.json` + `*/params.json`

- [ ] **Step 1: 마이그레이션 스크립트 작성**

```javascript
// scripts/migrate-workflows.mjs
import fs from "node:fs";
import path from "node:path";

const WORKFLOWS_DIR = "data/tools/comfyui/skills/generate-image/workflows";

// face-crop은 인라인 빌드(faceCrop())이므로 마이그레이션 제외
const SKIP = new Set(["face-crop"]);

// 워크플로우별 features 설정
const FEATURES = {
  "portrait":         { checkpoint_auto: true, lora_injection: true, lora_couple_branches: false, seed_randomize: true, trigger_tags: true },
  "scene":            { checkpoint_auto: true, lora_injection: true, lora_couple_branches: false, seed_randomize: true, trigger_tags: true },
  "scene-real":       { checkpoint_auto: true, lora_injection: true, lora_couple_branches: false, seed_randomize: true, trigger_tags: true },
  "scene-couple":     { checkpoint_auto: true, lora_injection: true, lora_couple_branches: true,  seed_randomize: true, trigger_tags: true },
  "portrait-couple":  { checkpoint_auto: true, lora_injection: true, lora_couple_branches: true,  seed_randomize: true, trigger_tags: true },
  "profile":          { checkpoint_auto: true, lora_injection: true, lora_couple_branches: false, seed_randomize: true, trigger_tags: true },
};

const files = fs.readdirSync(WORKFLOWS_DIR).filter(f => f.endsWith(".json"));

for (const file of files) {
  const name = path.basename(file, ".json");
  if (SKIP.has(name)) {
    console.log(`SKIP: ${name} (인라인 빌드)`);
    continue;
  }

  const filePath = path.join(WORKFLOWS_DIR, file);
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));

  // _meta 추출
  const topMeta = raw._meta || {};
  const paramsDefs = topMeta.params || {};
  const description = topMeta.description || "";
  const outputs = topMeta.outputs || {};

  // workflow.json: _meta.params와 최상위 _meta 제거, 노드별 _meta는 유지
  const workflow = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "_meta") continue;
    workflow[key] = value;
  }

  // params.json 구성
  const params = {};
  for (const [pName, pDef] of Object.entries(paramsDefs)) {
    params[pName] = {
      node: pDef.node,
      field: pDef.field,
      type: typeof pDef.default === "number" ? "number" : "string",
      ...(pDef.required ? { required: true } : {}),
      ...(pDef.default !== undefined ? { default: pDef.default } : {}),
    };
  }

  const paramsMeta = {
    description,
    features: FEATURES[name] || { checkpoint_auto: true, lora_injection: true, seed_randomize: true, trigger_tags: true },
    ...(Object.keys(outputs).length > 0 ? { outputs } : {}),
    params,
  };

  // 디렉토리 생성
  const pkgDir = path.join(WORKFLOWS_DIR, name);
  fs.mkdirSync(pkgDir, { recursive: true });

  // 파일 작성
  fs.writeFileSync(path.join(pkgDir, "workflow.json"), JSON.stringify(workflow, null, 2) + "\n");
  fs.writeFileSync(path.join(pkgDir, "params.json"), JSON.stringify(paramsMeta, null, 2) + "\n");

  // 원본 삭제
  fs.unlinkSync(filePath);

  console.log(`OK: ${name} → ${name}/workflow.json + ${name}/params.json`);
}

// face-crop.json도 삭제 (faceCrop()가 인라인으로 처리)
const faceCropPath = path.join(WORKFLOWS_DIR, "face-crop.json");
if (fs.existsSync(faceCropPath)) {
  fs.unlinkSync(faceCropPath);
  console.log("DELETED: face-crop.json (인라인 faceCrop() 사용)");
}

console.log("\nMigration complete.");
```

- [ ] **Step 2: 스크립트 실행**

Run: `cd "c:/repository/claude bridge" && node scripts/migrate-workflows.mjs`
Expected: 각 워크플로우에 대해 `OK: {name} → {name}/...` 출력

- [ ] **Step 3: 결과 확인**

Run: `ls "c:/repository/claude bridge/data/tools/comfyui/skills/generate-image/workflows/"`
Expected: `portrait/`, `scene/`, `scene-real/`, `scene-couple/`, `profile/`, `portrait-couple/` 디렉토리만 존재, 플랫 JSON 파일 없음

Run: `ls "c:/repository/claude bridge/data/tools/comfyui/skills/generate-image/workflows/portrait/"`
Expected: `workflow.json`, `params.json`

- [ ] **Step 4: 스크립트 삭제 + 커밋**

```bash
cd "c:/repository/claude bridge"
rm scripts/migrate-workflows.mjs
git add -A data/tools/comfyui/skills/generate-image/workflows/
git commit -m "refactor: 기존 워크플로우 7개를 패키지 디렉토리 구조로 마이그레이션"
```

---

## Task 3: buildPrompt() 리팩터 — 5단계 파이프라인

기존 `buildPrompt()`를 새 패키지 구조 + 리졸버 체인 + features 기반 런타임 변환으로 리팩터한다.

**Files:**
- Modify: `src/lib/comfyui-client.ts:49-59` (WorkflowMeta 인터페이스)
- Modify: `src/lib/comfyui-client.ts:597-860` (buildPrompt 메서드)

- [ ] **Step 1: import 추가**

`src/lib/comfyui-client.ts` 상단에 추가:

```typescript
import {
  loadPackage,
  resolveWorkflow,
  validateParams,
  type WorkflowPackage,
  type WorkflowFeatures,
} from "./workflow-resolver";
```

- [ ] **Step 2: buildPrompt() 시그니처는 유지, 내부 로직을 패키지 기반으로 교체**

기존 `buildPrompt()` 메서드 (라인 597~860) 전체를 교체한다.

```typescript
  async buildPrompt(
    workflowName: string,
    params: Record<string, unknown>,
    sessionDir?: string,
    loras?: Array<{ name: string; strength: number }>,
    lorasLeft?: Array<{ name: string; strength: number }>,
    lorasRight?: Array<{ name: string; strength: number }>
  ): Promise<object> {
    // === Phase 1: 패키지 로드 ===
    const pkg = loadPackage(this.workflowsDir, workflowName);
    const features = pkg.meta.features || {
      checkpoint_auto: true,
      lora_injection: true,
      lora_couple_branches: false,
      seed_randomize: true,
      trigger_tags: true,
    };

    // === Phase 2: 파라미터 검증 ===
    const validation = validateParams(params, pkg.meta.params);
    if (!validation.valid) {
      throw new Error(`Parameter validation failed: ${validation.errors.join("; ")}`);
    }

    // === Phase 3: 리졸버 (파라미터 치환) ===
    const models = await this.getAvailableModels();
    const prompt = await resolveWorkflow(pkg, params, {
      sessionDir,
      config: sessionDir ? this.readDirConfig(sessionDir) as Record<string, unknown> : undefined,
      models,
    });

    // === Phase 4: 런타임 변환 (features 플래그에 따라 선택 실행) ===

    // 4a: checkpoint_auto
    if (features.checkpoint_auto) {
      const resolvedCkpt = this.resolveCheckpoint(models.checkpoints, sessionDir);
      for (const node of Object.values(prompt)) {
        const n = node as Record<string, unknown>;
        if (n.class_type === "CheckpointLoaderSimple") {
          const inputs = n.inputs as Record<string, unknown>;
          if (inputs) inputs.ckpt_name = resolvedCkpt;
        }
      }
    }

    // 4b: lora_injection (base LoRAs + dynamic LoRAs + pruning)
    if (features.lora_injection) {
      // Base LoRA injection from config
      if (sessionDir) {
        const dirConfig = this.readDirConfig(sessionDir);
        if (dirConfig.baseLoras && dirConfig.baseLoras.length > 0) {
          this.injectBaseLoRAs(prompt, dirConfig.baseLoras);
        }
      }

      // Prune unavailable LoRAs
      this.pruneUnavailableLoRAs(prompt, models.loras);

      // Dynamic LoRA override/injection
      if (loras && loras.length > 0) {
        this.applyDynamicLoRAs(prompt, loras, models.loras);
      }
    }

    // 4c: lora_couple_branches
    if (features.lora_couple_branches && (lorasLeft?.length || lorasRight?.length)) {
      this.injectCoupleBranchLoras(prompt, models.loras, lorasLeft, lorasRight);
    }

    // 4d: trigger_tags
    if (features.trigger_tags) {
      const triggerTable = this.loadLoraTriggers();
      const activeLoRAs = this.collectActiveLoRAs(prompt);
      this.injectTriggerTags(prompt, pkg.meta, triggerTable, activeLoRAs);
    }

    // 4e: seed_randomize
    if (features.seed_randomize) {
      for (const [, paramDef] of Object.entries(pkg.meta.params)) {
        if (paramDef.field === "seed") {
          const node = prompt[paramDef.node] as Record<string, unknown> | undefined;
          if (!node) continue;
          const inputs = node.inputs as Record<string, unknown>;
          if (inputs && inputs.seed === -1) {
            inputs.seed = Math.floor(Math.random() * 2 ** 32);
          }
        }
      }
    }

    return prompt;
  }
```

- [ ] **Step 3: base LoRA 주입 로직을 private 메서드로 추출**

기존 `buildPrompt()` 내 base LoRA 주입 코드(라인 641~683)를 별도 메서드로 분리:

```typescript
  /** Inject base LoRAs from comfyui-config into the workflow */
  private injectBaseLoRAs(
    prompt: Record<string, unknown>,
    baseLoras: Array<{ name: string; strength: number }>
  ): void {
    const ckptId = Object.entries(prompt)
      .find(([, n]) => (n as Record<string, unknown>).class_type === "CheckpointLoaderSimple")
      ?.[0];
    if (!ckptId) return;

    let prevId = ckptId;
    const baseStartId = 100;
    for (let i = 0; i < baseLoras.length; i++) {
      const bl = baseLoras[i];
      const nodeId = String(baseStartId + i);
      prompt[nodeId] = {
        class_type: "LoraLoader",
        inputs: {
          lora_name: bl.name,
          strength_model: bl.strength,
          strength_clip: bl.strength,
          model: [prevId, 0],
          clip: [prevId, 1],
        },
        _meta: { title: `base-lora-${i}` },
      };
      prevId = nodeId;
    }
    // Rewire downstream nodes that reference the checkpoint
    const lastBaseId = String(baseStartId + baseLoras.length - 1);
    for (const [id, node] of Object.entries(prompt)) {
      if (id === ckptId || id.startsWith(String(baseStartId))) continue;
      const n = node as Record<string, unknown>;
      const inputs = n.inputs as Record<string, unknown> | undefined;
      if (!inputs) continue;
      for (const [field, val] of Object.entries(inputs)) {
        if (Array.isArray(val) && val[0] === ckptId && (val[1] === 0 || val[1] === 1)) {
          inputs[field] = [lastBaseId, val[1]];
        }
      }
    }
    console.log(`[comfyui] Injected ${baseLoras.length} base LoRAs from config`);
  }
```

- [ ] **Step 4: dynamic LoRA 로직을 private 메서드로 추출**

기존 `buildPrompt()` 내 dynamic LoRA 코드(라인 689~813)를 별도 메서드로 분리:

```typescript
  /** Apply dynamic LoRA overrides and injections */
  private applyDynamicLoRAs(
    prompt: Record<string, unknown>,
    loras: Array<{ name: string; strength: number }>,
    availableLoRAs: string[]
  ): void {
    // 기존 코드 그대로 — Phase 1 (override/remove) + Phase 2 (dynamic injection)
    // 라인 690~813의 코드를 이 메서드 본문으로 이동
    const loraByName = new Map(loras.map(l => [l.name, l]));

    // Phase 1: Override/remove existing base LoRAs
    const baseLoraNodes: Array<{ id: string; loraName: string }> = [];
    for (const [id, node] of Object.entries(prompt)) {
      const n = node as Record<string, unknown>;
      if (n.class_type === "LoraLoader") {
        const inputs = n.inputs as Record<string, unknown>;
        baseLoraNodes.push({ id, loraName: inputs.lora_name as string });
      }
    }

    const overridden = new Set<string>();
    for (const base of baseLoraNodes) {
      const override = loraByName.get(base.loraName);
      if (!override) continue;
      overridden.add(base.loraName);

      if (override.strength === 0) {
        const node = prompt[base.id] as Record<string, unknown>;
        const inputs = node.inputs as Record<string, unknown>;
        const modelSource = inputs.model as [string, number] | undefined;
        const sourceId = modelSource ? modelSource[0] : null;
        delete prompt[base.id];
        if (sourceId) {
          for (const [, n] of Object.entries(prompt)) {
            const ni = (n as Record<string, unknown>).inputs as Record<string, unknown> | undefined;
            if (!ni) continue;
            for (const [key, value] of Object.entries(ni)) {
              if (Array.isArray(value) && value.length === 2 && value[0] === base.id) {
                ni[key] = [sourceId, value[1]];
              }
            }
          }
        }
        console.log(`[comfyui] Removed base LoRA: ${base.loraName} (node ${base.id})`);
      } else {
        const node = prompt[base.id] as Record<string, unknown>;
        const inputs = node.inputs as Record<string, unknown>;
        inputs.strength_model = override.strength;
        inputs.strength_clip = override.strength;
        console.log(`[comfyui] Override base LoRA: ${base.loraName} strength → ${override.strength}`);
      }
    }

    // Phase 2: Dynamic injection of non-base LoRAs
    const newLoras = loras.filter(l => !overridden.has(l.name) && l.strength !== 0);
    const validNewLoras = availableLoRAs.length === 0
      ? newLoras
      : newLoras.filter(l => availableLoRAs.includes(l.name));

    if (validNewLoras.length > 0) {
      const remainingLoraIds = Object.entries(prompt)
        .filter(([, n]) => (n as Record<string, unknown>).class_type === "LoraLoader")
        .map(([id]) => id)
        .sort((a, b) => Number(a) - Number(b));

      let anchorId = remainingLoraIds.length > 0 ? remainingLoraIds[remainingLoraIds.length - 1] : null;
      if (!anchorId) {
        anchorId = Object.entries(prompt)
          .find(([, n]) => (n as Record<string, unknown>).class_type === "CheckpointLoaderSimple")
          ?.[0] ?? null;
      }

      if (anchorId) {
        let prevId = anchorId;
        const maxExistingId = Math.max(...Object.keys(prompt).map(Number).filter(n => !isNaN(n)));
        const dynamicStartId = Math.max(200, maxExistingId + 1);
        const injectedIds = new Set<string>();

        for (let i = 0; i < validNewLoras.length; i++) {
          const nodeId = String(dynamicStartId + i);
          injectedIds.add(nodeId);
          prompt[nodeId] = {
            class_type: "LoraLoader",
            inputs: {
              lora_name: validNewLoras[i].name,
              strength_model: validNewLoras[i].strength,
              strength_clip: validNewLoras[i].strength,
              model: [prevId, 0],
              clip: [prevId, 1],
            },
            _meta: { title: `dynamic-lora-${i}` },
          };
          prevId = nodeId;
        }

        const newLastId = prevId;
        for (const [nodeId, node] of Object.entries(prompt)) {
          if (injectedIds.has(nodeId)) continue;
          const n = node as Record<string, unknown>;
          const inputs = n.inputs as Record<string, unknown> | undefined;
          if (!inputs) continue;
          for (const [key, value] of Object.entries(inputs)) {
            if (Array.isArray(value) && value.length === 2 && value[0] === anchorId && (value[1] === 0 || value[1] === 1)) {
              inputs[key] = [newLastId, value[1]];
            }
          }
        }
        console.log(`[comfyui] Injected ${validNewLoras.length} dynamic LoRAs after node ${anchorId}`);
      } else {
        console.warn(`[comfyui] No LoraLoader or Checkpoint nodes — cannot inject dynamic LoRAs`);
      }
    }

    const skippedCount = newLoras.length - validNewLoras.length;
    if (skippedCount > 0) {
      const skippedNames = newLoras
        .filter(l => !validNewLoras.some(v => v.name === l.name))
        .map(l => l.name);
      console.log(`[comfyui] Skipped ${skippedCount} unavailable dynamic LoRAs: ${skippedNames.join(", ")}`);
    }
  }
```

- [ ] **Step 5: injectTriggerTags의 meta 파라미터 타입 수정**

`injectTriggerTags`가 기존 `WorkflowMeta` 타입을 받는데, 이제 `WorkflowPackageMeta`를 받도록 수정해야 한다. 메서드 시그니처에서 meta의 타입을 확인하고, `meta.params`를 참조하는 부분이 호환되는지 확인한다. `WorkflowPackageMeta.params`는 `ParamDef` (node, field 필드 포함)이므로 기존 `WorkflowMeta`와 호환된다.

기존 `WorkflowMeta` 인터페이스(라인 49-59)는 삭제하거나 `WorkflowPackageMeta`를 사용하도록 변경:

```typescript
// 기존 WorkflowMeta 인터페이스를 삭제하고 workflow-resolver.ts에서 import한 타입 사용
// import 시 WorkflowPackageMeta를 사용
```

- [ ] **Step 6: 빌드 확인**

Run: `cd "c:/repository/claude bridge" && npx tsc --noEmit`
Expected: 에러 없음

- [ ] **Step 7: 커밋**

```bash
cd "c:/repository/claude bridge"
git add src/lib/comfyui-client.ts src/lib/workflow-resolver.ts
git commit -m "refactor: buildPrompt()를 5단계 파이프라인으로 리팩터 (패키지 로드 → 검증 → 리졸버 → 런타임 변환 → 제출)"
```

---

## Task 4: MCP 도구 — comfyui_workflow 등록

MCP 서버에 `comfyui_workflow` CRUD 도구를 추가하고, 기존 `comfyui_generate`와 `generate_image`의 template enum을 제거한다.

**Files:**
- Modify: `src/mcp/claude-play-mcp-server.mjs:388-486` (comfyui_generate)
- Modify: `src/mcp/claude-play-mcp-server.mjs:524-657` (generate_image)

- [ ] **Step 1: 워크플로우 디렉토리 경로 상수 추가**

MCP 서버 파일 상단(기존 상수들 근처)에 추가:

```javascript
// Workflow packages directory
const WORKFLOWS_DIR = path.join(sessionDir, "..", "..", "tools", "comfyui", "skills", "generate-image", "workflows");
```

- [ ] **Step 2: comfyui_workflow 도구 등록**

`comfyui_models` 도구 등록 바로 뒤(라인 386 근처)에 추가:

```javascript
server.registerTool(
  "comfyui_workflow",
  {
    description:
      "Manage ComfyUI workflow packages (list/get/save/delete). Each package contains workflow.json + params.json + optional resolver.mjs. See manage-workflows skill for detailed usage guide.",
    inputSchema: {
      action: z.enum(["list", "get", "save", "delete"]),
      name: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional(),
      workflow: z.record(z.string(), z.unknown()).optional(),
      params: z.record(z.string(), z.unknown()).optional(),
      resolver: z.string().nullable().optional(),
    },
  },
  async (input) => {
    try {
      const action = input.action;

      if (action === "list") {
        const entries = fs.readdirSync(WORKFLOWS_DIR, { withFileTypes: true })
          .filter(e => e.isDirectory());
        const results = [];
        for (const entry of entries) {
          const paramsPath = path.join(WORKFLOWS_DIR, entry.name, "params.json");
          if (!fs.existsSync(paramsPath)) continue;
          try {
            const meta = JSON.parse(fs.readFileSync(paramsPath, "utf-8"));
            const paramSummary = {};
            for (const [k, v] of Object.entries(meta.params || {})) {
              paramSummary[k] = { type: v.type, required: v.required, description: v.description };
            }
            results.push({
              name: entry.name,
              description: meta.description || null,
              params: paramSummary,
              hasResolver: fs.existsSync(path.join(WORKFLOWS_DIR, entry.name, "resolver.mjs")),
            });
          } catch { /* skip malformed */ }
        }
        return ok(results);
      }

      if (!input.name) throw new Error("name is required for get/save/delete actions");

      if (action === "get") {
        const pkgDir = path.join(WORKFLOWS_DIR, input.name);
        if (!fs.existsSync(pkgDir)) throw new Error(`Package "${input.name}" not found`);
        const workflowPath = path.join(pkgDir, "workflow.json");
        const paramsPath = path.join(pkgDir, "params.json");
        const resolverPath = path.join(pkgDir, "resolver.mjs");
        const result = {
          name: input.name,
          workflow: fs.existsSync(workflowPath) ? JSON.parse(fs.readFileSync(workflowPath, "utf-8")) : null,
          params: fs.existsSync(paramsPath) ? JSON.parse(fs.readFileSync(paramsPath, "utf-8")) : null,
          resolver: fs.existsSync(resolverPath) ? fs.readFileSync(resolverPath, "utf-8") : null,
        };
        return ok(result);
      }

      if (action === "save") {
        if (!input.workflow || !input.params) {
          throw new Error("save requires both workflow and params");
        }
        const pkgDir = path.join(WORKFLOWS_DIR, input.name);
        // Atomic write: write to temp dir, then rename
        const tmpDir = pkgDir + `._tmp_${Date.now()}`;
        fs.mkdirSync(tmpDir, { recursive: true });
        try {
          fs.writeFileSync(path.join(tmpDir, "workflow.json"), JSON.stringify(input.workflow, null, 2) + "\n");
          fs.writeFileSync(path.join(tmpDir, "params.json"), JSON.stringify(input.params, null, 2) + "\n");

          if (typeof input.resolver === "string") {
            fs.writeFileSync(path.join(tmpDir, "resolver.mjs"), input.resolver);
          } else if (input.resolver === null) {
            // null means explicitly delete resolver
          } else if (input.resolver === undefined && fs.existsSync(path.join(pkgDir, "resolver.mjs"))) {
            // undefined means keep existing resolver
            fs.copyFileSync(path.join(pkgDir, "resolver.mjs"), path.join(tmpDir, "resolver.mjs"));
          }

          // Replace old package dir
          if (fs.existsSync(pkgDir)) {
            fs.rmSync(pkgDir, { recursive: true });
          }
          fs.renameSync(tmpDir, pkgDir);

          return ok({ saved: input.name, files: fs.readdirSync(pkgDir) });
        } catch (err) {
          // Cleanup temp dir on failure
          try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
          throw err;
        }
      }

      if (action === "delete") {
        const pkgDir = path.join(WORKFLOWS_DIR, input.name);
        if (!fs.existsSync(pkgDir)) throw new Error(`Package "${input.name}" not found`);
        fs.rmSync(pkgDir, { recursive: true });
        return ok({ deleted: input.name });
      }

      throw new Error(`Unknown action: ${action}`);
    } catch (error) {
      return fail(error);
    }
  }
);
```

- [ ] **Step 3: comfyui_generate에서 template enum 제거**

기존 (라인 395):
```javascript
template: z.enum(["portrait", "scene", "scene-real", "scene-couple", "profile"]).optional(),
```
변경:
```javascript
template: z.string().optional(),
```

- [ ] **Step 4: generate_image에서 template enum 제거**

기존 (라인 530):
```javascript
template: z.enum(["portrait", "scene", "scene-real", "scene-couple", "profile"]).optional(),
```
변경:
```javascript
template: z.string().optional(),
```

- [ ] **Step 5: 빌드 확인**

Run: `cd "c:/repository/claude bridge" && npx tsc --noEmit`
Expected: 에러 없음

- [ ] **Step 6: 커밋**

```bash
cd "c:/repository/claude bridge"
git add src/mcp/claude-play-mcp-server.mjs
git commit -m "feat: comfyui_workflow MCP 도구 추가 (list/get/save/delete) + template enum 제거"
```

---

## Task 5: 사용 스킬 문서 작성

AI가 `comfyui_workflow` 도구를 올바르게 사용하기 위한 SKILL.md를 작성한다.

**Files:**
- Create: `data/tools/comfyui/skills/manage-workflows/SKILL.md`

- [ ] **Step 1: SKILL.md 작성**

```markdown
---
name: manage-workflows
description: ComfyUI 워크플로우 패키지를 관리할 때 사용한다 (새 워크플로우 등록, 기존 워크플로우 수정/조회/삭제).
allowed-tools: Read
---

# ComfyUI 워크플로우 패키지 관리

## 개요

`comfyui_workflow` 도구로 워크플로우 패키지를 CRUD한다. 각 패키지는 `workflow.json` + `params.json` + 선택적 `resolver.mjs`로 구성된다.

## Action별 사용법

### list — 패키지 목록 조회

```json
{ "action": "list" }
```

반환: 각 패키지의 name, description, 파라미터 요약, resolver 존재 여부

### get — 패키지 상세 조회

```json
{ "action": "get", "name": "portrait" }
```

반환: workflow.json 전체, params.json 전체, resolver.mjs 소스코드 (있으면)

### save — 패키지 생성/수정

```json
{
  "action": "save",
  "name": "my-workflow",
  "workflow": { "1": { "class_type": "...", "inputs": {...} }, ... },
  "params": {
    "description": "워크플로우 설명",
    "features": {
      "checkpoint_auto": true,
      "lora_injection": true,
      "lora_couple_branches": false,
      "seed_randomize": true,
      "trigger_tags": true
    },
    "params": {
      "prompt": { "node": "2", "field": "text", "type": "string", "required": true, "description": "생성 프롬프트" },
      "seed": { "node": "5", "field": "seed", "type": "number", "default": -1 }
    }
  }
}
```

- `name`: 영문, 숫자, 하이픈, 언더스코어만 허용
- `resolver`: 문자열이면 resolver.mjs로 저장, `null`이면 기존 resolver 삭제, 생략하면 기존 유지

### delete — 패키지 삭제

```json
{ "action": "delete", "name": "my-workflow" }
```

## 새 워크플로우 등록 가이드

사용자가 ComfyUI API format JSON을 제공하면:

1. JSON의 노드 구조를 분석하여 주요 입력 파라미터를 식별한다
2. `params.json`의 `params` 필드에 각 파라미터의 `node`, `field`, `type`, `required`, `default`, `description`을 매핑한다
3. `features` 플래그를 설정한다:
   - `checkpoint_auto`: CheckpointLoaderSimple 노드가 있으면 `true`
   - `lora_injection`: LoRA를 동적으로 주입/교체하려면 `true`
   - `lora_couple_branches`: Attention Couple 좌/우 분리 워크플로우면 `true`
   - `seed_randomize`: 시드 파라미터가 있으면 `true`
   - `trigger_tags`: LoRA 트리거 태그 자동 삽입이 필요하면 `true`
4. `save` action으로 저장한다
5. `comfyui_generate`에서 `workflow: "my-workflow"`로 사용한다

## resolver.mjs 작성 가이드

기본 리졸버(params.json의 node+field 매핑)로 충분하지 않을 때만 작성한다.

```javascript
export default function resolve(workflow, params, context) {
  // context.defaultResolve — 기본 매핑을 먼저 적용하고 싶을 때
  const patched = context.defaultResolve(workflow, params, context);

  // context.sessionDir — 세션 디렉토리 경로
  // context.config — comfyui-config.json 내용
  // context.models — { checkpoints: [...], loras: [...] }

  // 커스텀 로직...
  return patched;
}
```

resolver에서 에러가 발생하면 이미지 생성 자체가 실패한다 (폴백 없음).

## features 플래그 상세

| 플래그 | 설명 | 해당 런타임 변환 |
|--------|------|-----------------|
| `checkpoint_auto` | CheckpointLoaderSimple의 ckpt_name을 사용 가능한 모델로 자동 교체 | 체크포인트 없는 워크플로우(후처리 등)는 false |
| `lora_injection` | base LoRA 주입 + 동적 LoRA override/injection + 프루닝 | LoRA를 쓰지 않는 워크플로우는 false |
| `lora_couple_branches` | scene-couple용 좌/우 CLIP 브랜치 LoRA 주입 | Attention Couple 워크플로우에서만 true |
| `seed_randomize` | seed=-1이면 랜덤 값으로 교체 | 시드 파라미터가 없으면 false |
| `trigger_tags` | 활성 LoRA의 트리거 태그를 프롬프트에 삽입 | LoRA trigger 자동 삽입이 불필요하면 false |
```

- [ ] **Step 2: 커밋**

```bash
cd "c:/repository/claude bridge"
git add data/tools/comfyui/skills/manage-workflows/SKILL.md
git commit -m "docs: manage-workflows SKILL.md — comfyui_workflow 도구 사용 가이드"
```

---

## Task 6: generate-image SKILL.md 업데이트

기존 이미지 생성 스킬 문서에서 template 관련 하드코딩 부분을 동적 패키지 참조로 수정한다.

**Files:**
- Modify: `data/tools/comfyui/skills/generate-image/SKILL.md`

- [ ] **Step 1: SKILL.md 읽기 및 수정 대상 파악**

SKILL.md를 전체 읽어서 template enum을 언급하는 부분, 워크플로우 목록을 하드코딩한 부분을 찾는다.

- [ ] **Step 2: 하드코딩된 template 목록을 동적 안내로 수정**

기존에 `portrait`, `scene`, `scene-real`, `scene-couple`, `profile` 등을 나열한 부분을:
- "`comfyui_workflow` 도구의 `list` action으로 사용 가능한 워크플로우를 확인하라" 안내로 변경
- 기본 내장 워크플로우 목록은 예시로 유지하되 "이 외에도 커스텀 워크플로우가 있을 수 있다" 명시

- [ ] **Step 3: 커밋**

```bash
cd "c:/repository/claude bridge"
git add data/tools/comfyui/skills/generate-image/SKILL.md
git commit -m "docs: generate-image SKILL.md — 동적 워크플로우 패키지 안내 추가"
```

---

## Task 7: 통합 테스트 — dev 서버에서 동작 확인

마이그레이션된 패키지 구조 + 리팩터된 buildPrompt() + 새 MCP 도구가 실제로 동작하는지 확인한다.

**Files:** (수정 없음, 테스트만)

- [ ] **Step 1: dev 서버 시작**

Run: `cd "c:/repository/claude bridge" && npm run dev`

- [ ] **Step 2: 워크플로우 리스트 확인**

ComfyUI가 연결되어 있지 않아도, MCP 도구의 list action은 파일시스템만 읽으므로 동작해야 한다.
워크플로우 목록에 portrait, scene, scene-real, scene-couple, portrait-couple, profile이 모두 나오는지 확인.

- [ ] **Step 3: 워크플로우 get 확인**

portrait 패키지의 workflow.json, params.json 내용이 올바르게 반환되는지 확인.

- [ ] **Step 4: 워크플로우 save/delete 확인**

테스트용 패키지를 생성하고 삭제하여 CRUD가 정상 동작하는지 확인.

- [ ] **Step 5: 빌드 확인**

Run: `cd "c:/repository/claude bridge" && npm run build`
Expected: 빌드 성공

- [ ] **Step 6: 최종 커밋 (필요 시)**

빌드나 테스트 중 발견된 수정사항이 있으면 커밋.
