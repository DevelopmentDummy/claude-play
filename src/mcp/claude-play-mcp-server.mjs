#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "node:fs";
import path from "node:path";
import * as z from "zod/v4";

const apiBase = (process.env.CLAUDE_PLAY_API_BASE || `http://127.0.0.1:${process.env.PORT || "3340"}`)
  .replace(/\/+$/, "");
const mode = process.env.CLAUDE_PLAY_MODE || "session";
const persona = process.env.CLAUDE_PLAY_PERSONA || "";
const sessionDir = process.env.CLAUDE_PLAY_SESSION_DIR || process.cwd();
const sessionId = mode === "session" ? path.basename(sessionDir) : "";
const authToken = process.env.CLAUDE_PLAY_AUTH_TOKEN || "";
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
const WORKFLOWS_DIR = path.join(sessionDir, "..", "..", "tools", "comfyui", "skills", "generate-image", "workflows");

const server = new McpServer({
  name: "claude-play",
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

function resolveTargetSessionId(inputSessionId) {
  const explicit = pickString(inputSessionId);
  if (explicit) return explicit;
  if (mode === "session" && sessionId) return sessionId;
  throw new Error("sessionId is required in builder mode");
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

function buildComfyPrompt(prompt, _useDefaults = true) {
  // 2026-05-04: quality_tags/style_tags 자동 prepend는 워크플로 패키지 책임으로 이관됨.
  // 각 패키지의 params.json에서 `prompt.prefix`/`prompt.suffix`로 정의하면 workflow-resolver가 합쳐준다.
  // (이전엔 여기서 active preset의 quality_tags를 prepend했으나, 사용자가 직접 quality 토큰을 넣었을 때
  //  중복 prepend되는 문제가 있었음. 이제 그냥 본문만 통과시킨다.)
  return pickString(prompt) || "";
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
    description: "Show Claude Play MCP runtime configuration.",
    inputSchema: {},
  },
  async () => {
    return ok({ apiBase, mode, persona: persona || null, sessionDir });
  }
);

server.registerTool(
  "bridge_service_status",
  {
    description: "Show Claude Play service status including active sessions, client counts, and scheduler state.",
    inputSchema: {
      includeInactive: z.boolean().optional(),
      sessionId: z.string().optional(),
    },
  },
  async ({ includeInactive = false, sessionId: targetSessionId }) => {
    try {
      const query = new URLSearchParams();
      if (includeInactive) query.set("includeInactive", "true");
      if (pickString(targetSessionId)) query.set("sessionId", pickString(targetSessionId));
      const suffix = query.toString() ? `?${query.toString()}` : "";
      const data = await requestJson("GET", `/api/service/status${suffix}`);
      return ok(data);
    } catch (error) {
      return fail(error);
    }
  }
);

server.registerTool(
  "bridge_scheduler_inspect",
  {
    description: "Inspect scheduler/runtime state for a specific session or the current session.",
    inputSchema: {
      sessionId: z.string().optional(),
      includeInactive: z.boolean().optional(),
    },
  },
  async ({ sessionId: targetSessionId, includeInactive = false }) => {
    try {
      const resolvedSessionId = resolveTargetSessionId(targetSessionId);
      const query = new URLSearchParams();
      query.set("sessionId", resolvedSessionId);
      if (includeInactive) query.set("includeInactive", "true");
      const data = await requestJson("GET", `/api/service/status?${query.toString()}`);
      const sessionEntry = Array.isArray(data?.sessions)
        ? data.sessions.find((entry) => entry && entry.id === resolvedSessionId) || null
        : null;
      const schedulerEntry = Array.isArray(data?.schedulers)
        ? data.schedulers.find((entry) => entry && entry.sessionId === resolvedSessionId) || null
        : null;
      return ok({
        sessionId: resolvedSessionId,
        session: sessionEntry,
        scheduler: schedulerEntry,
        summary: data?.summary || null,
      });
    } catch (error) {
      return fail(error);
    }
  }
);

server.registerTool(
  "bridge_scheduler_stop",
  {
    description: "Stop the scheduler for a specific session or the current session.",
    inputSchema: {
      sessionId: z.string().optional(),
    },
  },
  async ({ sessionId: targetSessionId }) => {
    try {
      const resolvedSessionId = resolveTargetSessionId(targetSessionId);
      const data = await requestJson(
        "POST",
        `/api/sessions/${encodeURIComponent(resolvedSessionId)}/pipeline-scheduler/stop`,
      );
      return ok({ sessionId: resolvedSessionId, ...data });
    } catch (error) {
      return fail(error);
    }
  }
);

server.registerTool(
  "bridge_scheduler_restart",
  {
    description: "Restart the scheduler for a specific session or the current session.",
    inputSchema: {
      sessionId: z.string().optional(),
      label: z.string().optional(),
      source: z.string().optional(),
      requestedBy: z.string().optional(),
      note: z.string().optional(),
    },
  },
  async ({ sessionId: targetSessionId, label, source, requestedBy, note }) => {
    try {
      const resolvedSessionId = resolveTargetSessionId(targetSessionId);
      const stopResult = await requestJson(
        "POST",
        `/api/sessions/${encodeURIComponent(resolvedSessionId)}/pipeline-scheduler/stop`,
      );
      const startPayload = {
        label: pickString(label) || "mcp-restart",
        source: pickString(source) || "mcp",
        requestedBy: pickString(requestedBy) || "bridge_scheduler_restart",
        note: pickString(note) || "restart requested from MCP",
      };
      const startResult = await requestJson(
        "POST",
        `/api/sessions/${encodeURIComponent(resolvedSessionId)}/pipeline-scheduler/start`,
        startPayload,
      );
      return ok({
        sessionId: resolvedSessionId,
        stop: stopResult,
        start: startResult,
      });
    } catch (error) {
      return fail(error);
    }
  }
);

server.registerTool(
  "comfyui_health",
  {
    description:
      "Check ComfyUI and GPU Manager connection status. Returns connectivity and system stats for each service.",
    inputSchema: {},
  },
  async () => {
    try {
      const data = await requestJson("GET", "/api/tools/comfyui/health");
      return ok(data);
    } catch (error) {
      return fail(error);
    }
  }
);

server.registerTool(
  "comfyui_paths",
  {
    description:
      "Get the ComfyUI installation directory and its standard model subdirectories (checkpoints, loras, vae, clip, upscale_models, etc.). Use this instead of reading .env.local directly. Returns { comfyuiDir, exists, subdirs, source }. If COMFYUI_DIR is not configured, returns { exists: false, source: 'unset' }.",
    inputSchema: {},
  },
  async () => {
    try {
      const comfyuiDir = process.env.COMFYUI_DIR || null;
      if (!comfyuiDir) {
        return ok({ comfyuiDir: null, exists: false, source: "unset" });
      }
      const exists = fs.existsSync(comfyuiDir);
      const subdirNames = [
        "checkpoints", "loras", "vae", "clip", "clip_vision",
        "unet", "diffusion_models", "controlnet", "upscale_models",
        "embeddings", "hypernetworks", "style_models",
      ];
      const subdirs = {};
      const modelsRoot = path.join(comfyuiDir, "models");
      for (const name of subdirNames) {
        const full = path.join(modelsRoot, name);
        subdirs[name] = {
          path: full,
          exists: fs.existsSync(full),
        };
      }
      return ok({
        comfyuiDir,
        exists,
        modelsRoot,
        subdirs,
        source: "env:COMFYUI_DIR",
      });
    } catch (error) {
      return fail(error);
    }
  }
);

server.registerTool(
  "comfyui_models",
  {
    description: "List available ComfyUI checkpoints/models through Claude Play API.",
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
  "comfyui_workflow",
  {
    description:
      "Manage ComfyUI workflow packages (list/get/save/delete). Each package contains workflow.json + params.json + optional resolver.mjs. See manage-workflows skill for detailed usage guide.",
    inputSchema: {
      action: z.enum(["list", "get", "save", "delete"]),
      name: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional(),
      workflow: z.record(z.string(), z.unknown()).optional(),
      params: z.record(z.string(), z.unknown()).optional(),
      resolver: z.string().nullable().optional(),
    },
  },
  async (input) => {
    try {
      const action = input.action;

      if (action === "list") {
        const entries = fs.readdirSync(WORKFLOWS_DIR, { withFileTypes: true })
          .filter(e => e.isDirectory());
        const results = [];
        for (const entry of entries) {
          const paramsPath = path.join(WORKFLOWS_DIR, entry.name, "params.json");
          if (!fs.existsSync(paramsPath)) continue;
          try {
            const meta = JSON.parse(fs.readFileSync(paramsPath, "utf-8"));
            const paramSummary = {};
            for (const [k, v] of Object.entries(meta.params || {})) {
              paramSummary[k] = { type: v.type, required: v.required, description: v.description };
            }
            results.push({
              name: entry.name,
              description: meta.description || null,
              params: paramSummary,
              hasResolver: fs.existsSync(path.join(WORKFLOWS_DIR, entry.name, "resolver.mjs")),
            });
          } catch { /* skip malformed */ }
        }
        return ok(results);
      }

      if (!input.name) throw new Error("name is required for get/save/delete actions");

      if (action === "get") {
        const pkgDir = path.join(WORKFLOWS_DIR, input.name);
        if (!fs.existsSync(pkgDir)) throw new Error(`Package "${input.name}" not found`);
        const workflowPath = path.join(pkgDir, "workflow.json");
        const paramsPath = path.join(pkgDir, "params.json");
        const resolverPath = path.join(pkgDir, "resolver.mjs");
        const result = {
          name: input.name,
          workflow: fs.existsSync(workflowPath) ? JSON.parse(fs.readFileSync(workflowPath, "utf-8")) : null,
          params: fs.existsSync(paramsPath) ? JSON.parse(fs.readFileSync(paramsPath, "utf-8")) : null,
          resolver: fs.existsSync(resolverPath) ? fs.readFileSync(resolverPath, "utf-8") : null,
        };
        return ok(result);
      }

      if (action === "save") {
        if (!input.workflow || !input.params) {
          throw new Error("save requires both workflow and params");
        }
        const pkgDir = path.join(WORKFLOWS_DIR, input.name);
        const tmpDir = pkgDir + `._tmp_${Date.now()}`;
        fs.mkdirSync(tmpDir, { recursive: true });
        try {
          fs.writeFileSync(path.join(tmpDir, "workflow.json"), JSON.stringify(input.workflow, null, 2) + "\n");
          fs.writeFileSync(path.join(tmpDir, "params.json"), JSON.stringify(input.params, null, 2) + "\n");

          if (typeof input.resolver === "string") {
            fs.writeFileSync(path.join(tmpDir, "resolver.mjs"), input.resolver);
          } else if (input.resolver === null) {
            // null = explicitly delete resolver
          } else if (input.resolver === undefined && fs.existsSync(path.join(pkgDir, "resolver.mjs"))) {
            // undefined = keep existing resolver
            fs.copyFileSync(path.join(pkgDir, "resolver.mjs"), path.join(tmpDir, "resolver.mjs"));
          }

          if (fs.existsSync(pkgDir)) {
            fs.rmSync(pkgDir, { recursive: true });
          }
          fs.renameSync(tmpDir, pkgDir);

          return ok({ saved: input.name, files: fs.readdirSync(pkgDir) });
        } catch (err) {
          try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
          throw err;
        }
      }

      if (action === "delete") {
        const pkgDir = path.join(WORKFLOWS_DIR, input.name);
        if (!fs.existsSync(pkgDir)) throw new Error(`Package "${input.name}" not found`);
        fs.rmSync(pkgDir, { recursive: true });
        return ok({ deleted: input.name });
      }

      throw new Error(`Unknown action: ${action}`);
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
      template: z.string().optional(),
      prompt: z.string().optional(),
      negative_prompt: z.string().optional(),
      seed: z.number().int().optional(),
      use_defaults: z.boolean().optional(),
      params: z.record(z.string(), z.unknown()).optional(),
      raw: z.record(z.string(), z.unknown()).optional(),
      filename: z.string().min(1).optional().describe("Filename only — do NOT prefix with 'images/'. The tool auto-saves under the images/ directory. Passing 'images/foo.png' results in 'images/images/foo.png' on disk, mismatching the $IMAGE:images/foo.png$ token (404). Use 'foo.png' instead."),
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
      targetScope: z.enum(["persona", "session"]).optional(),
      async: z.boolean().optional().describe("Fire-and-forget mode: returns predicted path immediately. Frontend polls via InlineImage."),
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
              ...(input.targetScope ? { targetScope: input.targetScope } : {}),
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
              ...(input.targetScope ? { targetScope: input.targetScope } : {}),
            }
      );
      // Async/fire-and-forget mode for comfyui_generate.
      if (input.async) {
        const predictedPath = `images/${filename}`;
        requestJson("POST", "/api/tools/comfyui/generate", payload).catch((err) => {
          const msg = err?.message || String(err);
          console.error(`[comfyui_generate:async] background gen failed for ${filename}:`, msg);
          if (mode === "session" && sessionId) {
            requestJson("POST", `/api/sessions/${encodeURIComponent(sessionId)}/events`, {
              header: `[이미지 생성 실패] ${filename} — ${msg.slice(0, 200)}`,
            }).catch(() => { /* ignore secondary failure */ });
          }
        });
        return ok({
          status: "queued",
          path: predictedPath,
          filename,
          output_token: `$IMAGE:${predictedPath}$`,
          async: true,
        });
      }

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
      reference_image: z.union([z.string(), z.array(z.string())]).optional().describe("Relative path(s) to reference image(s) in the session directory. Single string or array of strings."),
      aspect_ratio: z.string().optional().describe("Aspect ratio: 1:1, 16:9, 4:3, 3:2, 2:3, 9:16"),
      image_size: z.string().optional().describe("Resolution: 512, 1K, 2K, 4K"),
    },
  },
  async (input) => {
    try {
      const payload = withPersona({
        ...input,
        referenceImage: input.reference_image,
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
      "[DEPRECATED — do not call] Legacy image generation. Ignores width/height/params from callers and hard-codes scene-style 1216x832, so portrait/anima packages render in the wrong aspect ratio. Use mcp__claude_play__comfyui_generate instead (passes the package's params.json width/height through correctly).",
    inputSchema: {
      template: z.string().optional(),
      prompt: z.string().optional(),
      prompt_left: z.string().optional(),
      prompt_right: z.string().optional(),
      position: z.enum(["half", "left-heavy", "right-heavy", "left-third", "center-third", "right-third", "half-overlap", "left-heavy-overlap", "right-heavy-overlap", "top-bottom", "top-heavy", "bottom-heavy"]).optional(),
      filename: z.string().optional().describe("Filename only — do NOT prefix with 'images/'. The tool auto-saves under the images/ directory. Passing 'images/foo.png' results in 'images/images/foo.png' on disk, mismatching the $IMAGE:images/foo.png$ token (404). Use 'foo.png' instead."),
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
      targetScope: z.enum(["persona", "session"]).optional(),
      async: z.boolean().optional().describe("Fire-and-forget mode: returns predicted path immediately without waiting for generation. Frontend polls the file URL via InlineImage. Use for response-pipelining."),
      nsfw: z.boolean().optional().describe("NSFW 모드. true면 활성 프리셋의 nsfwLoras(예: BuAnime)가 자동으로 baseLoras에 결합되어 주입된다. NSFW 씬(노출·성행위·BDSM 등)에서 사용."),
    },
  },
  async (input) => {
    // Disabled 2026-06-02: legacy path ignores width/height and forces 1216x832,
    // breaking portrait/anima packages. Route callers to comfyui_generate.
    return fail(new Error(
      "[generate_image is disabled] This legacy tool ignored package-level width/height and forced a horizontal 1216x832 latent, " +
      "which made `portrait`, `anima-mixed-scene`, and other non-scene packages render at the wrong aspect ratio. " +
      "Use `mcp__claude_play__comfyui_generate` instead — it accepts a `params` object (params.prompt, params.negative_prompt, " +
      "params.width, params.height, params.seed, etc.) that is passed straight through to the workflow package's params.json, " +
      "so the package's own default resolution (e.g. portrait 832x1216) is respected. " +
      "Top-level fields stay the same: workflow, filename, targetScope, persona, loras, loras_left, loras_right, async."
    ));
    // eslint-disable-next-line no-unreachable
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
      if (input.nsfw === true) params.nsfw = true;

      const finalFilename = deduplicateImageFilename(pickString(input.filename) || `comfyui_${Date.now()}.png`);
      const payload = withPersona({
        workflow,
        params,
        filename: finalFilename,
        loras: input.loras,
        loras_left: input.loras_left,
        loras_right: input.loras_right,
        ...(input.persona ? { persona: input.persona } : {}),
        ...(input.targetScope ? { targetScope: input.targetScope } : {}),
      });

      // Async/fire-and-forget: kick off the generation, return predicted path immediately.
      // InlineImage in chat polls the file URL and renders when the gen finishes.
      // On failure, POST a failure event header so the user sees a toast and the AI
      // gets the failure on its next turn (instead of silently 404-polling forever).
      if (input.async) {
        const predictedPath = `images/${finalFilename}`;
        requestJson("POST", "/api/tools/comfyui/generate", payload)
          .then(() => {
            // Success — no event needed; the file appears and InlineImage's poll picks it up.
          })
          .catch((err) => {
            const msg = err?.message || String(err);
            console.error(`[generate_image:async] background gen failed for ${finalFilename}:`, msg);
            // Notify the chat session so the user and AI both see the failure.
            if (mode === "session" && sessionId) {
              requestJson("POST", `/api/sessions/${encodeURIComponent(sessionId)}/events`, {
                header: `[이미지 생성 실패] ${finalFilename} — ${msg.slice(0, 200)}`,
              }).catch(() => { /* swallow secondary failure */ });
            }
          });
        return ok({
          status: "queued",
          path: predictedPath,
          filename: finalFilename,
          output_token: `$IMAGE:${predictedPath}$`,
          async: true,
        });
      }

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
      filename: z.string().optional().describe("Filename only — do NOT prefix with 'images/'. The tool auto-saves under the images/ directory. Passing 'images/foo.png' results in 'images/images/foo.png' on disk, mismatching the $IMAGE:images/foo.png$ token (404). Use 'foo.png' instead."),
      persona: z.string().optional(),
      reference_image: z.union([z.string(), z.array(z.string())]).optional().describe("Relative path(s) to reference image(s) in the session directory. Single string or array of strings."),
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
        referenceImage: input.reference_image,
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
    description: "Generate an image using OpenAI GPT image model (gpt-image-2). Supports reference image via /v1/images/edits endpoint.",
    inputSchema: {
      prompt: z.string().min(1),
      filename: z.string().optional().describe("Filename only — do NOT prefix with 'images/'. The tool auto-saves under the images/ directory. Passing 'images/foo.png' results in 'images/images/foo.png' on disk, mismatching the $IMAGE:images/foo.png$ token (404). Use 'foo.png' instead."),
      persona: z.string().optional(),
      reference_image: z.string().optional().describe("Relative path to a reference image in the session directory (e.g. images/portrait.png). Uses edits endpoint when provided."),
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
        referenceImage: pickString(input.reference_image),
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

// Keep in sync with src/lib/hint-snapshot.ts (cannot import .ts from .mjs)
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

    // Floor numeric values for display (engine stores floats internally)
    const displayValue = typeof value === "number" ? Math.floor(value) : value;

    // Format: e.g. "{value}/{max}" or "{value}G"
    if (rule.format) {
      let formatted = rule.format;
      formatted = formatted.replace("{value}", String(displayValue));
      if (rule.max_key && vars[rule.max_key] !== undefined) {
        const maxDisplay = typeof vars[rule.max_key] === "number"
          ? Math.floor(vars[rule.max_key]) : vars[rule.max_key];
        formatted = formatted.replace("{max}", String(maxDisplay));
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
      entry.display = String(displayValue);
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

  // Per-persona passthrough keys from _passthrough in hint-rules
  const customPassthrough = (hintRules || {})._passthrough;
  if (Array.isArray(customPassthrough)) {
    for (const passKey of customPassthrough) {
      if (typeof passKey === "string" && vars[passKey] !== undefined && !(passKey in snapshot)) {
        snapshot[passKey] = String(vars[passKey]);
      }
    }
  }

  // Competition urgency hint
  const compRemaining = vars.__competitions_remaining_turns;
  const compAvailable = vars.__competitions_available;
  if (compAvailable && Array.isArray(compAvailable) && compAvailable.length > 0 && compRemaining !== undefined) {
    const label = compRemaining === 0 ? "🏆대회참가가능(마지막기회!)" : `🏆대회참가가능(남은턴:${compRemaining})`;
    snapshot["competition_notice"] = label;
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

// ── Background Session (fire-and-forget) ──────────────────────────
server.registerTool(
  "fire_ai",
  {
    description:
      "Fire an independent AI session in the background. " +
      "Spawns claude in one-shot mode with the current session's system prompt and MCP tools. " +
      "Returns immediately without waiting for completion. " +
      "Use for time-consuming content generation that shouldn't block the conversation.\n" +
      "Exit-time options:\n" +
      "  - notify=true: silent system event injected into next user turn (AI responds to it).\n" +
      "  - onExit.broadcast: WS event to this session's clients (UI spinners, delayed reveal, badges).\n" +
      "  - onExit.script: relative JS module inside the session dir, called with " +
      "{ pid, exitCode, sessionDir, logTail }; may return { broadcast, queueEvent }.",
    inputSchema: {
      prompt: z.string().min(1).describe("The prompt/task to execute in the background session"),
      model: z.string().optional().describe("Model override (e.g. sonnet, opus)"),
      effort: z.string().optional().describe("Reasoning effort: low, medium, high"),
      notify: z.boolean().optional().describe("Send completion event to this session when done (default: false)"),
      onExit: z
        .object({
          broadcast: z
            .object({
              event: z.string().min(1).describe("WS event name sent to this session's clients on exit"),
              data: z.any().optional().describe("Arbitrary JSON payload for the broadcast"),
            })
            .optional()
            .describe("Static WS broadcast to fire when the background process exits"),
          script: z
            .string()
            .optional()
            .describe(
              "Path (relative to sessionDir) to a Node module exporting a function. " +
                "Called with { pid, exitCode, sessionDir, logTail }, may return { broadcast, queueEvent }."
            ),
        })
        .optional()
        .describe("Exit-time actions: WS broadcast and/or in-session JS callback"),
    },
  },
  async (input) => {
    if (mode !== "session") {
      return fail("fire_ai is only available in session mode");
    }
    try {
      const result = await requestJson("POST", `/api/sessions/${sessionId}/fire-ai`, {
        prompt: input.prompt,
        model: input.model,
        effort: input.effort,
        notify: input.notify ?? false,
        onExit: input.onExit,
      });
      return ok(result);
    } catch (error) {
      return fail(error);
    }
  }
);

server.registerTool(
  "bridge_delegate",
  {
    description:
      "Delegate a task to a pre-configured sub-agent of THIS session (defined in subagents.json). " +
      "Fire-and-forget: the sub works in the background and reports a summary back into your next turn " +
      "via the event queue. Use for bookkeeping you don't want in your own context (panel variable updates, " +
      "flow control, lore consistency checks).",
    inputSchema: {
      to: z.string().min(1).describe("Sub-agent name as declared in subagents.json"),
      task: z.string().min(1).describe("The task instruction for the sub-agent"),
    },
  },
  async ({ to, task }) => {
    if (mode !== "session") return fail("bridge_delegate is only available in session mode");
    try {
      const data = await requestJson(
        "POST",
        `/api/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(to)}/dispatch`,
        { task },
      );
      return ok(data);
    } catch (error) {
      return fail(error);
    }
  }
);

server.registerTool(
  "report_to_main",
  {
    description:
      "Report a concise summary of what you changed back to the main narrator. " +
      "Queues a [SUB:<from>] event delivered to the narrator on the next user turn. " +
      "Call this when you (a sub-agent) finish a task. Keep the summary to one or two sentences.",
    inputSchema: {
      from: z.string().min(1).describe("Your own sub-agent name (as in subagents.json)"),
      summary: z.string().min(1).describe("One or two concise sentences of what changed"),
    },
  },
  async ({ from, summary }) => {
    if (mode !== "session") return fail("report_to_main is only available in session mode");
    try {
      const header = `[SUB:${String(from).trim()}] ${String(summary).trim()}`;
      // silent: queue the [SUB:...] event for next-turn injection without broadcasting
      // event:pending — sub-agent bookkeeping should not surface as a UI chip above the input.
      const data = await requestJson(
        "POST",
        `/api/sessions/${encodeURIComponent(sessionId)}/events`,
        { header, silent: true },
      );
      return ok(data);
    } catch (error) {
      return fail(error);
    }
  }
);

server.registerTool(
  "bridge_restart_service",
  {
    description:
      "Rebuild and (optionally) respawn the Claude Play main service. " +
      "ALWAYS runs `npm run build` first — even in dev mode, because tsx watch only watches server.ts " +
      "and won't catch TypeScript errors elsewhere (build is the source of truth). " +
      "Build runs SYNCHRONOUSLY while the old server is still alive; if it fails, the server is left untouched and the error is returned. " +
      "On success, spawns a detached respawn orchestrator that kills + restarts the server (~1-2s downtime). " +
      "Pass respawn=false to build-only without restarting. " +
      "Note: the build response may take 30s-2min; this MCP session WILL disconnect during respawn. " +
      "Watch data/restart.log for orchestrator progress.",
    inputSchema: {
      mode: z.enum(["dev", "start"]).optional().describe("Respawn in dev or production mode (default: auto-detect from current server)"),
      respawn: z.boolean().optional().describe("Whether to respawn after build (default: true)"),
    },
  },
  async ({ mode, respawn }) => {
    try {
      const data = await requestJson("POST", "/api/service/restart", {
        ...(mode ? { mode } : {}),
        ...(respawn === false ? { respawn: false } : {}),
        ...(sessionId ? { sessionId, triggeredBy: "mcp:bridge_restart_service" } : {}),
        // Builder sessions have no sessionId (path.basename only set for "session" mode);
        // pass the persona name so the restart marker lands in the persona dir instead.
        ...(mode === "builder" && persona ? { builderPersona: persona, triggeredBy: "mcp:bridge_restart_service" } : {}),
      });
      return ok(data);
    } catch (error) {
      return fail(error);
    }
  }
);

server.registerTool(
  "bridge_define_subagent",
  {
    description:
      "[Builder mode] Define or update a specialized sub-agent for this persona. " +
      "Writes subagents.json (merging by name) and subagents/<name>/instructions.md in the persona dir. " +
      "Sub-agents run always-on alongside the main narrator at session time and handle delegated bookkeeping " +
      "(panel variable updates, flow control, lore consistency). A sub automatically runs on the SAME provider " +
      "and model/effort as the session it belongs to — you do not choose a provider or model here.",
    inputSchema: {
      name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/).describe("Unique sub-agent id (lowercase, dashes)"),
      role: z.string().min(1).describe("Short human description of the sub's responsibility"),
      instructions: z.string().min(1).describe("Full system-prompt body for the sub (saved to instructions.md)"),
      delegable: z.boolean().optional().describe("Callable via bridge_delegate by the main narrator (default true)"),
      autoTrigger: z.enum(["onAssistantTurn", "none"]).optional().describe("Auto-dispatch every main turn, or 'none' (hook-controlled). Default none."),
      autoTriggerTask: z.string().optional().describe("Default task text when autoTrigger is onAssistantTurn"),
      emitSummary: z.boolean().optional().describe("Sub should call report_to_main when done (default true)"),
    },
  },
  async (input) => {
    if (mode !== "builder") return fail("bridge_define_subagent is only available in builder mode");
    try {
      const manifestPath = path.join(sessionDir, "subagents.json");
      let manifest = { version: 1, subagents: [] };
      if (fs.existsSync(manifestPath)) {
        try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")); } catch { /* reset on corrupt */ }
      }
      if (!Array.isArray(manifest.subagents)) manifest.subagents = [];
      const entry = {
        name: input.name,
        role: input.role,
        instructions: "instructions.md",
        delegable: input.delegable !== false,
        autoTrigger: input.autoTrigger || "none",
        ...(input.autoTriggerTask ? { autoTriggerTask: input.autoTriggerTask } : {}),
        emitSummary: input.emitSummary !== false,
      };
      const idx = manifest.subagents.findIndex((s) => s && s.name === input.name);
      if (idx >= 0) manifest.subagents[idx] = { ...manifest.subagents[idx], ...entry };
      else manifest.subagents.push(entry);
      // Keep in sync with MAX_SUBAGENTS in src/lib/subagent-manifest.ts (can't import .ts here).
      const maxSubs = Number(process.env.SUBAGENT_MAX) > 0 ? Number(process.env.SUBAGENT_MAX) : 6;
      if (manifest.subagents.length > maxSubs) {
        return fail(`Too many sub-agents (${manifest.subagents.length} > cap ${maxSubs}).`);
      }
      const subDir = path.join(sessionDir, "subagents", input.name);
      fs.mkdirSync(subDir, { recursive: true });
      fs.writeFileSync(path.join(subDir, "instructions.md"), input.instructions, "utf-8");
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
      return ok({ defined: input.name, total: manifest.subagents.length });
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
  console.error("[claude-play-mcp] fatal:", error);
  process.exit(1);
});
