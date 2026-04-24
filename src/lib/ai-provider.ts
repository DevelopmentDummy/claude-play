export type AIProvider = "claude" | "codex" | "gemini";

const CODEX_MODEL_PREFIXES = ["gpt-5", "codex-mini"];
const CODEX_MODEL_EXACT = new Set(["codex-mini-latest", "o3", "o4-mini"]);

const GEMINI_MODEL_PREFIXES = ["gemini-"];
const GEMINI_MODEL_EXACT = new Set(["gemini-pro", "gemini-flash"]);

export function providerFromModel(model: string): AIProvider {
  if (!model) return "claude";
  // Strip effort suffix (e.g. "opus:medium" → "opus")
  const base = model.split(":")[0].toLowerCase();
  if (CODEX_MODEL_EXACT.has(base)) return "codex";
  for (const prefix of CODEX_MODEL_PREFIXES) {
    if (base.startsWith(prefix)) return "codex";
  }
  if (GEMINI_MODEL_EXACT.has(base)) return "gemini";
  for (const prefix of GEMINI_MODEL_PREFIXES) {
    if (base.startsWith(prefix)) return "gemini";
  }
  return "claude";
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
};

/** Default effort per provider (used when no effort is specified) */
const DEFAULT_EFFORTS: Record<AIProvider, string | undefined> = {
  claude: "medium",
  codex: "medium",
  gemini: undefined,
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

export const MODEL_GROUPS: ModelGroup[] = [
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
    label: "Gemini",
    provider: "gemini" as AIProvider,
    options: [
      { value: "gemini-auto", label: "Gemini Auto" },
      { value: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
      { value: "gemini-3-flash-preview", label: "Gemini 3 Flash" },
    ],
  },
];
