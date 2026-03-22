#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "node:fs";
import path from "node:path";
import * as z from "zod/v4";

const apiBase = (process.env.CLAUDE_BRIDGE_API_BASE || `http://127.0.0.1:${process.env.PORT || "3340"}`)
  .replace(/\/+$/, "");
const mode = process.env.CLAUDE_BRIDGE_MODE || "session";
const persona = process.env.CLAUDE_BRIDGE_PERSONA || "";
const sessionDir = process.env.CLAUDE_BRIDGE_SESSION_DIR || process.cwd();
const sessionId = mode === "session" ? path.basename(sessionDir) : "";
const authToken = process.env.CLAUDE_BRIDGE_AUTH_TOKEN || "";
const POLICY_REVIEW_LOG_FILE = "policy-review.log";
const HARD_DENY_PATTERNS = [
];
const UNCERTAIN_PATTERNS = [
];
const MODERATE_INTIMACY_PATTERNS = [
  /\b(kiss|kissing|hug|embrace|flirt|romance|intimate scene|sensual)\b/i,
  /\b(키스|입맞춤|포옹|애무|친밀한|로맨스|스킨십|성적인 긴장감)\b/,
];
const FICTION_CUES = [
  /\b(roleplay|rp|fiction|in-world|character)\b/i,
  /\b(story|scene|narrative)\b/i,
];
const COMFY_DEFAULT_QUALITY = "masterpiece, best quality, amazing quality, absurdres";
const COMFY_DEFAULT_NEGATIVE =
  "bad quality, worst quality, worst detail, sketch, censored, watermark, signature, extra fingers, mutated hands, bad anatomy";
const COMFY_DEFAULT_TEMPLATE = "portrait";

const server = new McpServer({
  name: "claude-bridge",
  version: "0.1.0",
});

function asText(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function ok(value) {
  return {
    content: [{ type: "text", text: asText(value) }],
  };
}

function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: `Error: ${message}` }],
  };
}

function withPersona(payload) {
  if (!payload || typeof payload !== "object") return payload;
  if (mode === "builder" && persona && !("persona" in payload)) {
    return { ...payload, persona };
  }
  if (mode === "session" && sessionId && !("sessionId" in payload)) {
    return { ...payload, sessionId };
  }
  return payload;
}

function pickString(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Track filenames requested in this session to detect same-turn collisions.
 * Intentional overwrites (e.g. standing_portrait.png across turns) are allowed —
 * only duplicate names within a single AI turn (rapid successive calls) are deduped.
 */
const _pendingImageNames = new Set();

function deduplicateImageFilename(name) {
  if (!name || !sessionDir) return name;
  // First time this name is used → allow it (may intentionally overwrite an older file)
  if (!_pendingImageNames.has(name)) {
    _pendingImageNames.add(name);
    // Auto-clear after 30s — by then the turn is long done
    setTimeout(() => _pendingImageNames.delete(name), 30_000);
    return name;
  }
  // Same name requested again while still pending → collision within same turn
  const imagesDir = path.join(sessionDir, "images");
  const ext = path.extname(name);
  const base = name.slice(0, ext.length ? -ext.length : undefined);
  let counter = 2;
  let candidate = `${base}_${counter}${ext}`;
  while (_pendingImageNames.has(candidate) || fs.existsSync(path.join(imagesDir, candidate))) {
    counter++;
    candidate = `${base}_${counter}${ext}`;
  }
  _pendingImageNames.add(candidate);
  setTimeout(() => _pendingImageNames.delete(candidate), 30_000);
  return candidate;
}

function buildComfyPrompt(prompt, useDefaults = true) {
  const body = pickString(prompt);
  if (!body) return "";
  if (!useDefaults) return body;

  const config = readComfyConfig();
  const preset = getActivePreset(config);
  const quality = preset?.quality_tags || config?.style?.quality_tags || COMFY_DEFAULT_QUALITY;
  const style = preset?.style_tags || config?.style?.style_tags || "";

  // quality + style + user prompt. Trigger tags are auto-injected by the server based on active LoRAs.
  const parts = [quality, style, body].filter(s => s.trim());
  return parts.join(", ");
}

function readComfyConfig() {
  // Try session-level config first
  const sessionConfigPath = path.join(sessionDir, "comfyui-config.json");
  if (fs.existsSync(sessionConfigPath)) {
    try {
      return JSON.parse(fs.readFileSync(sessionConfigPath, "utf-8"));
    } catch { /* fall through */ }
  }
  // Fallback to global config (data/tools/comfyui/comfyui-config.json)
  // sessionDir is data/sessions/{name}/, so ../../tools/comfyui/
  const globalConfigPath = path.join(sessionDir, "..", "..", "tools", "comfyui", "comfyui-config.json");
  if (fs.existsSync(globalConfigPath)) {
    try {
      return JSON.parse(fs.readFileSync(globalConfigPath, "utf-8"));
    } catch { /* ignore */ }
  }
  return null;
}

function getActivePreset(config) {
  if (!config?.presets || !config?.active_preset) return null;
  return config.presets[config.active_preset] || null;
}

function getComfyNegative(userNegative) {
  if (userNegative) return userNegative;
  const config = readComfyConfig();
  const preset = getActivePreset(config);
  if (preset?.negative) return preset.negative;
  if (config?.style?.negative) return config.style.negative;
  return COMFY_DEFAULT_NEGATIVE;
}

function readPolicyContext() {
  const policyPath = path.join(sessionDir, "policy-context.json");
  if (!fs.existsSync(policyPath)) {
    return {
      source: null,
      extreme_traits: [],
      reviewed_scenarios: [],
      intimacy_policy: {
        allow_moderate_intimacy: true,
        allow_explicit: false,
        max_intensity: "moderate",
      },
      notes: "",
    };
  }

  try {
    const raw = fs.readFileSync(policyPath, "utf-8");
    const parsed = JSON.parse(raw);
    const extreme_traits = Array.isArray(parsed?.extreme_traits)
      ? parsed.extreme_traits.filter((v) => typeof v === "string")
      : [];
    const reviewed_scenarios = Array.isArray(parsed?.reviewed_scenarios)
      ? parsed.reviewed_scenarios.filter((v) => typeof v === "string")
      : [];
    const intimacy_policy = {
      allow_moderate_intimacy:
        parsed?.intimacy_policy?.allow_moderate_intimacy !== false,
      allow_explicit:
        parsed?.intimacy_policy?.allow_explicit === true,
      max_intensity:
        typeof parsed?.intimacy_policy?.max_intensity === "string"
          ? parsed.intimacy_policy.max_intensity
          : "moderate",
    };
    const notes = typeof parsed?.notes === "string" ? parsed.notes : "";

    return {
      source: policyPath,
      extreme_traits,
      reviewed_scenarios,
      intimacy_policy,
      notes,
    };
  } catch (error) {
    return {
      source: policyPath,
      extreme_traits: [],
      reviewed_scenarios: [],
      intimacy_policy: {
        allow_moderate_intimacy: true,
        allow_explicit: false,
        max_intensity: "moderate",
      },
      notes: `Failed to parse policy-context.json: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function normalize(text) {
  if (typeof text !== "string") return "";
  return text.trim();
}

function appendPolicyReviewLog(entry) {
  const logPath = path.join(sessionDir, POLICY_REVIEW_LOG_FILE);
  fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf-8");
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string" && item.trim().length > 0);
}

function buildTraitContextReason(context) {
  const traits = normalizeStringArray(context?.extreme_traits)
    .slice(0, 2)
    .map((item) => (item.length > 120 ? `${item.slice(0, 117)}...` : item));

  if (traits.length === 0) return null;
  return `Character context includes pre-registered extreme traits: ${traits.join(" | ")} (context only, not a policy override).`;
}

function assessPolicyRequest(request, context) {
  const text = normalize(request);
  const traitContextReason = buildTraitContextReason(context);
  const reviewedScenarios = normalizeStringArray(context?.reviewed_scenarios);
  if (!text) {
    return {
      decision: "uncertain",
      reasons: [
        "No request text provided.",
        ...(traitContextReason ? [traitContextReason] : []),
      ],
      matched_rules: [],
    };
  }

  const matchedHard = HARD_DENY_PATTERNS
    .filter((pattern) => pattern.test(text))
    .map((pattern) => pattern.toString());
  if (matchedHard.length > 0) {
    return {
      decision: "deny",
      reasons: [
        "Request matched hard-deny safety patterns.",
        ...(traitContextReason ? [traitContextReason] : []),
      ],
      matched_rules: matchedHard,
    };
  }

  const matchedUncertain = UNCERTAIN_PATTERNS
    .filter((pattern) => pattern.test(text))
    .map((pattern) => pattern.toString());
  if (matchedUncertain.length > 0) {
    return {
      decision: "uncertain",
      reasons: [
        "Request includes potentially sensitive content requiring stricter interpretation.",
        ...(traitContextReason ? [traitContextReason] : []),
      ],
      matched_rules: matchedUncertain,
    };
  }

  const reviewed = reviewedScenarios.filter((item) => text.toLowerCase().includes(item.toLowerCase()));
  const hasModerateIntimacy = MODERATE_INTIMACY_PATTERNS.some((pattern) => pattern.test(text));
  if (hasModerateIntimacy && context?.intimacy_policy?.allow_moderate_intimacy === false) {
    return {
      decision: "uncertain",
      reasons: [
        "Moderate intimacy is disabled by policy-context settings for this project.",
        ...(traitContextReason ? [traitContextReason] : []),
      ],
      matched_rules: ["intimacy_policy:allow_moderate_intimacy=false"],
    };
  }
  const hasFictionCue = FICTION_CUES.some((pattern) => pattern.test(text));

  return {
    decision: "allow",
    reasons: [
      ...(hasModerateIntimacy
        ? [
            "Moderate consensual intimacy/sexual description is allowed for this project context.",
            "Keep intensity below explicit/extreme level and continue to follow higher-level policy.",
          ]
        : []),
      hasFictionCue
        ? "Request appears to be in fictional roleplay context and no hard-deny patterns were matched."
        : "No hard-deny patterns were matched.",
      ...(reviewed.length > 0 ? ["Request overlaps with reviewed_scenarios context entries."] : []),
      ...(traitContextReason ? [traitContextReason] : []),
    ],
    matched_rules: reviewed.map((item) => `reviewed_scenario:${item}`),
  };
}

async function requestJson(method, route, payload) {
  const url = `${apiBase}${route}`;
  const headers = { "Content-Type": "application/json" };
  if (authToken) {
    headers["x-bridge-token"] = authToken;
  }
  const response = await fetch(url, {
    method,
    headers,
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const details = typeof data === "object" && data && "error" in data
      ? data.error
      : data;
    throw new Error(`${method} ${route} failed (${response.status}): ${asText(details)}`);
  }

  return data;
}

server.registerTool(
  "bridge_status",
  {
    description: "Show Claude Bridge MCP runtime configuration.",
    inputSchema: {},
  },
  async () => {
    return ok({ apiBase, mode, persona: persona || null, sessionDir });
  }
);

server.registerTool(
  "comfyui_models",
  {
    description: "List available ComfyUI checkpoints/models through Claude Bridge API.",
    inputSchema: {},
  },
  async () => {
    try {
      const data = await requestJson("GET", "/api/tools/comfyui/models");
      return ok(data);
    } catch (error) {
      return fail(error);
    }
  }
);

server.registerTool(
  "comfyui_generate",
  {
    description:
      "Queue image generation via ComfyUI. Backward-compatible: prompt-only mode is supported (defaults to portrait workflow + legacy quality/trigger tags).",
    inputSchema: {
      workflow: z.string().optional(),
      template: z.enum(["portrait", "scene", "scene-real", "scene-couple", "profile"]).optional(),
      prompt: z.string().optional(),
      negative_prompt: z.string().optional(),
      seed: z.number().int().optional(),
      use_defaults: z.boolean().optional(),
      params: z.record(z.string(), z.unknown()).optional(),
      raw: z.record(z.string(), z.unknown()).optional(),
      filename: z.string().min(1).optional(),
      extraFiles: z.record(z.string(), z.string()).optional(),
      loras: z.array(z.object({
        name: z.string(),
        strength: z.number().min(-5).max(5),
      })).optional(),
      loras_left: z.array(z.object({
        name: z.string(),
        strength: z.number().min(-5).max(5),
      })).optional(),
      loras_right: z.array(z.object({
        name: z.string(),
        strength: z.number().min(-5).max(5),
      })).optional(),
      persona: z.string().optional(),
    },
  },
  async (input) => {
    try {
      if (!input.workflow && !input.raw && !input.template && !input.prompt) {
        throw new Error(
          "comfyui_generate requires one of: raw, workflow/template, or prompt (legacy-compatible mode)."
        );
      }

      const config = readComfyConfig();
      const preset = getActivePreset(config);
      const defaultTemplate = preset?.default_template || COMFY_DEFAULT_TEMPLATE;
      const workflow = pickString(input.workflow) || pickString(input.template) || defaultTemplate;
      const useDefaults = input.use_defaults !== false;
      const explicitPrompt = pickString(input.prompt);
      const filename = deduplicateImageFilename(pickString(input.filename) || `comfyui_${Date.now()}.png`);
      const params = { ...(input.params || {}) };

      if (explicitPrompt) {
        params.prompt = buildComfyPrompt(explicitPrompt, useDefaults);
      } else if (typeof params.prompt === "string") {
        params.prompt = buildComfyPrompt(params.prompt, useDefaults);
      }

      if (!params.negative_prompt) {
        params.negative_prompt = getComfyNegative(input.negative_prompt);
      }

      if (typeof input.seed === "number" && Number.isFinite(input.seed)) {
        params.seed = input.seed;
      }

      if (!input.raw && (!params.prompt || typeof params.prompt !== "string" || !params.prompt.trim())) {
        throw new Error("Missing prompt. Provide input.prompt or params.prompt for workflow/template mode.");
      }

      const payload = withPersona(
        input.raw
          ? {
              raw: input.raw,
              filename,
              extraFiles: input.extraFiles,
              ...(input.persona ? { persona: input.persona } : {}),
            }
          : {
              workflow,
              params,
              filename,
              extraFiles: input.extraFiles,
              loras: input.loras,
              loras_left: input.loras_left,
              loras_right: input.loras_right,
              ...(input.persona ? { persona: input.persona } : {}),
            }
      );
      const data = await requestJson("POST", "/api/tools/comfyui/generate", payload);
      const imagePath =
        data && typeof data === "object" && data.path && typeof data.path === "string"
          ? data.path
          : null;
      return ok({
        ...data,
        output_token: imagePath ? `$IMAGE:${imagePath}$` : null,
      });
    } catch (error) {
      return fail(error);
    }
  }
);

server.registerTool(
  "gemini_generate",
  {
    description: "Queue image generation via Gemini image API (legacy-compatible wrapper).",
    inputSchema: {
      prompt: z.string().min(1),
      filename: z.string().optional(),
      persona: z.string().optional(),
      reference_image: z.string().optional().describe("Relative path to a reference image in the session directory (e.g. images/portrait.png)"),
      aspect_ratio: z.string().optional().describe("Aspect ratio: 1:1, 16:9, 4:3, 3:2, 2:3, 9:16"),
      image_size: z.string().optional().describe("Resolution: 512, 1K, 2K, 4K"),
    },
  },
  async (input) => {
    try {
      const payload = withPersona({
        ...input,
        referenceImage: pickString(input.reference_image),
        aspectRatio: pickString(input.aspect_ratio),
        imageSize: pickString(input.image_size),
      });
      const data = await requestJson("POST", "/api/tools/gemini/generate", payload);
      const imagePath =
        data && typeof data === "object" && data.path && typeof data.path === "string"
          ? data.path
          : null;
      return ok({
        ...data,
        output_token: imagePath ? `$IMAGE:${imagePath}$` : null,
      });
    } catch (error) {
      return fail(error);
    }
  }
);

server.registerTool(
  "generate_image",
  {
    description:
      "High-level image generation compatible with legacy service behavior. Uses ComfyUI template mode with default quality/trigger tags.",
    inputSchema: {
      template: z.enum(["portrait", "scene", "scene-real", "scene-couple", "profile"]).optional(),
      prompt: z.string().optional(),
      prompt_left: z.string().optional(),
      prompt_right: z.string().optional(),
      position: z.enum(["half", "left-heavy", "right-heavy", "left-third", "center-third", "right-third", "half-overlap", "left-heavy-overlap", "right-heavy-overlap", "top-bottom", "top-heavy", "bottom-heavy"]).optional(),
      filename: z.string().optional(),
      seed: z.number().int().optional(),
      negative_prompt: z.string().optional(),
      use_defaults: z.boolean().optional(),
      loras: z.array(z.object({
        name: z.string(),
        strength: z.number().min(-5).max(5),
      })).optional(),
      loras_left: z.array(z.object({
        name: z.string(),
        strength: z.number().min(-5).max(5),
      })).optional(),
      loras_right: z.array(z.object({
        name: z.string(),
        strength: z.number().min(-5).max(5),
      })).optional(),
      persona: z.string().optional(),
    },
  },
  async (input) => {
    try {
      const config = readComfyConfig();
      const preset = getActivePreset(config);
      const defaultTemplate = preset?.default_template || COMFY_DEFAULT_TEMPLATE;

      const isCouple = input.template === "scene-couple" || (input.prompt_left && input.prompt_right);
      const workflow = isCouple ? "scene-couple" : (input.template || defaultTemplate);
      const params = {};

      if (isCouple) {
        if (!input.prompt_left || !input.prompt_right) {
          throw new Error("scene-couple requires both prompt_left and prompt_right.");
        }
        params.prompt_left = buildComfyPrompt(input.prompt_left, input.use_defaults !== false);
        params.prompt_right = buildComfyPrompt(input.prompt_right, input.use_defaults !== false);

        // Position presets: compute mask geometry for 1216x832
        const w = 1216;
        const h = 832;
        const position = input.position || "half";

        // Presets: { rw: region width, rh: region height, rx: right x, ry_l: left y, ry_r: right y }
        // Overlap variants use wider regions so masks overlap in the center (soft blend via Attention Couple normalization)
        const presets = {
          // Horizontal splits
          "half":                { rw: Math.round(w * 0.5),  rh: h, rx: Math.round(w * 0.5),  ry_l: 0, ry_r: 0 },
          "left-heavy":          { rw: Math.round(w * 0.6),  rh: h, rx: Math.round(w * 0.4),  ry_l: 0, ry_r: 0 },
          "right-heavy":         { rw: Math.round(w * 0.6),  rh: h, rx: Math.round(w * 0.6),  ry_l: 0, ry_r: 0 },
          "left-third":          { rw: Math.round(w * 0.33), rh: h, rx: Math.round(w * 0.67), ry_l: 0, ry_r: 0 },
          "center-third":        { rw: Math.round(w * 0.33), rh: h, rx: Math.round(w * 0.33), ry_l: 0, ry_r: 0 },
          "right-third":         { rw: Math.round(w * 0.33), rh: h, rx: Math.round(w * 0.33), ry_l: 0, ry_r: 0 },
          // Overlap variants (regions ~65% each, ~30% center overlap for soft blend)
          "half-overlap":        { rw: Math.round(w * 0.65), rh: h, rx: Math.round(w * 0.35), ry_l: 0, ry_r: 0 },
          "left-heavy-overlap":  { rw: Math.round(w * 0.7),  rh: h, rx: Math.round(w * 0.35), ry_l: 0, ry_r: 0 },
          "right-heavy-overlap": { rw: Math.round(w * 0.7),  rh: h, rx: Math.round(w * 0.65), ry_l: 0, ry_r: 0 },
          // Vertical splits (top = "left" prompt, bottom = "right" prompt)
          "top-bottom":          { rw: w, rh: Math.round(h * 0.5),  rx: 0, ry_l: 0, ry_r: Math.round(h * 0.5) },
          "top-heavy":           { rw: w, rh: Math.round(h * 0.6),  rx: 0, ry_l: 0, ry_r: Math.round(h * 0.4) },
          "bottom-heavy":        { rw: w, rh: Math.round(h * 0.6),  rx: 0, ry_l: Math.round(h * 0.4), ry_r: 0 },
        };
        const p = presets[position];
        params.mask_base_width = w;
        params.mask_base_height = h;
        params.mask_region_width = p.rw;
        params.mask_region_height = p.rh;
        params.mask_right_x = p.rx;
        params.mask_left_y = p.ry_l;
        params.mask_right_y = p.ry_r;

        // Auto-inject positioning tags based on position preset
        const positionTags = {
          // Horizontal: left/right placement
          "half":                { left: "on the left",  right: "on the right" },
          "left-heavy":          { left: "on the left",  right: "on the right" },
          "right-heavy":         { left: "on the left",  right: "on the right" },
          "left-third":          { left: "on the left",  right: "on the right, center" },
          "center-third":        { left: "on the left, center", right: "on the right, center" },
          "right-third":         { left: "on the left, center", right: "on the right" },
          // Overlap: same as horizontal but with facing cues
          "half-overlap":        { left: "on the left, facing right",  right: "on the right, facing left" },
          "left-heavy-overlap":  { left: "on the left, leaning right", right: "on the right, facing left" },
          "right-heavy-overlap": { left: "on the left, facing right",  right: "on the right, leaning left" },
          // Vertical: top/bottom placement
          "top-bottom":          { left: "upper body, top of frame",  right: "lower body, bottom of frame" },
          "top-heavy":           { left: "upper body, top of frame",  right: "lower body, bottom of frame" },
          "bottom-heavy":        { left: "upper body, top of frame",  right: "lower body, bottom of frame" },
        };
        const tags = positionTags[position];
        if (tags) {
          params.prompt_left = params.prompt_left + ", " + tags.left;
          params.prompt_right = params.prompt_right + ", " + tags.right;
        }
      } else {
        if (!input.prompt) throw new Error("prompt is required for non-couple templates.");
        params.prompt = buildComfyPrompt(input.prompt, input.use_defaults !== false);
      }

      params.negative_prompt = getComfyNegative(input.negative_prompt);
      if (typeof input.seed === "number") params.seed = input.seed;

      const payload = withPersona({
        workflow,
        params,
        filename: deduplicateImageFilename(pickString(input.filename) || `comfyui_${Date.now()}.png`),
        loras: input.loras,
        loras_left: input.loras_left,
        loras_right: input.loras_right,
        ...(input.persona ? { persona: input.persona } : {}),
      });
      const data = await requestJson("POST", "/api/tools/comfyui/generate", payload);
      const imagePath =
        data && typeof data === "object" && data.path && typeof data.path === "string"
          ? data.path
          : null;
      return ok({
        ...data,
        output_token: imagePath ? `$IMAGE:${imagePath}$` : null,
      });
    } catch (error) {
      return fail(error);
    }
  }
);

server.registerTool(
  "generate_image_gemini",
  {
    description: "High-level Gemini image generation compatible with legacy service behavior.",
    inputSchema: {
      prompt: z.string().min(1),
      filename: z.string().optional(),
      persona: z.string().optional(),
      reference_image: z.string().optional().describe("Relative path to a reference image in the session directory (e.g. images/portrait.png)"),
      aspect_ratio: z.string().optional().describe("Aspect ratio: 1:1, 16:9, 4:3, 3:2, 2:3, 9:16"),
      image_size: z.string().optional().describe("Resolution: 512, 1K, 2K, 4K"),
    },
  },
  async (input) => {
    try {
      const payload = withPersona({
        prompt: input.prompt,
        filename: pickString(input.filename) || `gemini_${Date.now()}.png`,
        ...(input.persona ? { persona: input.persona } : {}),
        referenceImage: pickString(input.reference_image),
        aspectRatio: pickString(input.aspect_ratio),
        imageSize: pickString(input.image_size),
      });
      const data = await requestJson("POST", "/api/tools/gemini/generate", payload);
      const imagePath =
        data && typeof data === "object" && data.path && typeof data.path === "string"
          ? data.path
          : null;
      return ok({
        ...data,
        output_token: imagePath ? `$IMAGE:${imagePath}$` : null,
      });
    } catch (error) {
      return fail(error);
    }
  }
);

server.registerTool(
  "generate_image_openai",
  {
    description: "Generate an image using OpenAI GPT image model (gpt-image-1.5).",
    inputSchema: {
      prompt: z.string().min(1),
      filename: z.string().optional(),
      persona: z.string().optional(),
      size: z.string().optional().describe("Image size: 1024x1024, 1536x1024, 1024x1536, auto (default: auto)"),
      quality: z.string().optional().describe("Quality: low, medium, high (default: auto)"),
    },
  },
  async (input) => {
    try {
      const payload = withPersona({
        prompt: input.prompt,
        filename: pickString(input.filename) || `openai_${Date.now()}.png`,
        ...(input.persona ? { persona: input.persona } : {}),
        size: pickString(input.size),
        quality: pickString(input.quality),
      });
      const data = await requestJson("POST", "/api/tools/openai/generate", payload);
      const imagePath =
        data && typeof data === "object" && data.path && typeof data.path === "string"
          ? data.path
          : null;
      return ok({
        ...data,
        output_token: imagePath ? `$IMAGE:${imagePath}$` : null,
      });
    } catch (error) {
      return fail(error);
    }
  }
);

server.registerTool(
  "update_profile",
  {
    description:
      "Update the persona's profile image. If crop coordinates are omitted, opens an interactive " +
      "crop modal for the user to select the portrait area. If crop is provided, crops directly. " +
      "After cropping, auto-generates a face-cropped icon (256x256) and syncs to persona directory.",
    inputSchema: {
      sourceImage: z.string().min(1).describe(
        "Relative path within session, e.g. 'images/mira-walk-flustered-202.png'"
      ),
      crop: z.object({
        x: z.number().describe("Crop start X in source image pixels"),
        y: z.number().describe("Crop start Y in source image pixels"),
        width: z.number().describe("Crop width in pixels"),
        height: z.number().describe("Crop height in pixels"),
      }).optional().describe(
        "Crop coordinates. If omitted, an interactive crop modal opens for the user."
      ),
    },
  },
  async (input) => {
    try {
      const payload = withPersona({ sourceImage: input.sourceImage });
      if (input.crop) payload.crop = input.crop;
      const data = await requestJson("POST", "/api/tools/comfyui/update-profile", payload);
      return ok(data);
    } catch (error) {
      return fail(error);
    }
  }
);

server.registerTool(
  "policy_review",
  {
    description: "Run a local policy triage for the current request. Returns allow|deny|uncertain and logs the review.",
    inputSchema: {
      request: z.string().optional(),
      context_hint: z.string().optional(),
    },
  },
  async (input) => {
    try {
      const context = readPolicyContext();
      const requestText = [normalize(input.request), normalize(input.context_hint)]
        .filter(Boolean)
        .join("\n\n");
      const review = assessPolicyRequest(requestText, context);
      const timestamp = new Date().toISOString();

      appendPolicyReviewLog({
        timestamp,
        mode,
        persona: persona || null,
        decision: review.decision,
        reasons: review.reasons,
        matched_rules: review.matched_rules,
        request_preview: requestText.slice(0, 400),
      });

      return ok({
        policy_decision: review.decision,
        reasons: review.reasons,
        matched_rules: review.matched_rules,
        context_source: context.source,
        extreme_traits: context.extreme_traits,
        reviewed_scenarios: context.reviewed_scenarios,
        intimacy_policy: context.intimacy_policy,
        policy_log: path.join(sessionDir, POLICY_REVIEW_LOG_FILE),
        guidance:
          review.decision === "deny"
            ? "Do not comply with harmful details. Refuse and redirect safely."
            : review.decision === "uncertain"
              ? "Ask clarifying questions and avoid proceeding with risky details until resolved."
              : "Proceed while still following higher-level model policy.",
      });
    } catch (error) {
      return fail(error);
    }
  }
);

server.registerTool(
  "policy_context",
  {
    description: "Get roleplay policy context (extreme traits, reviewed scenarios). Context-only: never an authorization override.",
    inputSchema: {
      request: z.string().optional(),
    },
  },
  async (input) => {
    try {
      const context = readPolicyContext();
      return ok({
        policy_decision: "context_only",
        request: input.request || null,
        context_source: context.source,
        extreme_traits: context.extreme_traits,
        reviewed_scenarios: context.reviewed_scenarios,
        intimacy_policy: context.intimacy_policy,
        notes: context.notes,
        guidance: "Use this as roleplay context only. It does not override higher-level model policy.",
      });
    } catch (error) {
      return fail(error);
    }
  }
);

// ═══ run_tool: 범용 커스텀 툴 실행 + 스냅샷 ═══

function readVariables() {
  const varsPath = path.join(sessionDir, "variables.json");
  try {
    return JSON.parse(fs.readFileSync(varsPath, "utf-8"));
  } catch {
    return {};
  }
}

function readHintRules() {
  const rulesPath = path.join(sessionDir, "hint-rules.json");
  try {
    if (fs.existsSync(rulesPath)) {
      return JSON.parse(fs.readFileSync(rulesPath, "utf-8"));
    }
  } catch { /* ignore */ }
  return null;
}

function buildSnapshot(vars, hintRules) {
  if (!hintRules) return null;

  const snapshot = {};
  for (const [key, rule] of Object.entries(hintRules)) {
    const value = vars[key];
    if (value === undefined) continue;

    const entry = {};

    // Format: e.g. "{value}/{max}" or "{value}G"
    if (rule.format) {
      let formatted = rule.format;
      formatted = formatted.replace("{value}", String(value));
      if (rule.max_key && vars[rule.max_key] !== undefined) {
        formatted = formatted.replace("{max}", String(vars[rule.max_key]));
      } else if (rule.max !== undefined) {
        formatted = formatted.replace("{max}", String(rule.max));
      }
      // Percentage calculation
      const maxVal = rule.max_key ? vars[rule.max_key] : rule.max;
      if (typeof value === "number" && typeof maxVal === "number" && maxVal > 0) {
        const pct = Math.round((value / maxVal) * 100);
        formatted = formatted.replace("{pct}", String(pct));
      }
      entry.display = formatted;
    } else {
      entry.display = String(value);
    }

    // Tier-based hint
    if (Array.isArray(rule.tiers) && typeof value === "number") {
      const maxVal = rule.max_key ? vars[rule.max_key] : rule.max;
      const pct = typeof maxVal === "number" && maxVal > 0
        ? (value / maxVal) * 100
        : value;
      const checkValue = rule.tier_mode === "percentage" ? pct : value;
      for (const tier of rule.tiers) {
        if (checkValue <= tier.max) {
          entry.hint = tier.hint;
          break;
        }
      }
    }

    snapshot[key] = typeof value === "string" ? entry.display : entry;
  }

  // Pass through non-rule variables that are commonly useful
  for (const passKey of ["location", "owner_location", "time", "outfit", "cycle_phase", "cycle_day", "day_number"]) {
    if (vars[passKey] !== undefined && !(passKey in snapshot)) {
      snapshot[passKey] = String(vars[passKey]);
    }
  }

  return snapshot;
}

async function executeOneTool(toolName, toolArgs) {
  const route = `/api/sessions/${encodeURIComponent(sessionId)}/tools/${encodeURIComponent(toolName)}`;
  return await requestJson("POST", route, { args: toolArgs });
}

server.registerTool(
  "run_tool",
  {
    description:
      "Execute a custom tool script from the session's tools/ directory. " +
      "Supports single execution or chained sequential execution of multiple tools. " +
      "Returns tool results enriched with a current-state snapshot and narrative hints " +
      "(when hint-rules.json is configured in the session).",
    inputSchema: {
      // Single execution mode
      tool: z.string().optional().describe("Tool name (filename without .js in tools/ dir)"),
      args: z.record(z.string(), z.unknown()).optional().describe("Arguments passed to the tool function"),
      // Chain execution mode
      chain: z.array(z.object({
        tool: z.string().describe("Tool name"),
        args: z.record(z.string(), z.unknown()).optional().describe("Arguments for this tool"),
      })).optional().describe("Sequential chain of tool calls. Final snapshot returned after all complete."),
    },
  },
  async (input) => {
    if (mode !== "session" || !sessionId) {
      return fail("run_tool is only available in session mode");
    }

    try {
      const steps = input.chain
        ? input.chain
        : input.tool
          ? [{ tool: input.tool, args: input.args || {} }]
          : null;

      if (!steps || steps.length === 0) {
        return fail("Provide either 'tool' + 'args' for single execution, or 'chain' for sequential execution.");
      }

      const results = [];
      for (const step of steps) {
        const res = await executeOneTool(step.tool, step.args || {});
        results.push({
          tool: step.tool,
          ...(res.ok ? { success: true, result: res.result } : { success: false, error: res.error }),
        });
        // Stop chain on failure
        if (!res.ok) break;
      }

      // Build snapshot from current variables after all tools executed
      const vars = readVariables();
      const hintRules = readHintRules();
      const snapshot = buildSnapshot(vars, hintRules);

      const response = {
        results: steps.length === 1 ? results[0] : results,
        ...(snapshot ? { snapshot } : {}),
      };

      return ok(response);
    } catch (error) {
      return fail(error);
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("[claude-bridge-mcp] fatal:", error);
  process.exit(1);
});
