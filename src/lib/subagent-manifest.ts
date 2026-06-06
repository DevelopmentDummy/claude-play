import * as fs from "fs";
import * as path from "path";
import { AIProvider } from "./ai-provider";

export const MAX_SUBAGENTS = Number(process.env.SUBAGENT_MAX) > 0
  ? Number(process.env.SUBAGENT_MAX)
  : 6;

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
// Antigravity is excluded: it spawns via PowerShell (not node child_process), uses agyPid
// (not proc.pid), does not emit an "exit" event, and requires a persistent Windows console
// handle that cannot be safely shared inside the server process alongside other sub-agents.
const PROVIDERS: AIProvider[] = ["claude", "codex", "gemini", "kimi"];

export interface SubAgentDef {
  name: string;                          // [a-z0-9-], unique, used as dir name
  role: string;                          // human description
  provider: AIProvider;                  // penta-runtime
  model?: string;                        // provider model id (optional → provider default)
  effort?: string;                       // claude/codex effort (optional)
  instructions: string;                  // relative path under subagents/{name}/, e.g. "instructions.md"
  delegable: boolean;                    // callable via bridge_delegate
  autoTrigger: "onAssistantTurn" | "none";
  autoTriggerTask?: string;              // default task when autoTrigger === "onAssistantTurn"
  emitSummary: boolean;                  // sub should report_to_main on completion
  writes?: string[];                     // advisory only in v1 (doc), not enforced
}

export interface SubAgentManifest {
  version: number;
  subagents: SubAgentDef[];
}

const EMPTY: SubAgentManifest = { version: 1, subagents: [] };

/** Read + validate subagents.json from a dir. Returns EMPTY when absent.
 *  Throws Error with a readable message on a malformed/invalid manifest. */
export function loadSubAgentManifest(dir: string): SubAgentManifest {
  const fp = path.join(dir, "subagents.json");
  if (!fs.existsSync(fp)) return { ...EMPTY };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(fp, "utf-8"));
  } catch (err) {
    throw new Error(`subagents.json parse error: ${(err as Error).message}`);
  }
  return validateManifest(raw);
}

export function validateManifest(raw: unknown): SubAgentManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("subagents.json: root must be an object");
  const obj = raw as Record<string, unknown>;
  const list = Array.isArray(obj.subagents) ? obj.subagents : [];
  if (list.length > MAX_SUBAGENTS) {
    throw new Error(`subagents.json: too many subagents (${list.length} > cap ${MAX_SUBAGENTS})`);
  }
  const seen = new Set<string>();
  const subagents: SubAgentDef[] = list.map((entry, i) => {
    const e = (entry || {}) as Record<string, unknown>;
    const name = String(e.name ?? "");
    if (!NAME_RE.test(name)) throw new Error(`subagents[${i}]: invalid name "${name}" (expect ${NAME_RE})`);
    if (seen.has(name)) throw new Error(`subagents[${i}]: duplicate name "${name}"`);
    seen.add(name);
    const provider = String(e.provider ?? "claude") as AIProvider;
    if (!PROVIDERS.includes(provider)) throw new Error(`subagents[${i}]: unsupported provider "${provider}" for sub-agents (supported: ${PROVIDERS.join(", ")}). Note: "antigravity" is not supported in v1 — it requires a dedicated Windows console handle that cannot be shared inside the server process.`);
    const autoTrigger = e.autoTrigger === "onAssistantTurn" ? "onAssistantTurn" : "none";
    return {
      name,
      role: String(e.role ?? ""),
      provider,
      model: typeof e.model === "string" ? e.model : undefined,
      effort: typeof e.effort === "string" ? e.effort : undefined,
      instructions: typeof e.instructions === "string" && e.instructions.trim()
        ? e.instructions : "instructions.md",
      delegable: e.delegable !== false,
      autoTrigger,
      autoTriggerTask: typeof e.autoTriggerTask === "string" ? e.autoTriggerTask : undefined,
      emitSummary: e.emitSummary !== false,
      writes: Array.isArray(e.writes) ? e.writes.filter((w): w is string => typeof w === "string") : undefined,
    };
  });
  return { version: typeof obj.version === "number" ? obj.version : 1, subagents };
}
