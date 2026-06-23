import * as fs from "fs";
import * as path from "path";
import { AIProvider, providerFromModel, parseModelEffort } from "./ai-provider";

export const MAX_SUBAGENTS = Number(process.env.SUBAGENT_MAX) > 0
  ? Number(process.env.SUBAGENT_MAX)
  : 6;

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
// v2.1: by default a sub follows the SESSION's provider/model/effort (resolved at spawn time
// in SubAgentManager.spawnAll). A sub MAY pin itself by setting `model` (a single id, optionally
// with an effort suffix like "gpt-5.4:high"); validateManifest derives provider via
// providerFromModel and splits the effort via parseModelEffort into the per-sub fields below.
// An explicit `provider`/`effort` in the manifest (hand-edit) still takes precedence over derivation.
// `provider` is always default-filled ("claude"); use `providerExplicit` to detect a real override.

export interface SubAgentDef {
  name: string;                          // [a-z0-9-], unique, used as dir name
  role: string;                          // human description
  provider: AIProvider;                  // default-filled ("claude") for back-compat consumers
  providerExplicit?: AIProvider;         // set ONLY when the manifest explicitly specified provider (per-sub override)
  model?: string;                        // per-sub model override; unset → session model
  effort?: string;                       // per-sub effort override; unset → session effort
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
    // Single `model` string is the primary source: split any effort suffix
    // (parseModelEffort) and infer the provider (providerFromModel). A manifest MAY still
    // specify `provider`/`effort` explicitly (legacy / hand-edit) — those take precedence.
    const rawModel = typeof e.model === "string" && e.model.trim() ? e.model.trim() : undefined;
    const { model: baseModel, effort: suffixEffort }: { model: string | undefined; effort: string | undefined } =
      rawModel ? parseModelEffort(rawModel) : { model: undefined, effort: undefined };
    let providerExplicit: AIProvider | undefined;
    if (typeof e.provider === "string" && e.provider.trim()) {
      providerExplicit = e.provider.trim() as AIProvider;       // explicit override wins
    } else if (rawModel) {
      try { providerExplicit = providerFromModel(rawModel); }   // infer from model id
      catch { providerExplicit = undefined; }                   // e.g. gemini disabled → session fallback
    }
    const provider = providerExplicit ?? ("claude" as AIProvider); // default-filled for back-compat
    const effort = typeof e.effort === "string" && e.effort.trim()
      ? e.effort.trim()                                          // explicit effort wins
      : suffixEffort;                                            // else from model suffix
    const autoTrigger = e.autoTrigger === "onAssistantTurn" ? "onAssistantTurn" : "none";
    return {
      name,
      role: String(e.role ?? ""),
      provider,
      providerExplicit,
      model: baseModel || undefined,
      effort,
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
