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
      { value: "opus[1m]", label: "Opus 1M" },
      { value: "opus[1m]:medium", label: "Opus 1M Medium" },
      { value: "opus[1m]:high", label: "Opus 1M High" },
    ],
  },
  {
    label: "Codex",
    provider: "codex",
    options: [
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
