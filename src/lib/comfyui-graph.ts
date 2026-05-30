// 순수 ComfyUI prompt-그래프 수술 헬퍼. ComfyUIClient에서 추출(Wave 6 Slice 1). this/fs/network 무의존.

import type { WorkflowPackageMeta, DetailerChainConfig } from "./workflow-resolver";

export interface DetailerModuleTemplate {
  id_prefix: number;
  nodes: Record<string, {
    class_type: string;
    inputs: Record<string, unknown>;
    _meta?: { title: string };
  }>;
  use_main_prompt: boolean;
  internal_wiring: Record<string, unknown>;
}

export interface LoraChainEndpoint {
  nodeId: string;
  outputIndex: number;
}

export interface LoraInjectionAnchors {
  model: LoraChainEndpoint;
  clip: LoraChainEndpoint;
}

/**
 * Remove unavailable LoRA nodes from the workflow and rewire the chain.
 * LoRA nodes form a chain: each takes model/clip from the previous and passes to the next.
 * When a node is removed, downstream references must be rewired to the previous surviving node.
 */
export function pruneUnavailableLoRAs(
  prompt: Record<string, unknown>,
  availableLoRAs: string[]
): void {
  if (availableLoRAs.length === 0) return; // Can't validate, skip

  const loraSet = new Set(availableLoRAs);

  // Find all LoraLoader nodes
  const loraNodes: Array<{ id: string; loraName: string }> = [];
  for (const [id, node] of Object.entries(prompt)) {
    const n = node as Record<string, unknown>;
    if (n.class_type === "LoraLoader") {
      const inputs = n.inputs as Record<string, unknown>;
      loraNodes.push({ id, loraName: inputs.lora_name as string });
    }
  }

  // Find unavailable ones
  const toRemove = new Set<string>();
  for (const ln of loraNodes) {
    if (!loraSet.has(ln.loraName)) {
      toRemove.add(ln.id);
      console.log(`[comfyui] Skipping unavailable LoRA: ${ln.loraName} (node ${ln.id})`);
    }
  }

  if (toRemove.size === 0) return;

  // Build a redirect map: for each removed node, find where its inputs came from
  // so downstream nodes can be rewired
  const redirectMap = new Map<string, string>(); // removedNodeId → replacement source nodeId

  for (const removedId of toRemove) {
    const node = prompt[removedId] as Record<string, unknown>;
    const inputs = node.inputs as Record<string, unknown>;
    // LoraLoader takes model from [sourceId, 0] — follow the chain back
    const modelSource = inputs.model as [string, number] | undefined;
    if (modelSource) {
      let sourceId = modelSource[0];
      // Follow redirects if the source was also removed
      while (redirectMap.has(sourceId)) {
        sourceId = redirectMap.get(sourceId)!;
      }
      redirectMap.set(removedId, sourceId);
    }
  }

  // Delete removed nodes
  for (const id of toRemove) {
    delete prompt[id];
  }

  // Rewire all remaining nodes: replace references to removed nodes
  for (const [, node] of Object.entries(prompt)) {
    const n = node as Record<string, unknown>;
    const inputs = n.inputs as Record<string, unknown> | undefined;
    if (!inputs) continue;

    for (const [key, value] of Object.entries(inputs)) {
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string") {
        const refId = value[0] as string;
        if (redirectMap.has(refId)) {
          inputs[key] = [redirectMap.get(refId)!, value[1]];
        }
      }
    }
  }

  console.log(`[comfyui] Pruned ${toRemove.size} unavailable LoRA nodes, ${loraNodes.length - toRemove.size} remaining`);
}

/** Collect all active LoRA filenames from the processed workflow */
export function collectActiveLoRAs(prompt: Record<string, unknown>): string[] {
  const names: string[] = [];
  for (const node of Object.values(prompt)) {
    const n = node as Record<string, unknown>;
    if (n.class_type === "LoraLoader") {
      const inputs = n.inputs as Record<string, unknown>;
      if (inputs?.lora_name) {
        names.push(inputs.lora_name as string);
      }
    }
  }
  return names;
}

/** Find the best model/clip anchor pair for injecting additional LoRA nodes. */
export function findLoraInjectionAnchors(prompt: Record<string, unknown>): LoraInjectionAnchors | null {
  const loraIds = Object.entries(prompt)
    .filter(([, n]) => (n as Record<string, unknown>).class_type === "LoraLoader")
    .map(([id]) => id)
    .sort((a, b) => Number(a) - Number(b));

  if (loraIds.length > 0) {
    const lastId = loraIds[loraIds.length - 1];
    return {
      model: { nodeId: lastId, outputIndex: 0 },
      clip: { nodeId: lastId, outputIndex: 1 },
    };
  }

  const checkpointId = Object.entries(prompt)
    .find(([, n]) => (n as Record<string, unknown>).class_type === "CheckpointLoaderSimple")
    ?.[0];
  if (checkpointId) {
    return {
      model: { nodeId: checkpointId, outputIndex: 0 },
      clip: { nodeId: checkpointId, outputIndex: 1 },
    };
  }

  const unetId = Object.entries(prompt)
    .find(([, n]) => (n as Record<string, unknown>).class_type === "UNETLoader")
    ?.[0];
  const CLIP_LOADER_TYPES = ["CLIPLoader", "LoadQwen35AnimaCLIP"];
  const clipId = Object.entries(prompt)
    .find(([, n]) => CLIP_LOADER_TYPES.includes(
      (n as Record<string, unknown>).class_type as string
    ))
    ?.[0];

  if (unetId && clipId) {
    return {
      model: { nodeId: unetId, outputIndex: 0 },
      clip: { nodeId: clipId, outputIndex: 0 },
    };
  }

  return null;
}

/** Append a LoRA chain after the given anchor pair and rewire downstream model/clip references. */
export function appendLoraChain(
  prompt: Record<string, unknown>,
  loras: Array<{ name: string; strength: number }>,
  anchors: LoraInjectionAnchors,
  startIdHint = 200,
  titlePrefix = "dynamic-lora"
): string | null {
  if (loras.length === 0) return null;

  const usedIds = Object.keys(prompt).map(Number).filter(n => !Number.isNaN(n));
  const startId = Math.max(startIdHint, usedIds.length > 0 ? Math.max(...usedIds) + 1 : startIdHint);

  let prevModelRef: [string, number] = [anchors.model.nodeId, anchors.model.outputIndex];
  let prevClipRef: [string, number] = [anchors.clip.nodeId, anchors.clip.outputIndex];
  const injectedIds = new Set<string>();

  for (let i = 0; i < loras.length; i++) {
    const nodeId = String(startId + i);
    injectedIds.add(nodeId);
    prompt[nodeId] = {
      class_type: "LoraLoader",
      inputs: {
        lora_name: loras[i].name,
        strength_model: loras[i].strength,
        strength_clip: loras[i].strength,
        model: prevModelRef,
        clip: prevClipRef,
      },
      _meta: { title: `${titlePrefix}-${i}` },
    };
    prevModelRef = [nodeId, 0];
    prevClipRef = [nodeId, 1];
  }

  const finalNodeId = prevModelRef[0];
  for (const [nodeId, node] of Object.entries(prompt)) {
    if (injectedIds.has(nodeId)) continue;
    const n = node as Record<string, unknown>;
    const inputs = n.inputs as Record<string, unknown> | undefined;
    if (!inputs) continue;

    for (const [key, value] of Object.entries(inputs)) {
      if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "string") continue;
      const [refNodeId, refOutputIndex] = value as [string, number];

      if (refNodeId === anchors.model.nodeId && refOutputIndex === anchors.model.outputIndex) {
        inputs[key] = [finalNodeId, 0];
        continue;
      }

      if (refNodeId === anchors.clip.nodeId && refOutputIndex === anchors.clip.outputIndex) {
        inputs[key] = [finalNodeId, 1];
      }
    }
  }

  return finalNodeId;
}

/** Auto-inject trigger tags for active LoRAs into the prompt text, with deduplication.
 *  Multi-prompt workflows (scene-couple etc.) inject into all prompt_* params. */
export function injectTriggerTags(
  prompt: Record<string, unknown>,
  meta: WorkflowPackageMeta,
  triggerTable: Record<string, string>,
  activeLoRAs: string[]
): void {
  // Collect trigger tags from all active LoRAs (once)
  const triggerTags: string[] = [];
  for (const loraName of activeLoRAs) {
    const triggers = triggerTable[loraName];
    if (triggers && triggers.trim()) {
      for (const tag of triggers.split(",")) {
        const t = tag.trim();
        if (t) triggerTags.push(t);
      }
    }
  }
  if (triggerTags.length === 0) return;

  // Discover all positive-prompt-like params: "prompt", "prompt_left", "prompt_right", ...
  // Negative prompts and non-prompt params are skipped.
  const promptKeys = Object.keys(meta.params).filter(k => k === "prompt" || /^prompt_/.test(k));
  if (promptKeys.length === 0) return;

  let injectedCount = 0;
  for (const key of promptKeys) {
    const promptDef = meta.params[key];
    if (!promptDef?.node || !promptDef?.field) continue;
    const node = prompt[promptDef.node] as Record<string, unknown> | undefined;
    if (!node) continue;
    const inputs = node.inputs as Record<string, unknown> | undefined;
    if (!inputs) continue;

    const currentPrompt = (inputs[promptDef.field] as string) || "";
    const currentLower = currentPrompt.toLowerCase();
    const newTags = triggerTags.filter(tag => !currentLower.includes(tag.toLowerCase()));
    if (newTags.length === 0) continue;
    inputs[promptDef.field] = currentPrompt + ", " + newTags.join(", ");
    injectedCount += newTags.length;
    if (key !== "prompt") {
      console.log(`[comfyui] Auto-injected trigger tags into ${key}: ${newTags.join(", ")}`);
    }
  }
  if (injectedCount === 0) return;
  console.log(`[comfyui] Auto-injected ${injectedCount} trigger tags across ${promptKeys.length} prompt(s)`);
}

/** Inject base LoRAs from comfyui-config into the workflow */
export function injectBaseLoRAs(
  prompt: Record<string, unknown>,
  baseLoras: Array<{ name: string; strength: number }>
): void {
  const anchors = findLoraInjectionAnchors(prompt);
  if (!anchors) {
    console.warn("[comfyui] No checkpoint or split UNET/CLIP loader pair — cannot inject base LoRAs");
    return;
  }

  const finalNodeId = appendLoraChain(prompt, baseLoras, anchors, 100, "base-lora");
  if (finalNodeId) {
    console.log(`[comfyui] Injected ${baseLoras.length} base LoRAs from config`);
  }
}

/** Apply dynamic LoRA overrides and injections */
export function applyDynamicLoRAs(
  prompt: Record<string, unknown>,
  loras: Array<{ name: string; strength: number }>,
  availableLoRAs: string[]
): void {
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
    const anchors = findLoraInjectionAnchors(prompt);
    if (anchors) {
      const finalNodeId = appendLoraChain(prompt, validNewLoras, anchors, 200, "dynamic-lora");
      if (finalNodeId) {
        console.log(
          `[comfyui] Injected ${validNewLoras.length} dynamic LoRAs after model ${anchors.model.nodeId}:${anchors.model.outputIndex} / clip ${anchors.clip.nodeId}:${anchors.clip.outputIndex}`
        );
      }
    } else {
      console.warn("[comfyui] No LoraLoader, checkpoint, or split UNET/CLIP loader pair ? cannot inject dynamic LoRAs");
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

/** Inject per-character CLIP-branch LoRA chains for scene-couple workflow.
 *  Each region (left=node 50, right=node 51) gets its own LoRA chain
 *  branching from the common chain's CLIP output. */
export function injectCoupleBranchLoras(
  prompt: Record<string, unknown>,
  availableLoRAs: string[],
  triggerTable: Record<string, string>,
  lorasLeft?: Array<{ name: string; strength: number }>,
  lorasRight?: Array<{ name: string; strength: number }>
): void {
  const regionNodes = [
    { targetId: "50", loras: lorasLeft,  startId: 400, label: "left" },
    { targetId: "51", loras: lorasRight, startId: 500, label: "right" },
  ];

  for (const { targetId, loras, startId, label } of regionNodes) {
    if (!loras || loras.length === 0) continue;

    const validLoras = availableLoRAs.length === 0
      ? loras.filter(l => l.strength !== 0)
      : loras.filter(l => l.strength !== 0 && availableLoRAs.includes(l.name));

    if (validLoras.length === 0) continue;

    // Find current clip source for this CLIPTextEncode
    const targetNode = prompt[targetId] as Record<string, unknown>;
    if (!targetNode) continue;
    const targetInputs = targetNode.inputs as Record<string, unknown>;
    const clipSource = targetInputs.clip as [string, number];
    const branchAnchorId = clipSource[0];

    // Build LoRA chain: each takes model+clip from previous
    let prevId = branchAnchorId;
    for (let i = 0; i < validLoras.length; i++) {
      const nodeId = String(startId + i);
      prompt[nodeId] = {
        class_type: "LoraLoader",
        inputs: {
          lora_name: validLoras[i].name,
          strength_model: validLoras[i].strength,
          strength_clip: validLoras[i].strength,
          model: [prevId, 0],
          clip: [prevId, 1],
        },
        _meta: { title: `branch-lora-${label}-${i}` },
      };
      prevId = nodeId;
    }

    // Rewire CLIPTextEncode to use branch chain's clip output
    targetInputs.clip = [prevId, 1];

    // Inject trigger tags for branch LoRAs into their region's prompt text
    for (const lora of validLoras) {
      const triggers = triggerTable[lora.name];
      if (!triggers?.trim()) continue;
      const currentText = (targetInputs.text as string) || "";
      const currentLower = currentText.toLowerCase();
      const newTags = triggers.split(",").map((t: string) => t.trim()).filter((t: string) => t && !currentLower.includes(t.toLowerCase()));
      if (newTags.length > 0) {
        targetInputs.text = currentText + ", " + newTags.join(", ");
        console.log(`[comfyui] Auto-injected branch trigger tags (${label}): ${newTags.join(", ")}`);
      }
    }

    console.log(`[comfyui] Injected ${validLoras.length} branch LoRAs for ${label} region`);
  }
}

/** Inject enabled detailer modules between source and sink */
export function processDetailerChain(
  prompt: Record<string, unknown>,
  chainConfig: DetailerChainConfig,
  params: Record<string, unknown>,
  modules: Record<string, DetailerModuleTemplate>,
  paramDefs?: Record<string, { default?: unknown }>
): void {
  // Helper: read param value, falling back to param spec's default (for non-node params
  // like `detailer_face_denoise` that don't appear in workflow nodes).
  const getParam = (key: string): unknown => {
    if (params[key] !== undefined) return params[key];
    return paramDefs?.[key]?.default;
  };
  if (!modules || Object.keys(modules).length === 0) return;

  // Find KSampler and VAEDecode to resolve __sampler__ references
  const samplerEntry = Object.entries(prompt).find(
    ([, v]) => (v as Record<string, unknown>).class_type === "KSampler"
  );
  const vaeDecodeEntry = Object.entries(prompt).find(
    ([, v]) => (v as Record<string, unknown>).class_type === "VAEDecode"
  );

  const samplerInputs = samplerEntry
    ? ((samplerEntry[1] as Record<string, unknown>).inputs as Record<string, unknown>)
    : null;
  const vaeDecodeInputs = vaeDecodeEntry
    ? ((vaeDecodeEntry[1] as Record<string, unknown>).inputs as Record<string, unknown>)
    : null;

  // Resolve CLIP for detailer wiring.
  // Priority: chainConfig.clip_source (explicit override) → KSampler.positive trace → null.
  // Couple-branch workflows (Attention couple, ConditioningCombine) MUST set clip_source
  // because the sampler positive doesn't trace back to a CLIPTextEncode.
  const resolveClip = (): unknown => {
    if (chainConfig.clip_source) {
      return [chainConfig.clip_source.node, chainConfig.clip_source.output];
    }
    const posRef = samplerInputs?.positive as [string, number] | undefined;
    if (posRef) {
      const posNode = prompt[posRef[0]] as Record<string, unknown> | undefined;
      if (posNode) {
        return (posNode.inputs as Record<string, unknown>)?.clip;
      }
    }
    return null;
  };
  // Resolve model for detailer wiring. Default = sampler model. Override via chainConfig.model_source.
  const resolveModel = (): unknown => {
    if (chainConfig.model_source) {
      return [chainConfig.model_source.node, chainConfig.model_source.output];
    }
    return samplerInputs?.model;
  };

  // Determine which modules are enabled (in fixed order)
  const moduleOrder = ["face", "hand", "pussy", "anus"];
  const enabledModules: Array<{ id: string; template: DetailerModuleTemplate }> = [];

  for (const moduleId of moduleOrder) {
    if (!modules[moduleId]) continue;
    const paramKey = `detailer_${moduleId}`;
    if (getParam(paramKey) === false) continue;
    enabledModules.push({ id: moduleId, template: modules[moduleId] });
  }

  // If no modules enabled, source→sink is already connected in base workflow
  if (enabledModules.length === 0) return;

  // Fields on the detailer node that can be overridden per-package via params.
  // Param key format: `detailer_{moduleId}_{field}` (e.g. detailer_face_denoise = 0.25).
  // Only applies to the "detailer" role; detector/pos_prompt/neg_prompt are not affected.
  const OVERRIDABLE_DETAILER_FIELDS = [
    "denoise", "steps", "cfg", "sampler_name", "scheduler",
    "guide_size", "max_size", "feather",
    "bbox_threshold", "bbox_dilation", "bbox_crop_factor",
  ];

  // Inject each enabled module's nodes into the prompt
  for (const { id: moduleId, template } of enabledModules) {
    const prefix = template.id_prefix;

    // Node ID mapping: detector=+0, detailer=+1, pos_prompt=+2, neg_prompt=+3
    const nodeIdMap: Record<string, string> = {
      detector: String(prefix),
      detailer: String(prefix + 1),
      pos_prompt: String(prefix + 2),
      neg_prompt: String(prefix + 3),
    };

    // Create nodes from template
    for (const [role, nodeDef] of Object.entries(template.nodes)) {
      const nodeId = nodeIdMap[role];
      if (!nodeId) continue;
      const inputs: Record<string, unknown> = { ...nodeDef.inputs };
      if (role === "detailer") {
        const appliedOverrides: string[] = [];
        for (const field of OVERRIDABLE_DETAILER_FIELDS) {
          const paramKey = `detailer_${moduleId}_${field}`;
          const override = getParam(paramKey);
          if (override !== undefined && override !== null) {
            inputs[field] = override;
            appliedOverrides.push(`${field}=${override}`);
          }
        }
        if (appliedOverrides.length > 0) {
          console.log(`[comfyui] Detailer override ${moduleId}: ${appliedOverrides.join(", ")}`);
        }
      }
      prompt[nodeId] = {
        class_type: nodeDef.class_type,
        inputs,
        _meta: nodeDef._meta,
      };
    }

    // Wire internal connections
    for (const [wirePath, ref] of Object.entries(template.internal_wiring)) {
      const [targetRole, field] = wirePath.split(".");
      const targetId = nodeIdMap[targetRole];
      const targetNode = prompt[targetId] as Record<string, unknown> | undefined;
      if (!targetNode) continue;
      const targetInputs = targetNode.inputs as Record<string, unknown>;

      if (ref === "__clip__") {
        targetInputs[field] = resolveClip();
      } else if (Array.isArray(ref)) {
        const [refRole, refOutput] = ref as [string, number];
        targetInputs[field] = [nodeIdMap[refRole], refOutput];
      }
    }

    // Wire external connections: model, clip, vae, positive, negative
    const detailerId = nodeIdMap.detailer;
    const detailerInputs = (prompt[detailerId] as Record<string, unknown>).inputs as Record<string, unknown>;

    detailerInputs.model = resolveModel();
    detailerInputs.clip = resolveClip();
    detailerInputs.vae = vaeDecodeInputs?.vae;

    if (template.use_main_prompt) {
      detailerInputs.positive = samplerInputs?.positive;
      detailerInputs.negative = samplerInputs?.negative;
    }
    // Non-main-prompt modules already have pos/neg wired via internal_wiring
  }

  // Chain the enabled modules: source → first → ... → last → sink
  const firstDetailerId = String(enabledModules[0].template.id_prefix + 1);
  const firstDetailerInputs = (prompt[firstDetailerId] as Record<string, unknown>).inputs as Record<string, unknown>;
  firstDetailerInputs.image = [chainConfig.source.node, chainConfig.source.output];

  for (let i = 1; i < enabledModules.length; i++) {
    const prevId = String(enabledModules[i - 1].template.id_prefix + 1);
    const currId = String(enabledModules[i].template.id_prefix + 1);
    const currInputs = (prompt[currId] as Record<string, unknown>).inputs as Record<string, unknown>;
    currInputs.image = [prevId, 0];
  }

  const lastDetailerId = String(enabledModules[enabledModules.length - 1].template.id_prefix + 1);
  const sinkNode = prompt[chainConfig.sink.node] as Record<string, unknown> | undefined;
  if (sinkNode) {
    const sinkInputs = sinkNode.inputs as Record<string, unknown>;
    sinkInputs[chainConfig.sink.field] = [lastDetailerId, 0];
  }
}
