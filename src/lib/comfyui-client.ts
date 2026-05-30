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
import { getGpuManagerUrl } from "./endpoints";
import {
  pruneUnavailableLoRAs,
  collectActiveLoRAs,
  findLoraInjectionAnchors,
  appendLoraChain,
  injectTriggerTags,
  injectBaseLoRAs,
  applyDynamicLoRAs,
  injectCoupleBranchLoras,
  processDetailerChain,
  type DetailerModuleTemplate,
} from "./comfyui-graph";
import { extractAudioFilenames, extractOutputFilenames, extractTextOutputs } from "./comfyui-history";

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

  /** Load LoRA trigger tag table from data/tools/comfyui/lora-triggers.json
   *
   * Schema (2026-05-04 v2):
   * - string  → 전부 auto-inject (backward-compat)
   * - object  → { auto?: string, options?: string }
   *             auto 만 자동 주입, options는 매니페스트 표시용 (서버 무시)
   *
   * 반환은 항상 `Record<string, string>` (auto 토큰만 추출). options는 서버 동작에 영향 없음.
   */
  private loadLoraTriggers(): Record<string, string> {
    // 글로벌 트리거 테이블은 항상 data/tools/comfyui/ 아래에 산다.
    // workflowsDir이 세션 로컬 스킬(data/sessions/.../.claude/skills/...)일 수도 있으므로
    // cwd 기준 절대 경로로 직접 잡는다.
    const triggersPath = path.join(process.cwd(), "data/tools/comfyui/lora-triggers.json");
    if (!fs.existsSync(triggersPath)) return {};
    try {
      const raw = JSON.parse(fs.readFileSync(triggersPath, "utf-8"));
      delete raw._comment;
      const result: Record<string, string> = {};
      for (const [filename, value] of Object.entries(raw)) {
        if (typeof value === "string") {
          if (value.trim()) result[filename] = value;
        } else if (value && typeof value === "object") {
          const obj = value as { auto?: unknown; options?: unknown };
          if (typeof obj.auto === "string" && obj.auto.trim()) {
            result[filename] = obj.auto;
          }
          // options 필드는 서버 자동 주입 대상 아님 — 무시
        }
      }
      return result;
    } catch {
      console.warn("[comfyui] Failed to parse lora-triggers.json");
      return {};
    }
  }

  /** Resolve the best available checkpoint name */
  private resolveCheckpoint(availableCheckpoints: string[], sessionDir?: string): string {
    // Priority: 1) comfyui-config.json in session/persona dir, 2) global comfyui-config.json,
    //          3) env var, 4) auto-detect
    let configured = this.checkpointName;

    // Global config fallback (data/tools/comfyui/comfyui-config.json)
    try {
      const globalConfigPath = path.join(process.cwd(), "data/tools/comfyui/comfyui-config.json");
      if (fs.existsSync(globalConfigPath)) {
        const globalConfig = JSON.parse(fs.readFileSync(globalConfigPath, "utf-8"));
        const globalPreset = globalConfig.active_preset && globalConfig.presets?.[globalConfig.active_preset];
        const globalCkpt = globalPreset?.checkpoint || globalConfig.checkpoint;
        if (globalCkpt) {
          configured = globalCkpt;
          console.log(`[comfyui] Using checkpoint from global comfyui-config.json: ${configured}`);
        }
      }
    } catch { /* ignore */ }

    if (sessionDir) {
      const dirConfig = this.readDirConfig(sessionDir);
      if (dirConfig.checkpoint) {
        configured = dirConfig.checkpoint;
        console.log(`[comfyui] Using checkpoint from session/persona comfyui-config.json: ${configured}`);
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

  private loadCheckpointRegistry(): Record<string, Record<string, string>> {
    // 글로벌 체크포인트 레지스트리는 항상 data/tools/comfyui/checkpoints.json.
    // workflowsDir이 세션 로컬 스킬일 수도 있으므로 cwd 기준 절대 경로로 잡는다.
    const registryPath = path.join(process.cwd(), "data/tools/comfyui/checkpoints.json");
    try {
      const data = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
      return (data.checkpoints || {}) as Record<string, Record<string, string>>;
    } catch (err) {
      console.warn(`[comfyui] checkpoints.json 로드 실패 (${registryPath}): ${(err as Error)?.message || err}`);
      return {};
    }
  }

  private findCompatiblePackages(
    registryEntry: Record<string, string>,
    excludeName: string
  ): string[] {
    if (!fs.existsSync(this.workflowsDir)) return [];
    const compatible: string[] = [];
    for (const entry of fs.readdirSync(this.workflowsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === excludeName) continue;
      const paramsPath = path.join(this.workflowsDir, entry.name, "params.json");
      if (!fs.existsSync(paramsPath)) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(paramsPath, "utf-8")) as WorkflowPackageMeta;
        const requires = meta.compatibility?.requires;
        if (!requires) continue;
        const matches = Object.entries(requires).every(
          ([k, v]) => v === undefined || registryEntry[k] === v
        );
        if (matches) compatible.push(entry.name);
      } catch {
        /* skip */
      }
    }
    return compatible;
  }

  private validateCheckpointCompatibility(
    prompt: Record<string, unknown>,
    pkg: { name: string; meta: WorkflowPackageMeta }
  ): void {
    const compat = pkg.meta.compatibility;
    if (!compat?.requires) return;

    const activeCheckpoints: string[] = [];
    for (const node of Object.values(prompt)) {
      const n = node as { class_type?: string; inputs?: Record<string, unknown> };
      if (n?.class_type === "CheckpointLoaderSimple" && typeof n.inputs?.ckpt_name === "string") {
        activeCheckpoints.push(n.inputs.ckpt_name);
      } else if (n?.class_type === "UNETLoader" && typeof n.inputs?.unet_name === "string") {
        activeCheckpoints.push(n.inputs.unet_name);
      }
    }
    if (activeCheckpoints.length === 0) return;

    const registry = this.loadCheckpointRegistry();
    if (Object.keys(registry).length === 0) {
      console.warn("[comfyui] checkpoints.json 레지스트리를 찾지 못해 호환성 검사를 건너뜁니다.");
      return;
    }

    for (const ckpt of activeCheckpoints) {
      const entry = registry[ckpt];
      if (!entry) {
        throw new Error(
          `체크포인트 '${ckpt}'이(가) checkpoints.json 레지스트리에 등록되지 않았습니다. ` +
          `data/tools/comfyui/checkpoints.json에 { "loader": "...", "family": "..." } 엔트리를 추가하세요.`
        );
      }
      const mismatches: string[] = [];
      for (const [key, expected] of Object.entries(compat.requires)) {
        if (expected === undefined) continue;
        if (entry[key] !== expected) {
          mismatches.push(`${key}: 요구 "${expected}" vs 실제 "${entry[key] ?? "(없음)"}"`);
        }
      }
      if (mismatches.length > 0) {
        const compatibleList = this.findCompatiblePackages(entry, pkg.name);
        const compatibleHint = compatibleList.length > 0
          ? `\n해당 체크포인트와 호환되는 패키지: ${compatibleList.join(", ")}`
          : "\n레지스트리상 이 체크포인트와 호환되는 다른 패키지가 없습니다.";
        const message = compat.incompatible_message ? `\n${compat.incompatible_message}` : "";
        throw new Error(
          `체크포인트 호환성 검사 실패: '${ckpt}'은(는) '${pkg.name}' 패키지와 호환되지 않습니다. ` +
          `[${mismatches.join("; ")}]` + message + compatibleHint
        );
      }
    }
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
    // Only auto-resolve when the node's current ckpt_name is not already a valid
    // available model (i.e., the workflow's hardcoded default like "model.safetensors"
    // or empty). If a caller passed an explicit `checkpoint` param via Phase 3
    // mapping, it will already be a valid model name and we leave it intact.
    if (features.checkpoint_auto) {
      const availableSet = new Set(models.checkpoints);
      let resolvedCkpt: string | null = null;
      for (const node of Object.values(prompt)) {
        const n = node as Record<string, unknown>;
        if (n.class_type === "CheckpointLoaderSimple") {
          const inputs = n.inputs as Record<string, unknown>;
          if (!inputs) continue;
          const current = typeof inputs.ckpt_name === "string" ? inputs.ckpt_name : "";
          if (current && availableSet.has(current)) continue; // explicit override wins
          if (resolvedCkpt === null) resolvedCkpt = this.resolveCheckpoint(models.checkpoints, sessionDir);
          inputs.ckpt_name = resolvedCkpt;
        }
      }
    }

    // 4a.5: checkpoint compatibility validation
    this.validateCheckpointCompatibility(prompt, pkg);

    // 4b: lora_injection (base LoRAs + nsfw LoRAs + dynamic LoRAs + pruning)
    if (features.lora_injection) {
      // baseLoras resolution: session/persona dir overrides global fallback.
      // (Mirrors checkpoint resolution semantics — see resolveCheckpoint.)
      let baseLoras: Array<{ name: string; strength: number }> = [];
      let nsfwLoras: Array<{ name: string; strength: number }> = [];
      // Helper: read `nsfwLoras` from a config preset
      const readNsfwLorasFromConfig = (cfg: Record<string, unknown> | null): Array<{ name: string; strength: number }> => {
        if (!cfg) return [];
        const ap = cfg.active_preset as string | undefined;
        const presets = cfg.presets as Record<string, Record<string, unknown>> | undefined;
        const preset = ap ? presets?.[ap] : undefined;
        const list = preset?.nsfwLoras ?? (cfg as Record<string, unknown>).nsfwLoras;
        return Array.isArray(list) ? list as Array<{ name: string; strength: number }> : [];
      };
      if (sessionDir) {
        const dirConfig = this.readDirConfig(sessionDir);
        if (dirConfig.baseLoras && dirConfig.baseLoras.length > 0) {
          baseLoras = dirConfig.baseLoras;
        }
        // Try to read nsfwLoras from session/persona config
        try {
          const sessionConfigPath = path.join(sessionDir, "comfyui-config.json");
          if (fs.existsSync(sessionConfigPath)) {
            const cfg = JSON.parse(fs.readFileSync(sessionConfigPath, "utf-8"));
            nsfwLoras = readNsfwLorasFromConfig(cfg);
          }
        } catch { /* ignore */ }
      }
      if (baseLoras.length === 0 || nsfwLoras.length === 0) {
        // Fallback to global comfyui-config.json
        try {
          const globalConfigPath = path.join(process.cwd(), "data/tools/comfyui/comfyui-config.json");
          if (fs.existsSync(globalConfigPath)) {
            const globalConfig = JSON.parse(fs.readFileSync(globalConfigPath, "utf-8"));
            const globalPreset = globalConfig.active_preset && globalConfig.presets?.[globalConfig.active_preset];
            const globalLoras = globalPreset?.baseLoras || globalConfig.baseLoras;
            if (baseLoras.length === 0 && Array.isArray(globalLoras) && globalLoras.length > 0) {
              baseLoras = globalLoras;
              console.log(`[comfyui] Using ${baseLoras.length} base LoRAs from global comfyui-config.json (no override in session/persona)`);
            }
            if (nsfwLoras.length === 0) {
              nsfwLoras = readNsfwLorasFromConfig(globalConfig);
            }
          }
        } catch { /* ignore */ }
      }
      // NSFW 자동 주입: params.nsfw === true 면 baseLoras에 nsfwLoras를 결합한다.
      // 이름이 겹치면 후자(nsfwLoras)의 strength로 덮어쓴다.
      if (params.nsfw === true && nsfwLoras.length > 0) {
        const byName = new Map(baseLoras.map(l => [l.name, l]));
        for (const nl of nsfwLoras) byName.set(nl.name, nl);
        baseLoras = Array.from(byName.values());
        console.log(`[comfyui] NSFW mode — appended ${nsfwLoras.length} nsfwLoras (${nsfwLoras.map(l => l.name).join(", ")})`);
      }
      if (baseLoras.length > 0) {
        injectBaseLoRAs(prompt, baseLoras);
      }
      pruneUnavailableLoRAs(prompt, models.loras);
      if (loras && loras.length > 0) {
        applyDynamicLoRAs(prompt, loras, models.loras);
      }
    }

    // 4c: lora_couple_branches
    if (features.lora_couple_branches && (lorasLeft?.length || lorasRight?.length)) {
      injectCoupleBranchLoras(prompt, models.loras, this.loadLoraTriggers(), lorasLeft, lorasRight);
    }

    // 4d: trigger_tags
    if (features.trigger_tags) {
      const triggerTable = this.loadLoraTriggers();
      const activeLoRAs = collectActiveLoRAs(prompt);
      injectTriggerTags(prompt, pkg.meta, triggerTable, activeLoRAs);
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
      processDetailerChain(prompt, pkg.meta.detailer_chain, params, this.loadDetailerModules(), pkg.meta.params);
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
    return getGpuManagerUrl();
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
    const outputFiles = extractOutputFilenames(history);
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
    // Defensive sanitization: ComfyUI iterates every top-level prompt key as
    // a node and calls `node.get('_meta')` / `node['inputs'].items()` — if any
    // value is a non-object (string/number/etc), the server crashes with
    // `'str' object has no attribute 'get'`. Strip such stray metadata keys
    // (e.g. callers accidentally merging `targetScope` into the graph) and
    // log them so the upstream bug stays visible.
    {
      const stray: string[] = [];
      for (const k of Object.keys(prompt)) {
        const v = (prompt as Record<string, unknown>)[k];
        if (v === null || typeof v !== "object" || Array.isArray(v)) {
          stray.push(k);
          delete (prompt as Record<string, unknown>)[k];
        }
      }
      if (stray.length > 0) {
        console.warn(
          `[comfyui] Stripped non-node top-level keys from prompt before submit: ${stray.join(", ")}. ` +
          `These should not be in the prompt graph — fix the caller.`,
        );
      }
    }

    // [DEBUG] dump the prompt sent to ComfyUI for diagnosing missing_node_type errors.
    // Remove once anima-mixed-scene corruption is identified.
    try {
      const dumpDir = path.join(process.cwd(), "data", "tools", "comfyui", "_debug");
      fs.mkdirSync(dumpDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const dumpPath = path.join(dumpDir, `prompt_${stamp}_${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
      fs.writeFileSync(dumpPath, JSON.stringify(prompt, null, 2));
      console.log(`[comfyui-debug] Dumped submitted prompt to ${dumpPath}`);
    } catch (e) {
      console.warn(`[comfyui-debug] Failed to dump prompt: ${(e as Error).message}`);
    }

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
      const audioFiles = extractAudioFilenames(history);
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

      const texts = extractTextOutputs(history);
      const text = texts.join(" ").trim();
      console.log(`[comfyui-stt] Done in ${Date.now() - t0}ms: "${text.substring(0, 80)}..."`);

      return { success: true, text };
    } catch (err) {
      console.error(`[comfyui-stt] Error:`, err);
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
