export type AIProvider = "claude" | "codex";

const CODEX_MODEL_PREFIXES = ["gpt-5", "codex-mini"];
const CODEX_MODEL_EXACT = new Set(["codex-mini-latest", "o3", "o4-mini"]);

export function providerFromModel(model: string): AIProvider {
  if (!model) return "claude";
  const lower = model.toLowerCase();
  if (CODEX_MODEL_EXACT.has(lower)) return "codex";
  for (const prefix of CODEX_MODEL_PREFIXES) {
    if (lower.startsWith(prefix)) return "codex";
  }
  return "claude";
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
      { value: "", label: "Default" },
      { value: "sonnet", label: "Sonnet" },
      { value: "opus", label: "Opus" },
      { value: "haiku", label: "Haiku" },
    ],
  },
  {
    label: "Codex",
    provider: "codex",
    options: [
      { value: "gpt-5.4", label: "GPT-5.4" },
      { value: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
      { value: "codex-mini-latest", label: "Codex Mini" },
    ],
  },
];
