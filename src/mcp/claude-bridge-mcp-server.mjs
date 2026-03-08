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
const COMFY_DEFAULT_TRIGGERS = "anime screencap, anime coloring, sexydet, s1_dram";
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
  return payload;
}

function pickString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function buildComfyPrompt(prompt, useDefaults = true) {
  const body = pickString(prompt);
  if (!body) return "";
  if (!useDefaults) return body;
  return `${COMFY_DEFAULT_QUALITY}, ${COMFY_DEFAULT_TRIGGERS}, ${body}`;
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
      template: z.enum(["portrait", "scene", "profile"]).optional(),
      prompt: z.string().optional(),
      negative_prompt: z.string().optional(),
      seed: z.number().int().optional(),
      use_defaults: z.boolean().optional(),
      params: z.record(z.string(), z.unknown()).optional(),
      raw: z.record(z.string(), z.unknown()).optional(),
      filename: z.string().min(1).optional(),
      extraFiles: z.record(z.string(), z.string()).optional(),
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

      const workflow = pickString(input.workflow) || pickString(input.template) || COMFY_DEFAULT_TEMPLATE;
      const useDefaults = input.use_defaults !== false;
      const explicitPrompt = pickString(input.prompt);
      const filename = pickString(input.filename) || `comfyui_${Date.now()}.png`;
      const params = { ...(input.params || {}) };

      if (explicitPrompt) {
        params.prompt = buildComfyPrompt(explicitPrompt, useDefaults);
      } else if (typeof params.prompt === "string") {
        params.prompt = buildComfyPrompt(params.prompt, useDefaults);
      }

      if (input.negative_prompt && !params.negative_prompt) {
        params.negative_prompt = input.negative_prompt;
      } else if (!params.negative_prompt) {
        params.negative_prompt = COMFY_DEFAULT_NEGATIVE;
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
    },
  },
  async (input) => {
    try {
      const payload = withPersona(input);
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
      template: z.enum(["portrait", "scene", "profile"]).optional(),
      prompt: z.string().min(1),
      filename: z.string().optional(),
      seed: z.number().int().optional(),
      negative_prompt: z.string().optional(),
      use_defaults: z.boolean().optional(),
      persona: z.string().optional(),
    },
  },
  async (input) => {
    try {
      const payload = withPersona({
        workflow: input.template || COMFY_DEFAULT_TEMPLATE,
        params: {
          prompt: buildComfyPrompt(input.prompt, input.use_defaults !== false),
          negative_prompt: input.negative_prompt || COMFY_DEFAULT_NEGATIVE,
          ...(typeof input.seed === "number" ? { seed: input.seed } : {}),
        },
        filename: pickString(input.filename) || `comfyui_${Date.now()}.png`,
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
    },
  },
  async (input) => {
    try {
      const payload = withPersona({
        prompt: input.prompt,
        filename: pickString(input.filename) || `gemini_${Date.now()}.png`,
        ...(input.persona ? { persona: input.persona } : {}),
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("[claude-bridge-mcp] fatal:", error);
  process.exit(1);
});
