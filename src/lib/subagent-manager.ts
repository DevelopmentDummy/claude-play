import { SubAgentInstance } from "./subagent-instance";
import { SubAgentDef } from "./subagent-manifest";
import { loadThreadManifest, ThreadManifest, ThreadDef, RoleDef } from "./thread-manifest";
import { reconcileThreads, applyThreadOps } from "./thread-registry";
import type { ThreadSpawnRequest } from "./world-engine";
import { AIProvider } from "./ai-provider";
import type { TranscriptEntry, TranscriptOrigin } from "./subagent-transcript";

/** 매니페스트의 역할 + 라이브 스레드 목록 → SubAgentInstance가 먹는 def 배열.
 *  순수 함수라 테스트 가능하다. */
export function buildThreadDefs(manifest: ThreadManifest, threads: ThreadDef[]): SubAgentDef[] {
  const defs: SubAgentDef[] = [];
  for (const t of threads) {
    const role: RoleDef | undefined = manifest.roles.get(t.role);
    if (!role) continue;
    defs.push({
      name: role.name,
      role: role.description,
      provider: role.provider ?? "claude",
      providerExplicit: role.provider,
      model: role.model,
      effort: role.effort,
      instructions: role.instructions,
      instructionsFromSessionRoot: role.instructionsFromSessionRoot,
      delegable: role.delegable,
      autoTrigger: role.loop.mode === "onAssistantTurn" ? "onAssistantTurn" : "none",
      autoTriggerTask: role.autoTriggerTask,
      emitSummary: role.emitSummary,
      threadId: t.threadId,
      params: t.params,
      scope: role.scope,
    });
  }
  return defs;
}

/** Owns the sub-agent instances for one session. Created and held by the parent
 *  SessionInstance; lifecycle is tied to the parent (spawnAll on open, destroyAll
 *  on parent destroy). */
export class SubAgentManager {
  private readonly sessionId: string;
  private readonly getDir: () => string | null;
  private readonly broadcast?: (event: string, data: unknown) => void;
  private subs = new Map<string, SubAgentInstance>();
  private defs = new Map<string, SubAgentDef>();
  private _manifest: ThreadManifest | null = null;

  constructor(
    sessionId: string,
    getDir: () => string | null,
    broadcast?: (event: string, data: unknown) => void,
  ) {
    this.sessionId = sessionId;
    this.getDir = getDir;
    this.broadcast = broadcast;
  }

  /** Read the manifest and spawn every declared sub-agent. By default a sub follows the
   *  SESSION's provider/model/effort, but a sub MAY override per-agent via the manifest
   *  (model/effort, and explicit provider) — those take precedence; unset fields fall back
   *  to the session's. Safe to call again (re-open): already-running subs with the same
   *  resolved runtime are left as-is; if the resolved provider/model/effort changed, the
   *  cached sub is destroyed and recreated. Manifest errors are logged, never thrown into
   *  the open flow. */
  spawnAll(provider: AIProvider, model?: string, effort?: string): void {
    const dir = this.getDir();
    if (!dir) return;
    let manifest: ThreadManifest;
    try {
      manifest = loadThreadManifest(dir);
    } catch (err) {
      console.error(`[subagent-manager:${this.sessionId}] manifest invalid:`, (err as Error).message);
      return;
    }
    this._manifest = manifest;
    // threads.json이 진실 — 런타임에 스폰된 스레드가 재open에서 살아남는다.
    const defs: SubAgentDef[] = buildThreadDefs(manifest, reconcileThreads(dir, manifest));
    for (const def of defs) {
      // 키는 threadId다 — 같은 역할에서 여러 스레드가 뜨므로 역할 이름으로는 구분되지 않는다.
      const key = def.threadId ?? def.name;
      this.defs.set(key, def);
      // Per-sub overrides take precedence; unset → session value. providerExplicit is set
      // only when the manifest actually specified a provider (avoids forcing "claude" on all).
      const subProvider = def.providerExplicit ?? provider;
      const subModel = def.model ?? model;
      // effort: explicit sub effort wins; else inherit the session effort ONLY when the sub
      // runs on the same provider as the session (a foreign provider's effort scale differs);
      // otherwise leave undefined so that provider's own default applies.
      const subEffort = def.effort ?? (subProvider === provider ? effort : undefined);
      let inst = this.subs.get(key);
      if (inst && (inst.provider !== subProvider || inst.model !== subModel || inst.effort !== subEffort)) {
        try { inst.destroy(); } catch { /* ignore */ }
        this.subs.delete(key);
        inst = undefined;
      }
      if (!inst) {
        const subName = key;
        inst = new SubAgentInstance(
          def, dir, this.sessionId, subProvider, subModel, subEffort,
          (entry) => this.broadcast?.("subagent:message", { name: subName, entry }),
          (busy) => this.broadcast?.("subagent:status", { name: subName, busy }),
        );
        this.subs.set(key, inst);
      }
      try { inst.start(); } catch (err) {
        console.error(`[subagent-manager:${this.sessionId}] start ${key} failed:`, err);
      }
    }
    // 레지스트리에서 빠진 스레드의 인스턴스는 파괴한다 (재open 시 목록이 줄어든 경우).
    const liveKeys = new Set(defs.map((d) => d.threadId ?? d.name));
    for (const [key, inst] of [...this.subs]) {
      if (liveKeys.has(key)) continue;
      try { inst.destroy(); } catch { /* ignore */ }
      this.subs.delete(key);
      this.defs.delete(key);
    }
  }

  manifest(): ThreadManifest | null { return this._manifest; }

  /** loop.mode === "loop"인 살아있는 스레드들. thread-loop이 소비한다. */
  loopThreads(): Array<{ threadId: string; role: RoleDef }> {
    const m = this._manifest;
    if (!m) return [];
    const out: Array<{ threadId: string; role: RoleDef }> = [];
    for (const [key, def] of this.defs) {
      const role = m.roles.get(def.name);
      if (role && role.loop.mode === "loop") out.push({ threadId: key, role });
    }
    return out;
  }

  /** 스레드가 바쁜지 — 루프가 틱을 건너뛸지 판단한다. */
  isBusy(threadId: string): boolean {
    return this.subs.get(threadId)?.isBusy() ?? false;
  }

  /** 스레드의 컨텍스트를 버리고 재prime 준비 상태로 만든다 (thread-loop 5단계). */
  resetThread(threadId: string): void {
    const inst = this.subs.get(threadId);
    if (!inst) return;
    try { inst.resetContext(); } catch (err) {
      console.error(`[subagent-manager:${this.sessionId}] resetThread ${threadId} 실패:`, err);
    }
  }

  /** step()이 요청한 스폰/소멸을 적용한다. 새 스레드는 즉시 띄우고, 소멸분은 파괴한다. */
  applyOps(
    ops: { spawn?: ThreadSpawnRequest[]; despawn?: string[] },
    provider: AIProvider, model?: string, effort?: string,
  ): void {
    const dir = this.getDir();
    const m = this._manifest;
    if (!dir || !m) return;
    const live = applyThreadOps(dir, m, ops);
    // despawn: 인스턴스를 먼저 죽인다. 턴 중이어도 destroy가 프로세스를 정리한다.
    const liveIds = new Set(live.map((t) => t.threadId));
    for (const [key, inst] of [...this.subs]) {
      if (liveIds.has(key)) continue;
      try { inst.destroy(); } catch { /* ignore */ }
      this.subs.delete(key);
      this.defs.delete(key);
    }
    // spawn: 새 def만 띄운다 (기존 인스턴스는 그대로).
    for (const def of buildThreadDefs(m, live)) {
      const key = def.threadId ?? def.name;
      if (this.subs.has(key)) continue;
      this.defs.set(key, def);
      const subProvider = def.providerExplicit ?? provider;
      const inst = new SubAgentInstance(
        def, dir, this.sessionId,
        subProvider,
        def.model ?? model,
        def.effort ?? (subProvider === provider ? effort : undefined),
        (entry) => this.broadcast?.("subagent:message", { name: key, entry }),
        (busy) => this.broadcast?.("subagent:status", { name: key, busy }),
      );
      this.subs.set(key, inst);
      try { inst.start(); } catch (err) {
        console.error(`[subagent-manager:${this.sessionId}] start ${key} failed:`, err);
      }
    }
  }

  /** Route a task to a named sub. Returns false if unknown/undeclared. */
  dispatch(name: string, task: string, origin: TranscriptOrigin = "delegate"): boolean {
    const inst = this.subs.get(name);
    if (!inst) {
      console.warn(`[subagent-manager:${this.sessionId}] dispatch to unknown sub "${name}"`);
      return false;
    }
    inst.dispatch(task, origin);
    return true;
  }

  /** Defs whose autoTrigger === "onAssistantTurn" (with their default task). */
  autoTriggerDefs(): SubAgentDef[] {
    return [...this.defs.values()].filter(d => d.autoTrigger === "onAssistantTurn");
  }

  /** Record a sub→main report into the named sub's transcript. Returns false if unknown. */
  recordReport(name: string, summary: string): boolean {
    const inst = this.subs.get(name);
    if (!inst) return false;
    inst.recordReport(summary);
    return true;
  }

  /** Detailed list for the chat modal sidebar. `busy` lets a (re)connecting client
   *  seed the in-progress indicator without waiting for the next subagent:status event. */
  listDetailed(): Array<{ name: string; role: string; provider: AIProvider; model?: string; running: boolean; busy: boolean }> {
    return [...this.subs.values()].map((s) => ({
      name: s.name,
      role: s.def.role,
      provider: s.provider,
      model: s.model,
      running: s.isRunning(),
      busy: s.isBusy(),
    }));
  }

  /** Tail of a named sub's transcript. Returns [] if unknown. */
  readTranscript(name: string, n: number): TranscriptEntry[] {
    const inst = this.subs.get(name);
    return inst ? inst.readTranscript(n) : [];
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
