// ComfyUI 체크포인트 해석 + 호환성 검사. ComfyUIClient에서 추출(Wave 11). this 의존은 파라미터로 주입.
import * as fs from "fs";
import * as path from "path";
import type { WorkflowPackageMeta } from "./workflow-resolver";

/** Read comfyui-config.json from session/persona dir if it exists */
export function readDirConfig(dir: string): { checkpoint?: string; baseLoras?: Array<{ name: string; strength: number }> } {
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

/** Resolve the best available checkpoint name */
export function resolveCheckpoint(availableCheckpoints: string[], checkpointName: string, sessionDir?: string): string {
  // Priority: 1) comfyui-config.json in session/persona dir, 2) global comfyui-config.json,
  //          3) env var, 4) auto-detect
  let configured = checkpointName;

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
    const dirConfig = readDirConfig(sessionDir);
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

export function loadCheckpointRegistry(): Record<string, Record<string, string>> {
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

export function findCompatiblePackages(
  registryEntry: Record<string, string>,
  excludeName: string,
  workflowsDir: string
): string[] {
  if (!fs.existsSync(workflowsDir)) return [];
  const compatible: string[] = [];
  for (const entry of fs.readdirSync(workflowsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === excludeName) continue;
    const paramsPath = path.join(workflowsDir, entry.name, "params.json");
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

export function validateCheckpointCompatibility(
  prompt: Record<string, unknown>,
  pkg: { name: string; meta: WorkflowPackageMeta },
  workflowsDir: string
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

  const registry = loadCheckpointRegistry();
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
      const compatibleList = findCompatiblePackages(entry, pkg.name, workflowsDir);
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
