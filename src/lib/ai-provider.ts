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
  claude: "opus[1m]",
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
        { value: "opus[1m]", label: "Opus 1M" },
        { value: "opus[1m]:medium", label: "Opus 1M Medium" },
        { value: "opus[1m]:high", label: "Opus 1M High" },
        { value: "opus[1m]:xhigh", label: "Opus 1M XHigh" },
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
