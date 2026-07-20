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
  // Strip advisor suffix first (e.g. "opus:ultracode@fable" → "opus:ultracode"), then effort suffix
  let rest = model;
  const at = rest.indexOf("@");
  if (at !== -1) {
    rest = rest.slice(0, at);
  }
  const base = rest.split(":")[0].toLowerCase();
  if (base.startsWith(EXTERNAL_CODEX_MODEL_PREFIX)) return "codex";
  if (CODEX_MODEL_EXACT.has(base)) return "codex";
  for (const prefix of CODEX_MODEL_PREFIXES) {
    if (base.startsWith(prefix)) return "codex";
  }
  const isGeminiModel = GEMINI_MODEL_EXACT.has(base) ||
    GEMINI_MODEL_PREFIXES.some(p => base.startsWith(p));
  if (isGeminiModel) {
    // Gemini CLI (text/chat) is retired. When disabled, transparently route gemini-* ids to
    // the Antigravity backend — which serves the same Gemini models — instead of throwing, so
    // existing sessions/personas/subagents/fire_ai keep working (and session open/sync/options,
    // which call this without try/catch, don't 500). AntigravityProcess.modelPattern is
    // keyword-based ("pro"/"pro-low"/else): "gemini-…-pro…" → Pro tier, everything else → Flash.
    if (GEMINI_DISABLED) return "antigravity";
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
 * Parse a model value that may carry an effort suffix and/or an advisor suffix.
 * Grammar: <model>[:<effort>][@<advisor>]
 * e.g. "opus:medium"        → { model: "opus", effort: "medium", advisor: undefined }
 *      "opus:ultracode@fable" → { model: "opus", effort: "ultracode", advisor: "fable" }
 *      "opus@fable"          → { model: "opus", effort: undefined, advisor: "fable" }
 * The advisor (`@…`) is split off first so it never contaminates the effort slot.
 */
export function parseModelEffort(value: string): { model: string; effort: string | undefined; advisor: string | undefined } {
  if (!value) return { model: "", effort: undefined, advisor: undefined };
  let rest = value;
  let advisor: string | undefined;
  const at = rest.indexOf("@");
  if (at !== -1) {
    advisor = rest.slice(at + 1) || undefined;
    rest = rest.slice(0, at);
  }
  const parts = rest.split(":");
  return { model: parts[0], effort: parts[1] || undefined, advisor };
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
  codex: "gpt-5.6-sol",
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
 * Accepts raw model string (e.g. "opus:high", "gpt-5.6-sol", "") and optional provider override.
 * Returns { model, effort, provider, combined, advisor } where combined = "model[:effort][@advisor]".
 */
export function resolveBuilderModel(rawModel?: string, providerOverride?: AIProvider) {
  const { model: parsed, effort: parsedEffort, advisor } = parseModelEffort(rawModel || "");
  const provider = providerOverride || (parsed ? providerFromModel(parsed) : "claude");
  const model = parsed || DEFAULT_MODELS[provider];
  const effort = parsedEffort || DEFAULT_EFFORTS[provider];
  const base = effort ? `${model}:${effort}` : model;
  const combined = advisor ? `${base}@${advisor}` : base;
  return { model, effort, provider, combined, advisor };
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
        // Opus 베이스 + Fable advisor 조합 프리셋 (advisor는 claude -p 전용, `--advisor`로 전달).
        { value: "opus@fable", label: "Opus + Fable advisor" },
        { value: "opus:high@fable", label: "Opus High + Fable advisor" },
        { value: "opus:ultracode@fable", label: "Opus Ultracode + Fable advisor" },
      ],
    },
    {
      label: "Codex",
      provider: "codex",
      options: [
        // GPT-5.6 (2026-07-09): Sol=플래그십(bare `gpt-5.6` 별칭이 Sol로 라우팅), Terra=균형, Luna=최속·최저가.
        { value: "gpt-5.6-sol:medium", label: "GPT-5.6 Sol Medium" },
        { value: "gpt-5.6-sol:high", label: "GPT-5.6 Sol High" },
        { value: "gpt-5.6-sol:xhigh", label: "GPT-5.6 Sol XHigh" },
        { value: "gpt-5.6-terra:medium", label: "GPT-5.6 Terra Medium" },
        { value: "gpt-5.6-terra:high", label: "GPT-5.6 Terra High" },
        { value: "gpt-5.6-terra:xhigh", label: "GPT-5.6 Terra XHigh" },
        { value: "gpt-5.6-luna:medium", label: "GPT-5.6 Luna Medium" },
        { value: "gpt-5.6-luna:high", label: "GPT-5.6 Luna High" },
        { value: "gpt-5.5:medium", label: "GPT-5.5 Medium" },
        { value: "gpt-5.5:high", label: "GPT-5.5 High" },
        { value: "gpt-5.5:xhigh", label: "GPT-5.5 XHigh" },
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
    // Gemini CLI is retired (see NEXT_PUBLIC_DISABLE_GEMINI); Gemini now runs through
    // the Antigravity backend, so surface these as the Gemini options in the picker.
    label: "Gemini (Antigravity)",
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

/**
 * Base model ids per picker group (effort/advisor suffixes stripped, deduped).
 * Single source for anything that needs to *describe* the valid model ids in prose —
 * currently the builder meta-prompt's sub-agent `model` catalog (prompt-assembly.ts).
 * Derived from MODEL_GROUPS so the catalog follows the picker, including the
 * GEMINI_DISABLED branch (retired Gemini CLI ids never get advertised).
 */
export function listBaseModelIds(): { label: string; ids: string[] }[] {
  return MODEL_GROUPS.map((g) => {
    const ids: string[] = [];
    for (const o of g.options) {
      const { model } = parseModelEffort(o.value);
      if (model && !ids.includes(model)) ids.push(model);
    }
    return { label: g.label, ids };
  });
}
