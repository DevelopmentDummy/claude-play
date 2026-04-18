import * as fs from "fs";
import * as path from "path";
import {
  loadPackage,
  resolveWorkflow,
  validateParams,
  type WorkflowPackageMeta,
  type WorkflowFeatures,
  type DetailerChainConfig,
} from "./workflow-resolver";

/** Sanitize a relative file path: preserve subdirectories but prevent traversal */
function safePath(filePath: string): string {
  const normalized = path.posix.normalize(filePath.replace(/\\/g, "/"));
  const segments = normalized.split("/").filter(s => s && s !== ".." && s !== ".");
  return segments.join("/") || path.basename(filePath);
}

interface ComfyUIConfig {
  host: string;
  port: number;
  checkpoint?: string;
}

interface GenerateRequest {
  workflow: string;
  params: Record<string, unknown>;
  filename: string;
  sessionDir: string;
  /** Map of workflow output prefix → local filename for additional outputs */
  extraFiles?: Record<string, string>;
  loras?: Array<{ name: string; strength: number }>;
  loras_left?: Array<{ name: string; strength: number }>;
  loras_right?: Array<{ name: string; strength: number }>;
}

interface GenerateRawRequest {
  prompt: Record<string, unknown>;
  filename: string;
  sessionDir: string;
  extraFiles?: Record<string, string>;
}

interface GenerateResult {
  success: boolean;
  filepath?: string;
  extraPaths?: Record<string, string>;
  error?: string;
}

interface TranscribeResult {
  success: boolean;
  text?: string;
  error?: string;
}


interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
}

interface QueueSnapshot {
  pendingIds: string[];
  runningIds: string[];
}

interface LoraChainEndpoint {
  nodeId: string;
  outputIndex: number;
}

interface LoraInjectionAnchors {
  model: LoraChainEndpoint;
  clip: LoraChainEndpoint;
}

interface DetailerModuleTemplate {
  id_prefix: number;
  nodes: Record<string, {
    class_type: string;
    inputs: Record<string, unknown>;
    _meta?: { title: string };
  }>;
  use_main_prompt: boolean;
  internal_wiring: Record<string, unknown>;
}

export class ComfyUIClient {
  private config: ComfyUIConfig;
  private workflowsDir: string;
  private availableModelsCache: { checkpoints: string[]; loras: string[] } | null = null;

  constructor(config: ComfyUIConfig, workflowsDir: string) {
    this.config = config;
    this.workflowsDir = workflowsDir;
  }

  private get baseUrl(): string {
    return `http://${this.config.host}:${this.config.port}`;
  }

  private get checkpointName(): string {
    return (
      this.config.checkpoint ||
      process.env.COMFYUI_CHECKPOINT ||
      "model.safetensors"
    );
  }

  private isTransientNetworkError(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const e = err as { code?: string; name?: string; cause?: { code?: string } };
    const code = e.code || e.cause?.code || "";
    if (e.name === "AbortError") return true;
    return [
      "ENOBUFS",
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "EAI_AGAIN",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_SOCKET",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT",
    ].includes(code);
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async fetchWithRetry(
    url: string,
    init: RequestInit = {},
    options: RetryOptions = {}
  ): Promise<Response> {
    const attempts = options.attempts ?? 4;
    const baseDelayMs = options.baseDelayMs ?? 250;
    const timeoutMs = options.timeoutMs ?? 30_000;

    let lastErr: unknown = null;
    for (let i = 0; i < attempts; i++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          ...init,
          signal: controller.signal,
        });
        clearTimeout(timeout);
        return res;
      } catch (err) {
        clearTimeout(timeout);
        lastErr = err;
        const transient = this.isTransientNetworkError(err);
        if (!transient || i === attempts - 1) {
          throw err;
        }
        const jitter = Math.floor(Math.random() * 120);
        const delay = baseDelayMs * Math.pow(2, i) + jitter;
        console.warn(
          `[comfyui] Transient fetch error (${i + 1}/${attempts}) for ${url}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        await this.sleep(delay);
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error("fetchWithRetry failed");
  }

  private extractPromptIds(entries: unknown): string[] {
    if (!Array.isArray(entries)) return [];
    const ids: string[] = [];
    for (const entry of entries) {
      if (typeof entry === "string") {
        ids.push(entry);
        continue;
      }
      if (Array.isArray(entry) && typeof entry[0] === "string") {
        ids.push(entry[0]);
        continue;
      }
      if (entry && typeof entry === "object") {
        const obj = entry as Record<string, unknown>;
        const id = obj.prompt_id || obj.id;
        if (typeof id === "string") ids.push(id);
      }
    }
    return ids;
  }

  async getQueueSnapshot(): Promise<QueueSnapshot | null> {
    try {
      const res = await this.fetchWithRetry(
        `${this.baseUrl}/queue`,
        {},
        { attempts: 3, timeoutMs: 10_000, baseDelayMs: 150 }
      );
      if (!res.ok) return null;
      const data = (await res.json()) as Record<string, unknown>;
      const pending = this.extractPromptIds(data.queue_pending);
      const running = this.extractPromptIds(data.queue_running);
      return { pendingIds: pending, runningIds: running };
    } catch {
      return null;
    }
  }

  async clearPendingQueue(pendingIds: string[]): Promise<boolean> {
    // Try ComfyUI clear mode first
    try {
      const clearRes = await this.fetchWithRetry(
        `${this.baseUrl}/queue`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clear: true }),
        },
        { attempts: 3, timeoutMs: 10_000, baseDelayMs: 150 }
      );
      if (clearRes.ok) return true;
    } catch { /* ignore and fall back */ }

    // Fallback: delete specific prompt IDs if supported by server build
    if (pendingIds.length === 0) return false;
    try {
      const delRes = await this.fetchWithRetry(
        `${this.baseUrl}/queue`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ delete: pendingIds }),
        },
        { attempts: 3, timeoutMs: 10_000, baseDelayMs: 150 }
      );
      return delRes.ok;
    } catch {
      return false;
    }
  }

  async cancelPrompt(promptId: string): Promise<boolean> {
    try {
      const res = await this.fetchWithRetry(
        `${this.baseUrl}/queue`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ delete: [promptId] }),
        },
        { attempts: 3, timeoutMs: 10_000, baseDelayMs: 150 }
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  async interruptRunning(): Promise<boolean> {
    try {
      const res = await this.fetchWithRetry(
        `${this.baseUrl}/interrupt`,
        { method: "POST" },
        { attempts: 2, timeoutMs: 10_000, baseDelayMs: 150 }
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  private async reconcileQueueBeforeSubmit(): Promise<void> {
    const autoClear = (process.env.COMFYUI_AUTO_CLEAR_QUEUE || "true").toLowerCase() !== "false";
    if (!autoClear) return;

    const maxPending = parseInt(process.env.COMFYUI_MAX_PENDING || "4", 10);
    const maxPendingSafe = Number.isFinite(maxPending) && maxPending >= 0 ? maxPending : 4;
    const autoInterrupt = (process.env.COMFYUI_AUTO_INTERRUPT_RUNNING || "false").toLowerCase() === "true";

    const snapshot = await this.getQueueSnapshot();
    if (!snapshot) return;

    if (snapshot.pendingIds.length > maxPendingSafe) {
      console.warn(
        `[comfyui] Queue pending ${snapshot.pendingIds.length} > ${maxPendingSafe}. Clearing pending jobs.`
      );
      const cleared = await this.clearPendingQueue(snapshot.pendingIds);
      if (!cleared) {
        console.warn("[comfyui] Failed to clear pending queue.");
      }

      if (autoInterrupt && snapshot.runningIds.length > 0) {
        console.warn("[comfyui] Interrupting running job due to queue pressure.");
        await this.interruptRunning();
      }
    }
  }

  /** Query ComfyUI for available checkpoints and LoRAs */
  async getAvailableModels(): Promise<{ checkpoints: string[]; loras: string[] }> {
    if (this.availableModelsCache) return this.availableModelsCache;

    try {
      const [ckptRes, loraRes] = await Promise.all([
        this.fetchWithRetry(`${this.baseUrl}/object_info/CheckpointLoaderSimple`, {}, { attempts: 3, timeoutMs: 10_000 }),
        this.fetchWithRetry(`${this.baseUrl}/object_info/LoraLoader`, {}, { attempts: 3, timeoutMs: 10_000 }),
      ]);

      let checkpoints: string[] = [];
      let loras: string[] = [];

      if (ckptRes.ok) {
        const data = await ckptRes.json() as Record<string, unknown>;
        const info = data.CheckpointLoaderSimple as Record<string, unknown> | undefined;
        const input = info?.input as Record<string, unknown> | undefined;
        const required = input?.required as Record<string, unknown> | undefined;
        const ckptField = required?.ckpt_name as [string[]] | undefined;
        if (ckptField?.[0]) checkpoints = ckptField[0];
      }

      if (loraRes.ok) {
        const data = await loraRes.json() as Record<string, unknown>;
        const info = data.LoraLoader as Record<string, unknown> | undefined;
        const input = info?.input as Record<string, unknown> | undefined;
        const required = input?.required as Record<string, unknown> | undefined;
        const loraField = required?.lora_name as [string[]] | undefined;
        if (loraField?.[0]) loras = loraField[0];
      }

      this.availableModelsCache = { checkpoints, loras };
      console.log(`[comfyui] Available: ${checkpoints.length} checkpoints, ${loras.length} LoRAs`);
      return this.availableModelsCache;
    } catch {
      console.warn("[comfyui] Failed to query available models, skipping validation");
      return { checkpoints: [], loras: [] };
    }
  }

  /**
   * Remove unavailable LoRA nodes from the workflow and rewire the chain.
   * LoRA nodes form a chain: each takes model/clip from the previous and passes to the next.
   * When a node is removed, downstream references must be rewired to the previous surviving node.
   */
  private pruneUnavailableLoRAs(
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

  /** Read comfyui-config.json from session/persona dir if it exists */
  private readDirConfig(dir: string): { checkpoint?: string; baseLoras?: Array<{ name: string; strength: number }> } {
    const configPath = path.join(dir, "comfyui-config.json");
    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        const result: { checkpoint?: string; baseLoras?: Array<{ name: string; strength: number }> } = {};
        // Support preset structure
        const preset = config.active_preset && config.presets?.[config.active_preset];
        if (preset?.checkpoint) result.checkpoint = preset.checkpoint;
        else if (config.checkpoint) result.checkpoint = config.checkpoint;
        // Base LoRAs from preset or top-level
        const loras = preset?.baseLoras || config.baseLoras;
        if (Array.isArray(loras)) result.baseLoras = loras;
        return result;
      } catch { /* ignore */ }
    }
    return {};
  }

  /** Load LoRA trigger tag table from data/tools/comfyui/lora-triggers.json */
  private loadLoraTriggers(): Record<string, string> {
    // workflowsDir = data/tools/comfyui/skills/generate-image/workflows
    // lora-triggers.json lives at data/tools/comfyui/lora-triggers.json
    const triggersPath = path.join(this.workflowsDir, "..", "..", "..", "lora-triggers.json");
    if (!fs.existsSync(triggersPath)) return {};
    try {
      const data = JSON.parse(fs.readFileSync(triggersPath, "utf-8"));
      // Remove _comment key if present
      delete data._comment;
      return data;
    } catch {
      console.warn("[comfyui] Failed to parse lora-triggers.json");
      return {};
    }
  }

  /** Collect all active LoRA filenames from the processed workflow */
  private collectActiveLoRAs(prompt: Record<string, unknown>): string[] {
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
  private findLoraInjectionAnchors(prompt: Record<string, unknown>): LoraInjectionAnchors | null {
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
  private appendLoraChain(
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

  /** Inject per-character CLIP-branch LoRA chains for scene-couple workflow.
   *  Each region (left=node 50, right=node 51) gets its own LoRA chain
   *  branching from the common chain's CLIP output. */
  private injectCoupleBranchLoras(
    prompt: Record<string, unknown>,
    availableLoRAs: string[],
    lorasLeft?: Array<{ name: string; strength: number }>,
    lorasRight?: Array<{ name: string; strength: number }>
  ): void {
    const regionNodes = [
      { targetId: "50", loras: lorasLeft,  startId: 400, label: "left" },
      { targetId: "51", loras: lorasRight, startId: 500, label: "right" },
    ];

    const triggerTable = this.loadLoraTriggers();

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

  /** Auto-inject trigger tags for active LoRAs into the prompt text, with deduplication */
  private injectTriggerTags(
    prompt: Record<string, unknown>,
    meta: WorkflowPackageMeta,
    triggerTable: Record<string, string>,
    activeLoRAs: string[]
  ): void {
    const promptDef = meta.params["prompt"];
    if (!promptDef) return;

    const node = prompt[promptDef.node] as Record<string, unknown> | undefined;
    if (!node) return;
    const inputs = node.inputs as Record<string, unknown> | undefined;
    if (!inputs) return;

    const currentPrompt = (inputs[promptDef.field] as string) || "";

    // Collect trigger tags from all active LoRAs
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

    // Deduplicate against tags already in the prompt (case-insensitive)
    const promptLower = currentPrompt.toLowerCase();
    const newTags = triggerTags.filter(tag => !promptLower.includes(tag.toLowerCase()));

    if (newTags.length === 0) return;

    inputs[promptDef.field] = currentPrompt + ", " + newTags.join(", ");
    console.log(`[comfyui] Auto-injected trigger tags: ${newTags.join(", ")}`);
  }

  /** Resolve the best available checkpoint name */
  private resolveCheckpoint(availableCheckpoints: string[], sessionDir?: string): string {
    // Priority: 1) comfyui-config.json in session dir, 2) env var, 3) auto-detect
    let configured = this.checkpointName;

    if (sessionDir) {
      const dirConfig = this.readDirConfig(sessionDir);
      if (dirConfig.checkpoint) {
        configured = dirConfig.checkpoint;
        console.log(`[comfyui] Using checkpoint from comfyui-config.json: ${configured}`);
      }
    }

    // No checkpoints available at all
    if (availableCheckpoints.length === 0) {
      throw new Error("No checkpoint models found. Download a checkpoint to ComfyUI/models/checkpoints/. If CIVITAI_API_KEY is configured, use the civitai-search skill to find and download models (e.g. Illustrious XL).");
    }

    // If configured checkpoint is available, use it
    if (availableCheckpoints.includes(configured)) {
      return configured;
    }

    // Try to find a good default from available ones
    const preferred = availableCheckpoints.find(
      (c) => /illustr|anime|nova/i.test(c)
    );
    const selected = preferred || availableCheckpoints[0];
    console.log(`[comfyui] Checkpoint "${configured}" not found, using "${selected}"`);
    return selected;
  }

  async buildPrompt(
    workflowName: string,
    params: Record<string, unknown>,
    sessionDir?: string,
    loras?: Array<{ name: string; strength: number }>,
    lorasLeft?: Array<{ name: string; strength: number }>,
    lorasRight?: Array<{ name: string; strength: number }>
  ): Promise<object> {
    // === Phase 1: Package Load ===
    const pkg = loadPackage(this.workflowsDir, workflowName);
    const features: WorkflowFeatures = pkg.meta.features || {
      checkpoint_auto: true,
      lora_injection: true,
      lora_couple_branches: false,
      seed_randomize: true,
      trigger_tags: true,
    };

    // === Phase 2: Parameter Validation ===
    const validation = validateParams(params, pkg.meta.params);
    if (!validation.valid) {
      throw new Error(`Parameter validation failed: ${validation.errors.join("; ")}`);
    }

    // === Phase 3: Resolver (parameter substitution) ===
    const models = await this.getAvailableModels();
    const prompt = await resolveWorkflow(pkg, params, {
      sessionDir,
      config: sessionDir ? this.readDirConfig(sessionDir) as Record<string, unknown> : undefined,
      models,
    });

    // === Phase 4: Runtime Transforms (gated by features flags) ===

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
      if (sessionDir) {
        const dirConfig = this.readDirConfig(sessionDir);
        if (dirConfig.baseLoras && dirConfig.baseLoras.length > 0) {
          this.injectBaseLoRAs(prompt, dirConfig.baseLoras);
        }
      }
      this.pruneUnavailableLoRAs(prompt, models.loras);
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

    // 4f: detailer_chain
    if (features.detailer_chain && pkg.meta.detailer_chain) {
      this.processDetailerChain(prompt, pkg.meta.detailer_chain, params);
    }

    // 4g: auto-upload session images for LoadImage nodes
    if (sessionDir) {
      await this.autoUploadLoadImages(prompt, sessionDir);
    }

    return prompt;
  }

  /** Auto-upload session-local images to ComfyUI input dir for LoadImage nodes.
   *  Scans all LoadImage nodes in the prompt. If the image value looks like a
   *  session-relative path (contains "/" — e.g. "images/source/p000002.png"),
   *  uploads the file from sessionDir and replaces the value with the uploaded name. */
  private async autoUploadLoadImages(
    prompt: Record<string, unknown>,
    sessionDir: string
  ): Promise<void> {
    for (const node of Object.values(prompt)) {
      const n = node as Record<string, unknown>;
      if (n.class_type !== "LoadImage") continue;
      const inputs = n.inputs as Record<string, unknown> | undefined;
      if (!inputs || typeof inputs.image !== "string") continue;

      const imagePath = inputs.image as string;
      // Only process paths that look session-relative (contain a slash)
      // Plain filenames (e.g. "example.png") are already in ComfyUI input
      if (!imagePath.includes("/")) continue;

      let absPath = path.join(sessionDir, imagePath);
      // Fallback: if not found directly, try under images/ subdirectory
      // (pipeline may store paths as "source/foo.png" relative to images/)
      if (!fs.existsSync(absPath)) {
        const fallback = path.join(sessionDir, "images", imagePath);
        if (fs.existsSync(fallback)) {
          absPath = fallback;
        } else {
          console.error(`[comfyui] LoadImage auto-upload: file not found: ${absPath} (also tried ${fallback})`);
          continue;
        }
      }

      // Upload with a unique suffix to bust ComfyUI's image cache
      const ext = path.extname(absPath);
      const base = path.basename(absPath, ext);
      const uniqueName = `${base}_${Date.now()}${ext}`;
      const uniquePath = path.join(path.dirname(absPath), uniqueName);
      fs.copyFileSync(absPath, uniquePath);

      let uploadedName: string | null;
      try {
        uploadedName = await this.uploadImage(uniquePath);
      } finally {
        try { fs.unlinkSync(uniquePath); } catch { /* ignore */ }
      }

      if (uploadedName) {
        inputs.image = uploadedName;
        console.log(`[comfyui] LoadImage auto-upload: ${imagePath} → ${uploadedName}`);
      } else {
        console.error(`[comfyui] LoadImage auto-upload failed for: ${imagePath}`);
      }
    }
  }

  /** Cached detailer module templates loaded from detailer-modules.json */
  private detailerModulesCache: Record<string, DetailerModuleTemplate> | null = null;

  /** Load shared detailer module templates */
  private loadDetailerModules(): Record<string, DetailerModuleTemplate> {
    if (this.detailerModulesCache) return this.detailerModulesCache;
    const modulesPath = path.join(this.workflowsDir, "detailer-modules.json");
    if (!fs.existsSync(modulesPath)) return {};
    this.detailerModulesCache = JSON.parse(fs.readFileSync(modulesPath, "utf8"));
    return this.detailerModulesCache!;
  }

  /** Inject enabled detailer modules between source and sink */
  private processDetailerChain(
    prompt: Record<string, unknown>,
    chainConfig: DetailerChainConfig,
    params: Record<string, unknown>
  ): void {
    const modules = this.loadDetailerModules();
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

    // Resolve clip by tracing KSampler → positive → CLIPTextEncode.clip
    const resolveClip = (): unknown => {
      const posRef = samplerInputs?.positive as [string, number] | undefined;
      if (posRef) {
        const posNode = prompt[posRef[0]] as Record<string, unknown> | undefined;
        if (posNode) {
          return (posNode.inputs as Record<string, unknown>)?.clip;
        }
      }
      return null;
    };

    // Determine which modules are enabled (in fixed order)
    const moduleOrder = ["face", "hand", "pussy", "anus"];
    const enabledModules: Array<{ id: string; template: DetailerModuleTemplate }> = [];

    for (const moduleId of moduleOrder) {
      if (!modules[moduleId]) continue;
      const paramKey = `detailer_${moduleId}`;
      if (params[paramKey] === false) continue;
      enabledModules.push({ id: moduleId, template: modules[moduleId] });
    }

    // If no modules enabled, source→sink is already connected in base workflow
    if (enabledModules.length === 0) return;

    // Inject each enabled module's nodes into the prompt
    for (const { template } of enabledModules) {
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
        prompt[nodeId] = {
          class_type: nodeDef.class_type,
          inputs: { ...nodeDef.inputs },
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

      detailerInputs.model = samplerInputs?.model;
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

  /** Inject base LoRAs from comfyui-config into the workflow */
  private injectBaseLoRAs(
    prompt: Record<string, unknown>,
    baseLoras: Array<{ name: string; strength: number }>
  ): void {
    const anchors = this.findLoraInjectionAnchors(prompt);
    if (!anchors) {
      console.warn("[comfyui] No checkpoint or split UNET/CLIP loader pair — cannot inject base LoRAs");
      return;
    }

    const finalNodeId = this.appendLoraChain(prompt, baseLoras, anchors, 100, "base-lora");
    if (finalNodeId) {
      console.log(`[comfyui] Injected ${baseLoras.length} base LoRAs from config`);
    }
  }

  /** Apply dynamic LoRA overrides and injections */
  private applyDynamicLoRAs(
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
      const anchors = this.findLoraInjectionAnchors(prompt);
      if (anchors) {
        const finalNodeId = this.appendLoraChain(prompt, validNewLoras, anchors, 200, "dynamic-lora");
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

  private async pollHistory(
    promptId: string,
    timeoutMs = 120_000,
    opts: { initialWaitMs?: number; startIntervalMs?: number; maxIntervalMs?: number } = {}
  ): Promise<Record<string, unknown> | null> {
    const timeout = timeoutMs;
    const initialWait = opts.initialWaitMs ?? 0;
    const start = Date.now();

    if (initialWait > 0) {
      await new Promise((r) => setTimeout(r, initialWait));
    }

    let interval = opts.startIntervalMs ?? 2_000;
    const maxInterval = opts.maxIntervalMs ?? 8_000;
    while (Date.now() - start < timeout) {
      try {
        const res = await this.fetchWithRetry(
          `${this.baseUrl}/history/${promptId}`,
          {},
          { attempts: 3, timeoutMs: 10_000, baseDelayMs: 150 }
        );
        if (res.ok) {
          const data = (await res.json()) as Record<
            string,
            Record<string, unknown>
          >;
          const entry = data[promptId];
          if (entry) return entry;
        }
      } catch {
        // ComfyUI may not be ready yet, keep polling
      }

      await new Promise((r) => setTimeout(r, interval));
      interval = Math.min(Math.floor(interval * 1.5), maxInterval);
    }

    return null;
  }

  /** Extract audio output filenames from history entry */
  private extractAudioFilenames(
    historyEntry: Record<string, unknown>
  ): Array<{ filename: string; prefix: string }> {
    const outputs = historyEntry.outputs as
      | Record<string, Record<string, unknown>>
      | undefined;
    if (!outputs) return [];

    const results: Array<{ filename: string; prefix: string }> = [];
    for (const nodeOutput of Object.values(outputs)) {
      const audios = nodeOutput.audio as
        | Array<{ filename: string; subfolder?: string; type?: string }>
        | undefined;
      if (audios && audios.length > 0) {
        for (const a of audios) {
          const prefix = a.filename.replace(/_\d+_?\.\w+$/, "");
          results.push({ filename: a.filename, prefix });
        }
      }
    }
    return results;
  }

  /** Extract all output filenames grouped by their prefix */
  private extractOutputFilenames(
    historyEntry: Record<string, unknown>
  ): Array<{ filename: string; prefix: string; subfolder?: string; type?: string }> {
    const outputs = historyEntry.outputs as
      | Record<string, Record<string, unknown>>
      | undefined;
    if (!outputs) return [];

    const results: Array<{ filename: string; prefix: string; subfolder?: string; type?: string }> = [];
    for (const nodeOutput of Object.values(outputs)) {
      const images = nodeOutput.images as
        | Array<{ filename: string; subfolder?: string; type?: string }>
        | undefined;
      if (images && images.length > 0) {
        for (const img of images) {
          // ComfyUI filenames are like "profile_00001_.png" — extract prefix before first underscore+digits
          const prefix = img.filename.replace(/_\d+_?\.\w+$/, "");
          results.push({
            filename: img.filename,
            prefix,
            subfolder: img.subfolder,
            type: img.type,
          });
        }
      }
    }
    return results;
  }

  private copyOutputFileToSession(
    outputFile: { filename: string; subfolder?: string; type?: string },
    destPath: string
  ): boolean {
    const comfyDir = process.env.COMFYUI_DIR;
    if (!comfyDir) return false;

    const outputRoot = outputFile.type === "temp"
      ? path.join(comfyDir, "temp")
      : path.join(comfyDir, "output");
    const sourcePath = path.join(outputRoot, outputFile.subfolder || "", outputFile.filename);

    if (!fs.existsSync(sourcePath)) return false;

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(sourcePath, destPath);
    return true;
  }

  private get gpuManagerUrl(): string {
    const port = process.env.GPU_MANAGER_PORT || "3342";
    return `http://127.0.0.1:${port}`;
  }

  /** Cache GPU Manager availability for 30s to avoid repeated health checks
   *  and prevent fallback to direct ComfyUI when GPU Manager is just busy. */
  private _gpuManagerUp: boolean | null = null;
  private _gpuManagerCheckedAt = 0;

  private async gpuManagerAvailable(): Promise<boolean> {
    const now = Date.now();
    // Return cached result if checked recently (30s)
    if (this._gpuManagerUp !== null && now - this._gpuManagerCheckedAt < 30_000) {
      return this._gpuManagerUp;
    }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      const res = await fetch(`${this.gpuManagerUrl}/health`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      this._gpuManagerUp = res.ok;
    } catch {
      this._gpuManagerUp = false;
    }
    this._gpuManagerCheckedAt = now;
    return this._gpuManagerUp;
  }

  /**
   * Submit prompt to ComfyUI queue (direct, no GPU Manager).
   * Returns promptId on success — does NOT wait for completion.
   */
  async submitToQueue(
    prompt: Record<string, unknown>,
  ): Promise<{ promptId: string } | { error: string }> {
    await this.reconcileQueueBeforeSubmit();

    const queueRes = await this.fetchWithRetry(`${this.baseUrl}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    }, { attempts: 5, timeoutMs: 30_000, baseDelayMs: 300 });

    if (!queueRes.ok) {
      const errText = await queueRes.text();
      return { error: `ComfyUI queue failed: ${errText}` };
    }

    const queueData = (await queueRes.json()) as { prompt_id: string };
    return { promptId: queueData.prompt_id };
  }

  /**
   * Poll for ComfyUI completion and download results.
   * Call after submitToQueue succeeds.
   */
  async waitAndDownload(
    promptId: string,
    filename: string,
    sessionDir: string,
    extraFiles?: Record<string, string>
  ): Promise<GenerateResult> {
    // Image generation rarely finishes in <10s — wait before first poll to avoid
    // hammering ComfyUI (and exhausting ephemeral ports).
    const history = await this.pollHistory(promptId, 120_000, {
      initialWaitMs: 10_000,
    });
    if (!history) {
      await this.cancelPrompt(promptId);
      return { success: false, error: "Timeout waiting for ComfyUI generation" };
    }

    return this.downloadResults(history, filename, sessionDir, extraFiles);
  }

  /** Check if GPU Manager is available */
  async isGpuManagerAvailable(): Promise<boolean> {
    return this.gpuManagerAvailable();
  }

  /** Check if ComfyUI is reachable */
  async isComfyUIReachable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      const res = await fetch(`${this.baseUrl}/system_stats`, { signal: controller.signal });
      clearTimeout(timeout);
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Download output files from ComfyUI history and save to session dir */
  private async downloadResults(
    history: Record<string, unknown>,
    filename: string,
    sessionDir: string,
    extraFiles?: Record<string, string>
  ): Promise<GenerateResult> {
    const outputFiles = this.extractOutputFilenames(history);
    if (outputFiles.length === 0) {
      return { success: false, error: "No output image in ComfyUI result" };
    }

    const imagesDir = path.join(sessionDir, "images");
    fs.mkdirSync(imagesDir, { recursive: true });

    const mainOutput = outputFiles[0];
    const safeName = safePath(filename);
    const mainDest = path.join(imagesDir, safeName);
    fs.mkdirSync(path.dirname(mainDest), { recursive: true });

    const mainBuffer = await this.downloadImage(mainOutput.filename);
    if (mainBuffer) {
      fs.writeFileSync(mainDest, mainBuffer);
    } else if (!this.copyOutputFileToSession(mainOutput, mainDest)) {
      return { success: false, error: "Failed to download or copy image from ComfyUI output" };
    }

    const extraPaths: Record<string, string> = {};
    if (extraFiles) {
      for (const [prefix, extraFilename] of Object.entries(extraFiles)) {
        const match = outputFiles.find((o) => o.prefix === prefix);
        if (match) {
          const buffer = await this.downloadImage(match.filename);
          const safeExtra = safePath(extraFilename);
          const extraDest = path.join(imagesDir, safeExtra);
          fs.mkdirSync(path.dirname(extraDest), { recursive: true });
          if (buffer) {
            fs.writeFileSync(extraDest, buffer);
            extraPaths[prefix] = `images/${safeExtra}`;
            console.log(`[comfyui] Extra output saved: ${safeExtra} (prefix: ${prefix})`);
          } else if (this.copyOutputFileToSession(match, extraDest)) {
            extraPaths[prefix] = `images/${safeExtra}`;
            console.log(`[comfyui] Extra output copied from output dir: ${safeExtra} (prefix: ${prefix})`);
          }
        }
      }
    }

    return {
      success: true,
      filepath: `images/${safeName}`,
      ...(Object.keys(extraPaths).length > 0 ? { extraPaths } : {}),
    };
  }

  /**
   * Submit + wait in one call. Uses GPU Manager when available (synchronous),
   * falls back to direct ComfyUI (queue + poll). Used by faceCrop, generateTts, etc.
   */
  private async submitAndWait(
    prompt: Record<string, unknown>,
    filename: string,
    sessionDir: string,
    extraFiles?: Record<string, string>
  ): Promise<GenerateResult> {
    const useGpuManager = await this.gpuManagerAvailable();

    if (useGpuManager) {
      // No retry (attempts: 1) — GPU Manager has its own queue and error handling.
      // Retrying would duplicate the request in the queue.
      // Generous timeout (30 min) to account for queue wait + processing time.
      const res = await this.fetchWithRetry(
        `${this.gpuManagerUrl}/comfyui/generate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt, timeout: 600_000 }),
        },
        { attempts: 1, timeoutMs: 1_800_000 },
      );

      if (!res.ok) {
        const errText = await res.text();
        return { success: false, error: `GPU Manager error: ${errText}` };
      }

      const data = await res.json() as { prompt_id: string; history: Record<string, unknown> };
      return this.downloadResults(data.history, filename, sessionDir, extraFiles);
    } else {
      const handle = await this.submitToQueue(prompt);
      if ("error" in handle) {
        return { success: false, error: handle.error };
      }
      return this.waitAndDownload(handle.promptId, filename, sessionDir, extraFiles);
    }
  }

  private async downloadImage(filename: string): Promise<Buffer | null> {
    try {
      const res = await this.fetchWithRetry(
        `${this.baseUrl}/view?filename=${encodeURIComponent(filename)}`,
        {},
        { attempts: 4, timeoutMs: 20_000, baseDelayMs: 200 }
      );
      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer());
    } catch {
      return null;
    }
  }

  /** Template-based generation: loads workflow from data/tools/comfyui/workflows/ */
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    try {
      const prompt = await this.buildPrompt(req.workflow, req.params, req.sessionDir, req.loras, req.loras_left, req.loras_right) as Record<string, unknown>;
      return this.submitAndWait(prompt, req.filename, req.sessionDir, req.extraFiles);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }

  /** Upload an image to ComfyUI's input folder for use with LoadImage nodes.
   *  Uses native FormData for reliable multipart upload. */
  async uploadImage(imagePath: string): Promise<string | null> {
    try {
      const imageBuffer = fs.readFileSync(imagePath);
      const basename = path.basename(imagePath);

      const formData = new FormData();
      formData.append("image", new Blob([imageBuffer], { type: "image/png" }), basename);
      formData.append("overwrite", "true");

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);

      try {
        const res = await fetch(`${this.baseUrl}/upload/image`, {
          method: "POST",
          body: formData,
          signal: controller.signal,
        });

        if (!res.ok) {
          console.error(`[comfyui] Upload failed with status ${res.status}`);
          return null;
        }
        const data = (await res.json()) as { name: string };
        console.log(`[comfyui] Uploaded image: ${data.name}`);
        return data.name;
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      console.error(`[comfyui] Upload failed:`, err);
      return null;
    }
  }

  /** Generate a 256x256 face-cropped icon from an existing image */
  async faceCrop(
    sourceImagePath: string,
    outputFilename: string,
    sessionDir: string
  ): Promise<GenerateResult> {
    try {
      // Upload with a unique name to bust ComfyUI's cache
      const uniqueSuffix = `_${Date.now()}`;
      const ext = path.extname(sourceImagePath);
      const base = path.basename(sourceImagePath, ext);
      const uniqueName = `${base}${uniqueSuffix}${ext}`;
      const uniquePath = path.join(path.dirname(sourceImagePath), uniqueName);
      fs.copyFileSync(sourceImagePath, uniquePath);

      let uploadedName: string | null;
      try {
        uploadedName = await this.uploadImage(uniquePath);
      } finally {
        // Clean up the temp copy
        try { fs.unlinkSync(uniquePath); } catch { /* ignore */ }
      }

      if (!uploadedName) {
        return { success: false, error: "Failed to upload source image to ComfyUI" };
      }

      // Build face-crop workflow
      const prompt: Record<string, unknown> = {
        "10": {
          class_type: "LoadImage",
          inputs: { image: uploadedName },
        },
        "20": {
          class_type: "UltralyticsDetectorProvider",
          inputs: { model_name: "bbox/face_yolov8m.pt" },
        },
        "42": {
          class_type: "BboxDetectorSEGS",
          inputs: {
            bbox_detector: ["20", 0],
            image: ["10", 0],
            threshold: 0.5,
            dilation: 0,
            crop_factor: 1.3,
            drop_size: 10,
            labels: "all",
          },
        },
        "43": {
          class_type: "SEGSToImageList",
          inputs: {
            segs: ["42", 0],
            fallback_image_opt: ["10", 0],
          },
        },
        "40": {
          class_type: "ImageScale",
          inputs: {
            image: ["43", 0],
            width: 256,
            height: 256,
            upscale_method: "lanczos",
            crop: "center",
          },
        },
        "41": {
          class_type: "SaveImage",
          inputs: { filename_prefix: "icon", images: ["40", 0] },
        },
      };

      return this.submitAndWait(prompt, outputFilename, sessionDir);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }

  /** Raw mode: accepts a complete ComfyUI workflow JSON directly */
  async generateRaw(req: GenerateRawRequest): Promise<GenerateResult> {
    try {
      return this.submitAndWait(req.prompt, req.filename, req.sessionDir, req.extraFiles);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }

  /** Generate TTS audio via ComfyUI workflow, download and save to outputPath */
  async generateTts(
    prompt: Record<string, unknown>,
    outputPath: string,
  ): Promise<{ success: boolean; error?: string }> {
    const t0 = Date.now();
    try {
      // Check queue state before submitting
      const snapshot = await this.getQueueSnapshot();
      if (snapshot) {
        console.log(`[comfyui-tts] Queue state: pending=${snapshot.pendingIds.length} running=${snapshot.runningIds.length}`);
      }

      await this.reconcileQueueBeforeSubmit();
      const t1 = Date.now();
      if (t1 - t0 > 1000) console.warn(`[comfyui-tts] reconcileQueue took ${t1 - t0}ms`);

      const queueRes = await this.fetchWithRetry(`${this.baseUrl}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      }, { attempts: 5, timeoutMs: 30_000, baseDelayMs: 300 });

      if (!queueRes.ok) {
        const errText = await queueRes.text();
        console.error("[comfyui-tts] Queue failed:", queueRes.status, errText);
        return { success: false, error: `ComfyUI queue failed: ${errText}` };
      }

      const { prompt_id } = (await queueRes.json()) as { prompt_id: string };
      const t2 = Date.now();
      console.log(`[comfyui-tts] Queued ${prompt_id} in ${t2 - t1}ms`);

      const history = await this.pollHistory(prompt_id, 600_000);
      const t3 = Date.now();
      console.log(`[comfyui-tts] pollHistory ${prompt_id} took ${t3 - t2}ms (total ${t3 - t0}ms)`);

      if (!history) {
        await this.cancelPrompt(prompt_id);
        return { success: false, error: "Timeout waiting for TTS generation" };
      }
      const audioFiles = this.extractAudioFilenames(history);
      if (audioFiles.length === 0) {
        return { success: false, error: "No audio output in ComfyUI result" };
      }

      const buffer = await this.downloadImage(audioFiles[0].filename);
      if (!buffer) {
        return { success: false, error: "Failed to download audio from ComfyUI" };
      }

      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, buffer);
      const t4 = Date.now();
      if (t4 - t0 > 30_000) {
        console.warn(`[comfyui-tts] SLOW generation: total ${t4 - t0}ms (queue=${t2 - t1}ms poll=${t3 - t2}ms download=${t4 - t3}ms)`);
      }
      return { success: true };
    } catch (err) {
      console.error(`[comfyui-tts] Error after ${Date.now() - t0}ms:`, err instanceof Error ? err.message : String(err));
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Upload audio file to ComfyUI input dir (reuses /upload/image endpoint) */
  async uploadAudio(audioPath: string): Promise<string | null> {
    try {
      const audioBuffer = fs.readFileSync(audioPath);
      const basename = path.basename(audioPath);
      const ext = path.extname(basename).toLowerCase();
      const mimeMap: Record<string, string> = {
        ".wav": "audio/wav", ".mp3": "audio/mpeg", ".webm": "audio/webm",
        ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".mp4": "audio/mp4",
      };
      const mime = mimeMap[ext] || "application/octet-stream";

      const formData = new FormData();
      formData.append("image", new Blob([audioBuffer], { type: mime }), basename);
      formData.append("overwrite", "true");
      formData.append("subfolder", "");
      formData.append("type", "input");

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        const res = await fetch(`${this.baseUrl}/upload/image`, {
          method: "POST",
          body: formData,
          signal: controller.signal,
        });
        if (!res.ok) {
          console.error(`[comfyui-stt] Upload failed: ${res.status}`);
          return null;
        }
        const data = (await res.json()) as { name: string };
        console.log(`[comfyui-stt] Uploaded audio: ${data.name}`);
        return data.name;
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      console.error(`[comfyui-stt] Upload failed:`, err);
      return null;
    }
  }

  /** Extract text outputs from ComfyUI history entry */
  private extractTextOutputs(historyEntry: Record<string, unknown>): string[] {
    const outputs = historyEntry.outputs as Record<string, Record<string, unknown>> | undefined;
    if (!outputs) return [];
    const texts: string[] = [];
    for (const nodeOutput of Object.values(outputs)) {
      // ShowTextForGPT stores text in { text: [...] }
      const textArr = nodeOutput.text as string[] | undefined;
      if (textArr && Array.isArray(textArr)) {
        texts.push(...textArr);
      }
      // Some nodes use string directly
      if (typeof nodeOutput.string === "string") {
        texts.push(nodeOutput.string);
      }
    }
    return texts;
  }

  /** Transcribe audio using ComfyUI Whisper STT node */
  async transcribeAudio(
    audioPath: string,
    language = "ko",
    modelSize = "base",
  ): Promise<TranscribeResult> {
    const t0 = Date.now();
    try {
      // Upload audio to ComfyUI input dir
      const uploadedName = await this.uploadAudio(audioPath);
      if (!uploadedName) {
        return { success: false, error: "Failed to upload audio to ComfyUI" };
      }

      const prompt: Record<string, unknown> = {
        "1": {
          class_type: "LoadAudio",
          inputs: { audio: uploadedName },
        },
        "2": {
          class_type: "AILab_Qwen3TTSWhisperSTT",
          inputs: {
            audio: ["1", 0],
            model_size: modelSize,
            language,
            unload_models: true,
          },
        },
        "3": {
          class_type: "ShowTextForGPT",
          inputs: {
            text: ["2", 0],
          },
        },
      };

      await this.reconcileQueueBeforeSubmit();

      const queueRes = await this.fetchWithRetry(`${this.baseUrl}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      }, { attempts: 5, timeoutMs: 30_000, baseDelayMs: 300 });

      if (!queueRes.ok) {
        const errText = await queueRes.text();
        return { success: false, error: `ComfyUI queue failed: ${errText}` };
      }

      const { prompt_id } = (await queueRes.json()) as { prompt_id: string };
      console.log(`[comfyui-stt] Queued ${prompt_id} (${Date.now() - t0}ms)`);

      const history = await this.pollHistory(prompt_id, 120_000);
      if (!history) {
        await this.cancelPrompt(prompt_id);
        return { success: false, error: "Timeout waiting for STT" };
      }

      const texts = this.extractTextOutputs(history);
      const text = texts.join(" ").trim();
      console.log(`[comfyui-stt] Done in ${Date.now() - t0}ms: "${text.substring(0, 80)}..."`);

      return { success: true, text };
    } catch (err) {
      console.error(`[comfyui-stt] Error:`, err);
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
