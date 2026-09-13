import * as path from "path";
import { readSessionJson, atomicWriteJsonSync } from "./session-state";
import { ThreadDef, ThreadManifest, THREAD_ID_RE, THREAD_MAX } from "./thread-manifest";
import type { ThreadSpawnRequest } from "./world-engine";

const FILE = "threads.json";

function regPath(sessionDir: string): string {
  return path.join(sessionDir, FILE);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** threads.json을 읽는다. 없거나 깨졌으면 빈 배열. */
export function readLiveThreads(sessionDir: string): ThreadDef[] {
  let raw: unknown;
  try {
    raw = readSessionJson(regPath(sessionDir));
  } catch {
    return [];
  }
  if (!isObject(raw) || !Array.isArray(raw.threads)) return [];
  const out: ThreadDef[] = [];
  for (const entry of raw.threads) {
    if (!isObject(entry)) continue;
    const threadId = String(entry.threadId ?? "");
    const role = String(entry.role ?? "");
    if (!THREAD_ID_RE.test(threadId) || !role) continue;
    out.push({ threadId, role, params: isObject(entry.params) ? entry.params : {} });
  }
  return out;
}

export function writeLiveThreads(sessionDir: string, threads: ThreadDef[]): void {
  atomicWriteJsonSync(regPath(sessionDir), { version: 1, threads });
}

/** 매니페스트의 역할에 속하는 스레드만 남긴다. */
function keepKnownRoles(threads: ThreadDef[], manifest: ThreadManifest): ThreadDef[] {
  return threads.filter((t) => manifest.roles.has(t.role));
}

/**
 * 세션 open 시 살아있는 스레드 목록을 확정한다.
 * - threads.json이 있으면 그것이 진실 (런타임 스폰 결과가 보존된다)
 * - 없으면 매니페스트의 threads[]로 시드하고 파일을 만든다
 */
export function reconcileThreads(sessionDir: string, manifest: ThreadManifest): ThreadDef[] {
  const stored = readLiveThreads(sessionDir);
  if (stored.length > 0) {
    const kept = keepKnownRoles(stored, manifest);
    if (kept.length !== stored.length) writeLiveThreads(sessionDir, kept);
    return kept;
  }
  const seeded = keepKnownRoles(manifest.threads, manifest).slice(0, THREAD_MAX);
  writeLiveThreads(sessionDir, seeded);
  return seeded;
}

/** step()이 요청한 스폰/소멸을 적용하고 영속화한다. 잘못된 요청은 조용히 무시한다. */
export function applyThreadOps(
  sessionDir: string,
  manifest: ThreadManifest,
  ops: { spawn?: ThreadSpawnRequest[]; despawn?: string[] },
): ThreadDef[] {
  const byId = new Map<string, ThreadDef>();
  for (const t of readLiveThreads(sessionDir)) byId.set(t.threadId, t);

  for (const id of ops.despawn ?? []) byId.delete(String(id));

  for (const req of ops.spawn ?? []) {
    if (!req || typeof req !== "object") continue;
    const threadId = String(req.threadId ?? "");
    const role = String(req.role ?? "");
    if (!THREAD_ID_RE.test(threadId)) {
      console.warn(`[thread-registry] spawn 무시 — 잘못된 threadId "${threadId}"`);
      continue;
    }
    if (!manifest.roles.has(role)) {
      console.warn(`[thread-registry] spawn 무시 — 알 수 없는 역할 "${role}"`);
      continue;
    }
    if (!byId.has(threadId) && byId.size >= THREAD_MAX) {
      console.warn(`[thread-registry] spawn 무시 — 스레드 상한 ${THREAD_MAX} 도달`);
      continue;
    }
    const params = isObject(req.params) ? req.params : {};
    byId.set(threadId, { threadId, role, params });
  }

  const next = [...byId.values()];
  writeLiveThreads(sessionDir, next);
  return next;
}
