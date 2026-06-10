import { SubAgentInstance } from "./subagent-instance";
import { loadSubAgentManifest, SubAgentDef } from "./subagent-manifest";
import { AIProvider } from "./ai-provider";

/** Owns the sub-agent instances for one session. Created and held by the parent
 *  SessionInstance; lifecycle is tied to the parent (spawnAll on open, destroyAll
 *  on parent destroy). */
export class SubAgentManager {
  private readonly sessionId: string;
  private readonly getDir: () => string | null;
  private subs = new Map<string, SubAgentInstance>();
  private defs = new Map<string, SubAgentDef>();

  constructor(sessionId: string, getDir: () => string | null) {
    this.sessionId = sessionId;
    this.getDir = getDir;
  }

  /** Read the manifest and spawn every declared sub-agent with the SESSION's
   *  provider/model/effort (subs follow the session, not the manifest). Safe to call
   *  again (re-open): already-running subs with the same runtime are left as-is; if the
   *  session provider/model/effort changed, the cached sub is destroyed and recreated.
   *  Manifest errors are logged, never thrown into the open flow. */
  spawnAll(provider: AIProvider, model?: string, effort?: string): void {
    const dir = this.getDir();
    if (!dir) return;
    let defs: SubAgentDef[] = [];
    try {
      defs = loadSubAgentManifest(dir).subagents;
    } catch (err) {
      console.error(`[subagent-manager:${this.sessionId}] manifest invalid:`, (err as Error).message);
      return;
    }
    for (const def of defs) {
      this.defs.set(def.name, def);
      let inst = this.subs.get(def.name);
      if (inst && (inst.provider !== provider || inst.model !== model || inst.effort !== effort)) {
        try { inst.destroy(); } catch { /* ignore */ }
        this.subs.delete(def.name);
        inst = undefined;
      }
      if (!inst) {
        inst = new SubAgentInstance(def, dir, this.sessionId, provider, model, effort);
        this.subs.set(def.name, inst);
      }
      try { inst.start(); } catch (err) {
        console.error(`[subagent-manager:${this.sessionId}] start ${def.name} failed:`, err);
      }
    }
  }

  /** Route a task to a named sub. Returns false if unknown/undeclared. */
  dispatch(name: string, task: string): boolean {
    const inst = this.subs.get(name);
    if (!inst) {
      console.warn(`[subagent-manager:${this.sessionId}] dispatch to unknown sub "${name}"`);
      return false;
    }
    inst.dispatch(task);
    return true;
  }

  /** Defs whose autoTrigger === "onAssistantTurn" (with their default task). */
  autoTriggerDefs(): SubAgentDef[] {
    return [...this.defs.values()].filter(d => d.autoTrigger === "onAssistantTurn");
  }

  has(name: string): boolean { return this.subs.has(name); }
  list(): string[] { return [...this.subs.keys()]; }

  destroyAll(): void {
    for (const inst of this.subs.values()) {
      try { inst.destroy(); } catch { /* ignore */ }
    }
    this.subs.clear();
    this.defs.clear();
  }
}
