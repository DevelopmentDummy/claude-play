export type AIProvider = "claude" | "codex" | "gemini" | "kimi" | "antigravity";

const GEMINI_DISABLED = process.env.NEXT_PUBLIC_DISABLE_GEMINI === "true";

const EXTERNAL_CODEX_MODEL_PREFIX = "external/";
const CODEX_MODEL_PREFIXES = ["gpt-5", "codex-mini"];
const CODEX_MODEL_EXACT = new Set(["codex-mini-latest", "o3", "o4-mini"]);

const GEMINI_MODEL_PREFIXES = ["gemini-"];
const GEMINI_MODEL_EXACT = new Set(["gemini-pro", "gemini-flash"]);

const KIMI_MODEL_PREFIXES = ["kimi-", "moonshot-ai/kimi-"];
const KIMI_MODEL_EXACT = new Set(["kimi-auto"]);

const ANTIGRAVITY_MODEL_PREFIXES = ["antigravity-"];

export function providerFromModel(model: string): AIProvider {
  if (!model) return "claude";
  // Strip effort suffix (e.g. "opus:medium" → "opus")
  const base = model.split(":")[0].toLowerCase();
  if (base.startsWith(EXTERNAL_CODEX_MODEL_PREFIX)) return "codex";
  if (CODEX_MODEL_EXACT.has(base)) return "codex";
  for (const prefix of CODEX_MODEL_PREFIXES) {
    if (base.startsWith(prefix)) return "codex";
  }
  const isGeminiModel = GEMINI_MODEL_EXACT.has(base) ||
    GEMINI_MODEL_PREFIXES.some(p => base.startsWith(p));
  if (isGeminiModel) {
    if (GEMINI_DISABLED) {
      throw new Error(`Gemini provider is disabled (NEXT_PUBLIC_DISABLE_GEMINI=true). Model: ${model}`);
    }
    return "gemini";
  }
  if (KIMI_MODEL_EXACT.has(base)) return "kimi";
  for (const prefix of KIMI_MODEL_PREFIXES) {
    if (base.startsWith(prefix)) return "kimi";
  }
  for (const prefix of ANTIGRAVITY_MODEL_PREFIXES) {
    if (base.startsWith(prefix)) return "antigravity";
  }
  return "claude";
}

export function isExternalCodexModel(model?: string): boolean {
  return !!model && model.toLowerCase().startsWith(EXTERNAL_CODEX_MODEL_PREFIX);
}

export function normalizeCodexModel(model?: string): string | undefined {
  if (!model) return model;
  if (!isExternalCodexModel(model)) return model;
  return model.slice(EXTERNAL_CODEX_MODEL_PREFIX.length);
}

/**
 * Parse a model value that may contain an effort suffix.
 * e.g. "opus:medium" → { model: "opus", effort: "medium" }
 *      "gpt-5.4:high" → { model: "gpt-5.4", effort: "high" }
 *      "sonnet" → { model: "sonnet", effort: undefined }
 */
export function parseModelEffort(value: string): { model: string; effort: string | undefined } {
  if (!value) return { model: "", effort: undefined };
  const parts = value.split(":");
  return { model: parts[0], effort: parts[1] || undefined };
}

/**
 * Sentinel effort value for Claude Code's "ultracode" mode.
 *
 * "ultracode" is NOT a real value the `claude --effort` flag accepts (the CLI only
 * takes low|medium|high|xhigh|max). Internally it is the combination of:
 *   - `xhigh` reasoning effort, plus
 *   - the multi-agent Workflow tool, which is gated by the CLAUDE_CODE_WORKFLOWS
 *     env var (verified in the claude binary: `Cp() = mH(process.env.CLAUDE_CODE_WORKFLOWS)`).
 *
 * We expose it as a pseudo-effort suffix ("opus:ultracode") in the model picker and
 * translate it here so selecting it turns the whole thing on. See resolveClaudeEffort().
 */
export const ULTRACODE_EFFORT = "ultracode";

/** Standing instruction appended when ultracode is active (mirrors Claude Code's "Ultracode is on" reminder). */
export const ULTRACODE_SYSTEM_APPEND =
  "Ultracode mode is on: for substantial multi-step tasks, proactively use the Workflow tool to orchestrate parallel subagents rather than doing everything inline. Token cost is not a constraint here — optimize for the most thorough, correct result.";

/**
 * Translate a Claude effort value into the actual `--effort` flag, whether the
 * multi-agent Workflow tool should be enabled (CLAUDE_CODE_WORKFLOWS), and any
 * standing system-prompt instruction. For every effort other than "ultracode"
 * this is a pass-through with workflows disabled.
 */
export function resolveClaudeEffort(effort?: string): {
  effortFlag: string | undefined;
  enableWorkflows: boolean;
  systemAppend?: string;
} {
  if (effort === ULTRACODE_EFFORT) {
    return { effortFlag: "xhigh", enableWorkflows: true, systemAppend: ULTRACODE_SYSTEM_APPEND };
  }
  return { effortFlag: effort, enableWorkflows: false };
}

export interface ModelOption {
  value: string;
  label: string;
}

export interface ModelGroup {
  label: string;
  provider: AIProvider;
  options: ModelOption[];
}

/** Default model per provider (used when no model is specified) */
const DEFAULT_MODELS: Record<AIProvider, string> = {
  claude: "opus",
  codex: "gpt-5.4",
  gemini: "gemini-3.1-pro-preview",
  kimi: "kimi-auto",
  antigravity: "antigravity-flash",
};

/** Default effort per provider (used when no effort is specified) */
const DEFAULT_EFFORTS: Record<AIProvider, string | undefined> = {
  claude: "medium",
  codex: "medium",
  gemini: undefined,
  kimi: undefined,
  antigravity: undefined,
};

/**
 * Resolve effective model, effort, and combined model string for a provider.
 * Accepts raw model string (e.g. "opus:high", "gpt-5.4", "") and optional provider override.
 * Returns { model, effort, provider, combined } where combined = "model:effort" or just "model".
 */
export function resolveBuilderModel(rawModel?: string, providerOverride?: AIProvider) {
  const { model: parsed, effort: parsedEffort } = parseModelEffort(rawModel || "");
  const provider = providerOverride || (parsed ? providerFromModel(parsed) : "claude");
  const model = parsed || DEFAULT_MODELS[provider];
  const effort = parsedEffort || DEFAULT_EFFORTS[provider];
  const combined = effort ? `${model}:${effort}` : model;
  return { model, effort, provider, combined };
}

function buildModelGroups(): ModelGroup[] {
  const groups: ModelGroup[] = [
    {
      label: "Claude",
      provider: "claude",
      options: [
        { value: "sonnet", label: "Sonnet" },
        { value: "sonnet:medium", label: "Sonnet Medium" },
        { value: "sonnet:high", label: "Sonnet High" },
        { value: "opus", label: "Opus" },
        { value: "opus:medium", label: "Opus Medium" },
        { value: "opus:high", label: "Opus High" },
        { value: "opus:xhigh", label: "Opus XHigh" },
        { value: "opus:max", label: "Opus Max" },
        { value: "opus:ultracode", label: "Opus Ultracode" },
        // Fable re-enabled 2026-07-02 (access restored; the "fable" alias still requires the full id).
        { value: "claude-fable-5", label: "Fable" },
        { value: "claude-fable-5:medium", label: "Fable Medium" },
        { value: "claude-fable-5:high", label: "Fable High" },
        { value: "claude-fable-5:xhigh", label: "Fable XHigh" },
        { value: "claude-fable-5:max", label: "Fable Max" },
        { value: "claude-fable-5:ultracode", label: "Fable Ultracode" },
      ],
    },
    {
      label: "Codex",
      provider: "codex",
      options: [
        { value: "gpt-5.5:medium", label: "GPT-5.5 Medium" },
        { value: "gpt-5.5:high", label: "GPT-5.5 High" },
        { value: "gpt-5.5:xhigh", label: "GPT-5.5 XHigh" },
        { value: "gpt-5.4:medium", label: "GPT-5.4 Medium" },
        { value: "gpt-5.4:high", label: "GPT-5.4 High" },
        { value: "gpt-5.4:xhigh", label: "GPT-5.4 XHigh" },
      ],
    },
    {
      label: "External Gateway",
      provider: "codex",
      options: [
        { value: "external/deepseek/deepseek-chat", label: "DeepSeek Chat" },
        { value: "external/qwen/qwen-max", label: "Qwen Max" },
        { value: "external/zai/glm-4.6", label: "GLM 4.6" },
      ],
    },
  ];
  if (!GEMINI_DISABLED) {
    groups.push({
      label: "Gemini",
      provider: "gemini" as AIProvider,
      options: [
        { value: "gemini-auto", label: "Gemini Auto" },
        { value: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
        { value: "gemini-3-flash-preview", label: "Gemini 3 Flash" },
      ],
    });
  }
  groups.push({
    label: "Antigravity",
    provider: "antigravity" as AIProvider,
    options: [
      { value: "antigravity-flash", label: "Gemini 3.5 Flash" },
      { value: "antigravity-pro", label: "Gemini 3.1 Pro (High)" },
      { value: "antigravity-pro-low", label: "Gemini 3.1 Pro (Low)" },
    ],
  });
  groups.push({
    label: "Kimi",
    provider: "kimi",
    options: [
      { value: "kimi-auto", label: "Kimi Auto" },
      { value: "moonshot-ai/kimi-k2.6", label: "Kimi 2.6" },
      { value: "moonshot-ai/kimi-k2.6:thinking", label: "Kimi 2.6 Thinking" },
    ],
  });
  return groups;
}

export const MODEL_GROUPS: ModelGroup[] = buildModelGroups();
