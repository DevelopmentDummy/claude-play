import * as fs from "fs";
import * as path from "path";

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

interface WorkflowMeta {
  params: Record<
    string,
    {
      node: string;
      field: string;
      required?: boolean;
      default?: unknown;
    }
  >;
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
  private readDirConfig(dir: string): { checkpoint?: string } {
    const configPath = path.join(dir, "comfyui-config.json");
    if (fs.existsSync(configPath)) {
      try {
        return JSON.parse(fs.readFileSync(configPath, "utf-8"));
      } catch { /* ignore */ }
    }
    return {};
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

    // If configured checkpoint is available, use it
    if (availableCheckpoints.length === 0 || availableCheckpoints.includes(configured)) {
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

  private async buildPrompt(
    workflowName: string,
    params: Record<string, unknown>,
    sessionDir?: string,
    loras?: Array<{ name: string; strength: number }>
  ): Promise<object> {
    const workflowPath = path.join(
      this.workflowsDir,
      `${workflowName}.json`
    );

    if (!fs.existsSync(workflowPath)) {
      throw new Error(`Workflow "${workflowName}" not found at ${workflowPath}`);
    }

    const workflow = JSON.parse(fs.readFileSync(workflowPath, "utf-8"));
    const meta: WorkflowMeta | undefined = workflow._meta;

    if (!meta?.params) {
      throw new Error(`Workflow "${workflowName}" has no _meta.params`);
    }

    // Build a copy without _meta
    const prompt: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(workflow)) {
      if (key === "_meta") continue;
      prompt[key] = JSON.parse(JSON.stringify(value));
    }

    // Query available models and auto-fix incompatibilities
    const models = await this.getAvailableModels();

    // Auto-inject best available checkpoint
    const resolvedCkpt = this.resolveCheckpoint(models.checkpoints, sessionDir);
    for (const node of Object.values(prompt)) {
      const n = node as Record<string, unknown>;
      if (n.class_type === "CheckpointLoaderSimple") {
        const inputs = n.inputs as Record<string, unknown>;
        if (inputs) inputs.ckpt_name = resolvedCkpt;
      }
    }

    // Remove unavailable LoRAs and rewire the chain
    this.pruneUnavailableLoRAs(prompt, models.loras);

    // LoRA overrides & dynamic injection
    if (loras && loras.length > 0) {
      // Build lookup of requested LoRA overrides by name
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
          // Remove this base LoRA node and rewire references
          const node = prompt[base.id] as Record<string, unknown>;
          const inputs = node.inputs as Record<string, unknown>;
          const modelSource = inputs.model as [string, number] | undefined;
          const sourceId = modelSource ? modelSource[0] : null;

          delete prompt[base.id];

          // Rewire downstream references to this removed node
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
          // Override strength
          const node = prompt[base.id] as Record<string, unknown>;
          const inputs = node.inputs as Record<string, unknown>;
          inputs.strength_model = override.strength;
          inputs.strength_clip = override.strength;
          console.log(`[comfyui] Override base LoRA: ${base.loraName} strength → ${override.strength}`);
        }
      }

      // Phase 2: Dynamic injection of non-base LoRAs
      const newLoras = loras.filter(l => !overridden.has(l.name) && l.strength !== 0);
      const validNewLoras = models.loras.length === 0
        ? newLoras
        : newLoras.filter(l => models.loras.includes(l.name));

      if (validNewLoras.length > 0) {
        // Find anchor: last remaining LoraLoader or CheckpointLoaderSimple
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

          // Rewire downstream nodes to new chain end
          const newLastId = prevId;
          for (const [nodeId, node] of Object.entries(prompt)) {
            if (injectedIds.has(nodeId)) continue;
            const n = node as Record<string, unknown>;
            const inputs = n.inputs as Record<string, unknown> | undefined;
            if (!inputs) continue;
            for (const [key, value] of Object.entries(inputs)) {
              if (Array.isArray(value) && value.length === 2 && value[0] === anchorId) {
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

    // Inject params from request
    for (const [paramName, paramDef] of Object.entries(meta.params)) {
      const value =
        params[paramName] !== undefined ? params[paramName] : paramDef.default;

      if (value === undefined && paramDef.required) {
        throw new Error(`Required parameter "${paramName}" not provided`);
      }

      if (value === undefined) continue;

      const node = prompt[paramDef.node] as Record<string, unknown> | undefined;
      if (!node) continue;

      const inputs = node.inputs as Record<string, unknown> | undefined;
      if (!inputs) {
        node.inputs = { [paramDef.field]: value };
      } else {
        inputs[paramDef.field] = value;
      }
    }

    // Handle random seed (-1 means random)
    for (const [, paramDef] of Object.entries(meta.params)) {
      if (paramDef.field === "seed") {
        const node = prompt[paramDef.node] as Record<string, unknown> | undefined;
        if (!node) continue;
        const inputs = node.inputs as Record<string, unknown>;
        if (inputs && inputs.seed === -1) {
          inputs.seed = Math.floor(Math.random() * 2 ** 32);
        }
      }
    }

    return prompt;
  }

  private async pollHistory(
    promptId: string
  ): Promise<Record<string, unknown> | null> {
    const timeout = 120_000;
    const interval = 2_000;
    const start = Date.now();

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
    }

    return null;
  }

  /** Extract all output filenames grouped by their prefix */
  private extractOutputFilenames(
    historyEntry: Record<string, unknown>
  ): Array<{ filename: string; prefix: string }> {
    const outputs = historyEntry.outputs as
      | Record<string, Record<string, unknown>>
      | undefined;
    if (!outputs) return [];

    const results: Array<{ filename: string; prefix: string }> = [];
    for (const nodeOutput of Object.values(outputs)) {
      const images = nodeOutput.images as
        | Array<{ filename: string; subfolder?: string; type?: string }>
        | undefined;
      if (images && images.length > 0) {
        for (const img of images) {
          // ComfyUI filenames are like "profile_00001_.png" — extract prefix before first underscore+digits
          const prefix = img.filename.replace(/_\d+_?\.\w+$/, "");
          results.push({ filename: img.filename, prefix });
        }
      }
    }
    return results;
  }

  private async submitAndWait(
    prompt: Record<string, unknown>,
    filename: string,
    sessionDir: string,
    extraFiles?: Record<string, string>
  ): Promise<GenerateResult> {
    await this.reconcileQueueBeforeSubmit();

    // POST /prompt to ComfyUI
    const queueRes = await this.fetchWithRetry(`${this.baseUrl}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    }, { attempts: 5, timeoutMs: 30_000, baseDelayMs: 300 });

    if (!queueRes.ok) {
      const errText = await queueRes.text();
      return { success: false, error: `ComfyUI queue failed: ${errText}` };
    }

    const queueData = (await queueRes.json()) as { prompt_id: string };
    const promptId = queueData.prompt_id;

    // Poll /history until complete
    const history = await this.pollHistory(promptId);
    if (!history) {
      await this.cancelPrompt(promptId);
      return { success: false, error: "Timeout waiting for ComfyUI generation" };
    }

    // Extract all output filenames
    const outputFiles = this.extractOutputFilenames(history);
    if (outputFiles.length === 0) {
      return { success: false, error: "No output image in ComfyUI result" };
    }

    // Save to session images/ directory
    const imagesDir = path.join(sessionDir, "images");
    fs.mkdirSync(imagesDir, { recursive: true });

    // Download and save the main output (first file)
    const mainOutput = outputFiles[0];
    const mainBuffer = await this.downloadImage(mainOutput.filename);
    if (!mainBuffer) {
      return { success: false, error: "Failed to download image from ComfyUI" };
    }

    const safeName = path.basename(filename);
    fs.writeFileSync(path.join(imagesDir, safeName), mainBuffer);

    // Download and save extra outputs matched by prefix
    const extraPaths: Record<string, string> = {};
    if (extraFiles) {
      for (const [prefix, extraFilename] of Object.entries(extraFiles)) {
        const match = outputFiles.find((o) => o.prefix === prefix);
        if (match) {
          const buffer = await this.downloadImage(match.filename);
          if (buffer) {
            const safeExtra = path.basename(extraFilename);
            fs.writeFileSync(path.join(imagesDir, safeExtra), buffer);
            extraPaths[prefix] = `images/${safeExtra}`;
            console.log(`[comfyui] Extra output saved: ${safeExtra} (prefix: ${prefix})`);
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
      const prompt = await this.buildPrompt(req.workflow, req.params, req.sessionDir, req.loras) as Record<string, unknown>;
      return this.submitAndWait(prompt, req.filename, req.sessionDir, req.extraFiles);
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
}
