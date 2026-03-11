import { SessionManager } from "./session-manager";
import { SessionInstance, type BroadcastFn } from "./session-instance";
import { AIProvider } from "./ai-provider";
import { getDataDir, getAppRoot } from "./data-dir";
import { wsBroadcast } from "./ws-server";

/** Grace period before destroying an instance after last client disconnects */
const CLEANUP_GRACE_MS = 5000;

interface SessionRegistry {
  instances: Map<string, SessionInstance>;
  cleanupTimers: Map<string, ReturnType<typeof setTimeout>>;
  sessions: SessionManager;
}

const GLOBAL_KEY = "__claude_bridge_registry__";

function getRegistryState(): SessionRegistry {
  const g = globalThis as unknown as Record<string, SessionRegistry>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      instances: new Map(),
      cleanupTimers: new Map(),
      sessions: new SessionManager(getDataDir(), getAppRoot()),
    };
  }
  return g[GLOBAL_KEY];
}

/** Get the shared SessionManager (stateless file CRUD) */
export function getSessionManager(): SessionManager {
  return getRegistryState().sessions;
}

/** Get an active SessionInstance by ID (returns null if not open) */
export function getSessionInstance(id: string): SessionInstance | null {
  return getRegistryState().instances.get(id) || null;
}

/** Open (or reuse) a session instance. Returns the instance. */
export function openSessionInstance(
  id: string,
  isBuilder: boolean,
  provider: AIProvider,
): SessionInstance {
  const reg = getRegistryState();

  // Cancel any pending cleanup for this session
  cancelSessionCleanup(id);

  // If an instance already exists, check if provider matches
  const existing = reg.instances.get(id);
  if (existing) {
    if (existing.provider !== provider) {
      existing.switchProvider(provider);
    }
    return existing;
  }

  // Create new instance
  const broadcastFn: BroadcastFn = (event, data, filter) => {
    wsBroadcast(event, data, filter as Parameters<typeof wsBroadcast>[2]);
  };

  const instance = new SessionInstance(id, isBuilder, provider, reg.sessions, broadcastFn);
  reg.instances.set(id, instance);
  console.log(`[registry] Opened instance: ${id} (builder=${isBuilder}, provider=${provider})`);
  return instance;
}

/** Close and destroy a session instance immediately */
export function closeSessionInstance(id: string): void {
  const reg = getRegistryState();
  cancelSessionCleanup(id);
  const instance = reg.instances.get(id);
  if (instance) {
    instance.destroy();
    reg.instances.delete(id);
    console.log(`[registry] Closed instance: ${id}`);
  }
}

/** Schedule cleanup after grace period (called when last client disconnects) */
export function scheduleSessionCleanup(id: string): void {
  const reg = getRegistryState();
  cancelSessionCleanup(id);
  const timer = setTimeout(() => {
    reg.cleanupTimers.delete(id);
    closeSessionInstance(id);
  }, CLEANUP_GRACE_MS);
  reg.cleanupTimers.set(id, timer);
}

/** Cancel a pending cleanup (called when a client reconnects) */
export function cancelSessionCleanup(id: string): void {
  const reg = getRegistryState();
  const timer = reg.cleanupTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    reg.cleanupTimers.delete(id);
  }
}

/** List all active instances (for debug) */
export function listActiveInstances(): Array<{
  id: string;
  isBuilder: boolean;
  provider: string;
  running: boolean;
}> {
  const reg = getRegistryState();
  return [...reg.instances.entries()].map(([id, inst]) => ({
    id,
    isBuilder: inst.isBuilder,
    provider: inst.provider,
    running: inst.claude.isRunning(),
  }));
}

/** Destroy all instances (server shutdown) */
export function destroyAllInstances(): void {
  const reg = getRegistryState();
  for (const [id] of reg.instances) {
    closeSessionInstance(id);
  }
}
