/**
 * Compatibility layer — delegates to session-registry for per-session state.
 *
 * Routes that only need SessionManager can continue using getServices().sessions.
 * Routes that need session-specific state (process, panels, history) should use
 * getSessionInstance(id) from session-registry.
 */
import { SessionManager } from "./session-manager";
import {
  getSessionManager,
  destroyAllInstances,
} from "./session-registry";

// Re-export types
export type { HistoryMessage, AIProcess } from "./session-instance";
export { SessionInstance } from "./session-instance";

// Re-export registry functions for direct use
export {
  getSessionManager,
  getSessionInstance,
  openSessionInstance,
  closeSessionInstance,
  scheduleSessionCleanup,
  cancelSessionCleanup,
  listActiveInstances,
} from "./session-registry";

/** Minimal shared services interface (backward compatible for sessions-only routes) */
export interface Services {
  sessions: SessionManager;
}

/** Get shared services. For session-specific access, use getSessionInstance(id). */
export function getServices(): Services {
  return { sessions: getSessionManager() };
}

/** Clean up all services (server shutdown) */
export function cleanupServices(): void {
  destroyAllInstances();
}
