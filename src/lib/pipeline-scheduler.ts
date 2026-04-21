import { getInternalToken } from "./auth";
import { getSessionInstance } from "./session-registry";
import { wsBroadcast } from "./ws-server";

type SchedulerPhase = "idle" | "source" | "teacher" | "stopping" | "error";

interface SchedulerMetadata {
  label: string | null;
  source: string | null;
  requestedBy: string | null;
  note: string | null;
}

interface SchedulerHandle {
  sessionId: string;
  running: boolean;
  stopRequested: boolean;
  startedAt: number;
  lastTickAt: number | null;
  lastError: string | null;
  phase: SchedulerPhase;
  loopPromise: Promise<void> | null;
  metadata: SchedulerMetadata;
}

interface SchedulerRegistry {
  handles: Map<string, SchedulerHandle>;
}

const GLOBAL_KEY = "__claude_play_pipeline_scheduler__";

function getRegistry(): SchedulerRegistry {
  const g = globalThis as unknown as Record<string, SchedulerRegistry>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = { handles: new Map() };
  }
  return g[GLOBAL_KEY];
}

function apiBase(): string {
  return (process.env.CLAUDE_PLAY_API_BASE || `http://127.0.0.1:${process.env.PORT || "3340"}`).replace(/\/+$/, "");
}

async function requestJson(method: string, route: string, payload?: unknown) {
  const response = await fetch(`${apiBase()}${route}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-bridge-token": getInternalToken(),
    },
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const detail = data && typeof data === "object" && "error" in data ? (data as { error?: string }).error : text;
    throw new Error(`${method} ${route} failed (${response.status}): ${detail || "unknown error"}`);
  }
  return data as Record<string, unknown>;
}

async function runSessionTool(sessionId: string, tool: string, args: Record<string, unknown>) {
  return requestJson(
    "POST",
    `/api/sessions/${encodeURIComponent(sessionId)}/tools/${encodeURIComponent(tool)}`,
    { args },
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface SchedulerNotification {
  target: "client" | "ai";
  event?: string;
  payload?: unknown;
  mode?: "queue" | "send";
  message?: string;
}

async function processNotifications(sessionId: string, notifications: unknown): Promise<void> {
  if (!Array.isArray(notifications) || notifications.length === 0) return;

  for (const notif of notifications as SchedulerNotification[]) {
    try {
      if (notif.target === "client") {
        const eventType = notif.event || "scheduler:notify";
        wsBroadcast(eventType, notif.payload ?? {}, { sessionId });
      } else if (notif.target === "ai" && notif.message) {
        const instance = getSessionInstance(sessionId);
        if (!instance) {
          console.warn(`[scheduler:${sessionId}] notification skipped — no active instance`);
          continue;
        }
        if (notif.mode === "send") {
          await instance.sendMessage(notif.message);
        } else {
          // default: queue
          instance.queueEvent(notif.message);
        }
      }
    } catch (err) {
      console.error(`[scheduler:${sessionId}] notification error:`, err);
    }
  }
}

async function ensureStopped(sessionId: string): Promise<void> {
  try {
    await runSessionTool(sessionId, "engine", { action: "finish_scheduler" });
  } catch {
    // ignore
  }
}

async function schedulerLoop(handle: SchedulerHandle): Promise<void> {
  try {
    while (!handle.stopRequested) {
      handle.lastTickAt = Date.now();
      const tick = await runSessionTool(handle.sessionId, "pipeline", { action: "scheduler_tick" });
      const result = tick.result as Record<string, unknown> | undefined;
      if (!result || result.success !== true) {
        throw new Error(typeof result?.message === "string" ? result.message : "scheduler_tick failed");
      }

      const phase = typeof result.phase === "string" ? result.phase : "idle";
      handle.phase = phase === "source" || phase === "teacher" ? phase : "idle";

      // Process notifications from tick result
      await processNotifications(handle.sessionId, result.notifications);

      if (result.stopped === true || result.completed === true) {
        break;
      }

      await sleep(result.did_work === true ? 120 : 350);
    }
  } catch (error) {
    handle.phase = "error";
    handle.lastError = error instanceof Error ? error.message : String(error);
  } finally {
    handle.running = false;
    handle.loopPromise = null;
    if (handle.stopRequested) {
      handle.phase = "stopping";
    }
    await ensureStopped(handle.sessionId);
    getRegistry().handles.delete(handle.sessionId);
  }
}

export function getPipelineSchedulerState(sessionId: string): SchedulerHandle | null {
  return getRegistry().handles.get(sessionId) || null;
}

export function listPipelineSchedulers(): Array<{
  sessionId: string;
  running: boolean;
  stopRequested: boolean;
  startedAt: number;
  lastTickAt: number | null;
  lastError: string | null;
  phase: SchedulerPhase;
  metadata: SchedulerMetadata;
}> {
  return [...getRegistry().handles.values()]
    .map((handle) => ({
      sessionId: handle.sessionId,
      running: handle.running,
      stopRequested: handle.stopRequested,
      startedAt: handle.startedAt,
      lastTickAt: handle.lastTickAt,
      lastError: handle.lastError,
      phase: handle.phase,
      metadata: { ...handle.metadata },
    }))
    .sort((a, b) => b.startedAt - a.startedAt);
}

export function isPipelineSchedulerRunning(sessionId: string): boolean {
  return !!getPipelineSchedulerState(sessionId)?.running;
}

export async function startPipelineScheduler(
  sessionId: string,
  metadata?: Partial<SchedulerMetadata>,
): Promise<{ started: boolean; alreadyRunning: boolean }> {
  const registry = getRegistry();
  const existing = registry.handles.get(sessionId);
  if (existing?.running) {
    existing.metadata = {
      label: metadata?.label?.trim() || existing.metadata.label || null,
      source: metadata?.source?.trim() || existing.metadata.source || null,
      requestedBy: metadata?.requestedBy?.trim() || existing.metadata.requestedBy || null,
      note: metadata?.note?.trim() || existing.metadata.note || null,
    };
    return { started: false, alreadyRunning: true };
  }

  await runSessionTool(sessionId, "engine", { action: "start_scheduler" });

  const handle: SchedulerHandle = {
    sessionId,
    running: true,
    stopRequested: false,
    startedAt: Date.now(),
    lastTickAt: null,
    lastError: null,
    phase: "idle",
    loopPromise: null,
    metadata: {
      label: metadata?.label?.trim() || null,
      source: metadata?.source?.trim() || null,
      requestedBy: metadata?.requestedBy?.trim() || null,
      note: metadata?.note?.trim() || null,
    },
  };

  handle.loopPromise = schedulerLoop(handle);
  registry.handles.set(sessionId, handle);
  return { started: true, alreadyRunning: false };
}

export async function stopPipelineScheduler(sessionId: string): Promise<{ stopped: boolean; hadRunningHandle: boolean }> {
  const registry = getRegistry();
  const handle = registry.handles.get(sessionId) || null;

  if (!handle) {
    return { stopped: true, hadRunningHandle: false };
  }

  try {
    await runSessionTool(sessionId, "engine", { action: "stop_scheduler" });
  } catch (err) {
    console.warn(`[scheduler:${sessionId}] engine stop_scheduler failed:`, err);
  }

  handle.stopRequested = true;
  handle.phase = "stopping";
  return { stopped: true, hadRunningHandle: true };
}

export async function cleanupPipelineScheduler(sessionId: string): Promise<void> {
  await stopPipelineScheduler(sessionId);
}
