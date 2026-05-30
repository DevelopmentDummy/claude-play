// 순수 ComfyUI prompt-그래프 수술 헬퍼. ComfyUIClient에서 추출(Wave 6 Slice 1). this/fs/network 무의존.

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
