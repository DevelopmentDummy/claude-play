// 순수 ComfyUI prompt-그래프 수술 헬퍼. ComfyUIClient에서 추출(Wave 6 Slice 1). this/fs/network 무의존.

import type { WorkflowPackageMeta } from "./workflow-resolver";

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
