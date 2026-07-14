import * as fs from "fs";
import * as path from "path";
import * as z from "zod/v4";
import { getApiBase } from "@/lib/endpoints";
import { getInternalToken } from "@/lib/auth";
import { getDataDir } from "@/lib/data-dir";

/**
 * 외부 MCP(/mcp/external)에 노출하는 툴 레지스트리.
 * 새 기능(TTS/STT 등)은 여기에 항목을 추가하면 자동 노출된다.
 * 정책: 세션/정책/오케스트레이션 툴(fire_ai, run_tool, policy_* 등)은 노출 금지.
 */
export interface ExternalToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (input: Record<string, unknown>) => Promise<unknown>;
}

const COMFY_DEFAULT_NEGATIVE =
  "bad quality, worst quality, worst detail, sketch, censored, watermark, signature, extra fingers, mutated hands, bad anatomy";

async function bridgeFetch(method: "GET" | "POST", route: string, payload?: unknown): Promise<unknown> {
  const res = await fetch(`${getApiBase()}${route}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-bridge-token": getInternalToken(),
    },
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) {
    const message =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return data;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function requireOutputDir(input: Record<string, unknown>): string {
  const dir = str(input.outputDir);
  if (!dir) throw new Error("outputDir is required (absolute path where the image will be saved)");
  if (!path.isAbsolute(dir)) throw new Error("outputDir must be an absolute path");
  return dir;
}

function workflowsDir(): string {
  return path.join(getDataDir(), "tools", "comfyui", "skills", "generate-image", "workflows");
}

/** 전역 comfyui-config.json의 active preset에서 기본 워크플로 결정 (없으면 portrait) */
function readDefaultWorkflow(): string {
  try {
    const configPath = path.join(getDataDir(), "tools", "comfyui", "comfyui-config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
      active_preset?: string;
      default_template?: string;
      presets?: Record<string, { default_template?: string }>;
    };
    const preset = config.active_preset ? config.presets?.[config.active_preset] : undefined;
    return preset?.default_template || config.default_template || "portrait";
  } catch {
    return "portrait";
  }
}

const lorasShape = z
  .array(z.object({ name: z.string(), strength: z.number().min(-5).max(5) }))
  .optional();

export const EXTERNAL_TOOLS: ExternalToolDef[] = [
  {
    name: "comfyui_generate",
    description:
      "Generate an image via the bridge's ComfyUI workflow packages. Synchronous — returns when the file is written. " +
      "The image is saved directly under outputDir (absolute path) and the absolute file path is returned. " +
      "Use comfyui_workflow(list) to discover available workflow packages and their params.",
    inputSchema: {
      outputDir: z.string().describe("Absolute directory path where the generated image is saved"),
      prompt: z.string().optional().describe("Positive prompt (shorthand for params.prompt)"),
      workflow: z.string().optional().describe("Workflow package name (default: active preset's default template)"),
      negative_prompt: z.string().optional(),
      seed: z.number().int().optional(),
      params: z.record(z.string(), z.unknown()).optional().describe("Raw workflow params passed through to the package"),
      filename: z.string().optional().describe("Filename only, e.g. foo.png (default: comfyui_<ts>.png)"),
      loras: lorasShape,
      loras_left: lorasShape,
      loras_right: lorasShape,
    },
    handler: async (input) => {
      const outputDir = requireOutputDir(input);
      const params: Record<string, unknown> = {
        ...(input.params && typeof input.params === "object" ? (input.params as Record<string, unknown>) : {}),
      };
      const prompt = str(input.prompt);
      if (prompt) params.prompt = prompt;
      if (!params.negative_prompt) params.negative_prompt = str(input.negative_prompt) || COMFY_DEFAULT_NEGATIVE;
      if (typeof input.seed === "number" && Number.isFinite(input.seed)) params.seed = input.seed;
      if (typeof params.prompt !== "string" || !params.prompt.trim()) {
        throw new Error("prompt (or params.prompt) is required");
      }
      return bridgeFetch("POST", "/api/tools/comfyui/generate", {
        outputDir,
        workflow: str(input.workflow) || readDefaultWorkflow(),
        params,
        filename: str(input.filename) || `comfyui_${Date.now()}.png`,
        loras: input.loras,
        loras_left: input.loras_left,
        loras_right: input.loras_right,
      });
    },
  },
  {
    name: "generate_image_openai",
    description:
      "Generate or edit an image via the OpenAI/GPT backend (strong text rendering; edit via reference_image). " +
      "Synchronous — waits for completion. Saves directly under outputDir and returns the absolute file path.",
    inputSchema: {
      outputDir: z.string().describe("Absolute directory path where the generated image is saved"),
      prompt: z.string().min(1),
      filename: z.string().optional().describe("Filename only (default: openai_<ts>.png)"),
      reference_image: z.string().optional().describe("Reference image path relative to outputDir (or absolute)"),
      size: z.string().optional().describe("1024x1024, 1536x1024, 1024x1536, auto"),
      quality: z.string().optional().describe("low, medium, high, auto"),
    },
    handler: async (input) => {
      const outputDir = requireOutputDir(input);
      return bridgeFetch("POST", "/api/tools/openai/generate", {
        outputDir,
        prompt: String(input.prompt),
        filename: str(input.filename) || `openai_${Date.now()}.png`,
        referenceImage: str(input.reference_image) || undefined,
        size: str(input.size) || undefined,
        quality: str(input.quality) || undefined,
      });
    },
  },
  {
    name: "generate_image_gemini",
    description:
      "Generate an image via the Gemini image API. Synchronous — waits for completion. " +
      "Saves directly under outputDir and returns the absolute file path.",
    inputSchema: {
      outputDir: z.string().describe("Absolute directory path where the generated image is saved"),
      prompt: z.string().min(1),
      filename: z.string().optional().describe("Filename only (default: gemini_<ts>.png)"),
      reference_image: z.union([z.string(), z.array(z.string())]).optional()
        .describe("Reference image path(s) relative to outputDir (or absolute)"),
      aspect_ratio: z.string().optional().describe("1:1, 16:9, 4:3, 3:2, 2:3, 9:16"),
      image_size: z.string().optional().describe("512, 1K, 2K, 4K"),
    },
    handler: async (input) => {
      const outputDir = requireOutputDir(input);
      return bridgeFetch("POST", "/api/tools/gemini/generate", {
        outputDir,
        prompt: String(input.prompt),
        filename: str(input.filename) || `gemini_${Date.now()}.png`,
        referenceImage: input.reference_image,
        aspectRatio: str(input.aspect_ratio) || undefined,
        imageSize: str(input.image_size) || undefined,
      });
    },
  },
  {
    name: "comfyui_health",
    description: "Check ComfyUI / GPU manager connectivity and status.",
    inputSchema: {},
    handler: () => bridgeFetch("GET", "/api/tools/comfyui/health"),
  },
  {
    name: "comfyui_models",
    description: "List available ComfyUI checkpoints, LoRAs and other models.",
    inputSchema: {},
    handler: () => bridgeFetch("GET", "/api/tools/comfyui/models"),
  },
  {
    name: "comfyui_workflow",
    description:
      "Inspect ComfyUI workflow packages (read-only: list/get). Each package = workflow.json + params.json + optional resolver.mjs.",
    inputSchema: {
      action: z.enum(["list", "get"]),
      name: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional().describe("Package name (required for get)"),
    },
    handler: async (input) => {
      const action = input.action;
      const dir = workflowsDir();
      if (action === "list") {
        const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
        const results: unknown[] = [];
        for (const entry of entries) {
          const paramsPath = path.join(dir, entry.name, "params.json");
          if (!fs.existsSync(paramsPath)) continue;
          try {
            const meta = JSON.parse(fs.readFileSync(paramsPath, "utf-8")) as {
              description?: string;
              params?: Record<string, { type?: string; required?: boolean; description?: string }>;
            };
            const paramSummary: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(meta.params || {})) {
              paramSummary[key] = { type: value.type, required: value.required, description: value.description };
            }
            results.push({
              name: entry.name,
              description: meta.description || null,
              params: paramSummary,
              hasResolver: fs.existsSync(path.join(dir, entry.name, "resolver.mjs")),
            });
          } catch {
            /* malformed package — skip */
          }
        }
        return results;
      }
      const name = str(input.name);
      if (!name) throw new Error("name is required for get");
      const pkgDir = path.join(dir, name);
      if (!fs.existsSync(pkgDir)) throw new Error(`Package "${name}" not found`);
      const read = (file: string): unknown => {
        const p = path.join(pkgDir, file);
        return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf-8")) : null;
      };
      const resolverPath = path.join(pkgDir, "resolver.mjs");
      return {
        name,
        workflow: read("workflow.json"),
        params: read("params.json"),
        resolver: fs.existsSync(resolverPath) ? fs.readFileSync(resolverPath, "utf-8") : null,
      };
    },
  },
];
