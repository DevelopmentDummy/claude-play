import * as fs from "fs";
import * as path from "path";
import * as z from "zod/v4";
import { getApiBase } from "@/lib/endpoints";
import { getInternalToken } from "@/lib/auth";
import { getDataDir } from "@/lib/data-dir";
import { longRequest } from "@/lib/long-http";

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

/**
 * 브릿지 내부 API 호출.
 *
 * ⚠️ 전역 fetch가 아니라 node:http(longRequest)를 쓴다. 영상 워크플로는 한 판이
 *    12~40분이고 /api/tools/comfyui/generate는 완료될 때까지 응답 헤더를 보내지 않는데,
 *    undici는 headersTimeout 300초에서 UND_ERR_HEADERS_TIMEOUT으로 끊어버린다
 *    (AbortSignal 타임아웃으로 연장 불가). 자세한 배경은 long-http.ts 주석 참조.
 */
async function bridgeFetch(method: "GET" | "POST", route: string, payload?: unknown): Promise<unknown> {
  const res = await longRequest(`${getApiBase()}${route}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-bridge-token": getInternalToken(),
    },
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  });
  const text = res.text;
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
      "Generate an image OR a video via the bridge's ComfyUI workflow packages. " +
      "Synchronous by default — returns when the file is written. " +
      "The output is saved directly under outputDir (absolute path) and the absolute file path is returned. " +
      "Use comfyui_workflow(list) to discover available workflow packages and their params. " +
      "VIDEO: video packages (minimax-h3-video, wan-i2v, ...) take 1-40 minutes per clip. " +
      "Pass async=true so the call returns immediately, then poll the local filesystem for the output file " +
      "(a <filename>.error.txt appears next to it if the render fails). " +
      "Match the filename extension to the package output format (.mp4 for SaveVideo packages, " +
      ".webp for SaveAnimatedWEBP packages) so the file is playable.",
    inputSchema: {
      outputDir: z.string().describe("Absolute directory path where the generated file is saved"),
      prompt: z.string().optional().describe("Positive prompt (shorthand for params.prompt)"),
      workflow: z.string().optional().describe("Workflow package name (default: active preset's default template)"),
      negative_prompt: z.string().optional(),
      seed: z.number().int().optional(),
      params: z.record(z.string(), z.unknown()).optional().describe("Raw workflow params passed through to the package"),
      filename: z.string().optional().describe("Filename only, e.g. foo.png / clip01.mp4 (default: comfyui_<ts>.png)"),
      async: z
        .boolean()
        .optional()
        .describe(
          "Fire-and-forget mode for long renders (video). Returns { status: 'queued', path } immediately; " +
          "the caller polls for the file. On failure a <filename>.error.txt is written next to it."
        ),
      loras: lorasShape,
      loras_left: lorasShape,
      loras_right: lorasShape,
    },
    handler: async (input) => {
      const outputDir = requireOutputDir(input);
      const params: Record<string, unknown> = {
        ...(input.params && typeof input.params === "object" ? (input.params as Record<string, unknown>) : {}),
      };
      // params.prompt가 우선 — 워크플로 패키지에 맞춰 제대로 써 넣은 프롬프트가
      // 스키마 채우기용 top-level 한 줄로 덮이는 사고를 막는다.
      const prompt = str(input.prompt);
      if (prompt && typeof params.prompt !== "string") params.prompt = prompt;
      if (!params.negative_prompt) params.negative_prompt = str(input.negative_prompt) || COMFY_DEFAULT_NEGATIVE;
      if (typeof input.seed === "number" && Number.isFinite(input.seed)) params.seed = input.seed;
      // prompt 필수 가드는 두지 않는다 — prompt 파라미터 자체가 없는 패키지
      // (zimage-to-video의 base_prompt/motion_prompt, anima-mixed-scene의 subject_tags 등)를
      // 오탐으로 막는다. 필수 여부는 서버측 validateParams가 400 + 누락 파라미터명으로 알려준다.
      const filename = str(input.filename) || `comfyui_${Date.now()}.png`;
      const payload = {
        outputDir,
        workflow: str(input.workflow) || readDefaultWorkflow(),
        params,
        filename,
        loras: input.loras,
        loras_left: input.loras_left,
        loras_right: input.loras_right,
      };

      // 장시간 렌더(영상)용 fire-and-forget. 호출자는 outputDir에 파일이 생기는 것으로 완료를
      // 판정한다 — MCP 클라이언트의 유휴 타임아웃(HTTP 기본 5분)에 걸리지 않기 위한 경로다.
      if (input.async === true) {
        const predicted = path.join(outputDir, filename);
        // 이전 실행이 남긴 에러 마커를 먼저 지운다 — 남아 있으면 이번 렌더가 성공해도
        // 폴링하는 호출자가 실패로 오판한다. 산출물 자체는 지우지 않는다(실패 시 손실 방지).
        try {
          fs.rmSync(`${predicted}.error.txt`, { force: true });
        } catch {
          /* 무시 */
        }
        bridgeFetch("POST", "/api/tools/comfyui/generate", payload).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[external-mcp] async comfyui_generate failed for ${filename}: ${message}`);
          try {
            fs.mkdirSync(path.dirname(predicted), { recursive: true });
            fs.writeFileSync(`${predicted}.error.txt`, `${new Date().toISOString()}
${message}
`, "utf-8");
          } catch {
            /* 에러 파일 기록 실패는 무시 — 서버 로그에는 이미 남았다 */
          }
        });
        return { status: "queued", path: predicted, async: true };
      }

      return bridgeFetch("POST", "/api/tools/comfyui/generate", payload);
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
