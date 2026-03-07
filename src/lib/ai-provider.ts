export type AIProvider = "claude" | "codex";

const CODEX_MODEL_PREFIXES = ["gpt-5", "codex-mini"];
const CODEX_MODEL_EXACT = new Set(["codex-mini-latest", "o3", "o4-mini"]);

export function providerFromModel(model: string): AIProvider {
  if (!model) return "claude";
  // Strip effort suffix (e.g. "opus:medium" → "opus")
  const base = model.split(":")[0].toLowerCase();
  if (CODEX_MODEL_EXACT.has(base)) return "codex";
  for (const prefix of CODEX_MODEL_PREFIXES) {
    if (base.startsWith(prefix)) return "codex";
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
      { value: "opus:medium", label: "Opus Medium" },
      { value: "opus:high", label: "Opus High" },
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
];
