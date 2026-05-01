import * as fs from "fs";
import * as path from "path";
import type { SessionInstance } from "./session-instance";

const MARKER_FILENAME = ".restart-pending.json";
const PROCESSING_FILENAME = ".restart-pending.processing";
const TTL_MS = 10 * 60 * 1000;
const READY_WAIT_MS = 20_000;
const SILENT_MESSAGE = "[시스템] 서비스 재시작이 완료되었습니다. 작업을 이어가세요";

interface RestartMarker {
  triggeredAt: string;
  triggeredBy: string;
  sessionId: string;
}

/**
 * Drop a marker so the session that triggered the restart gets a silent
 * "restart completed" notification on the *next* server boot, when the
 * session is re-activated via /api/sessions/[id]/open.
 */
export function markRestartTriggered(
  sessionDir: string,
  sessionId: string,
  triggeredBy: string,
): void {
  const markerPath = path.join(sessionDir, MARKER_FILENAME);
  try {
    fs.mkdirSync(sessionDir, { recursive: true });
    const marker: RestartMarker = {
      triggeredAt: new Date().toISOString(),
      triggeredBy,
      sessionId,
    };
    fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2));
    console.log(`[restart-notify] marker written: ${markerPath} (by=${triggeredBy})`);
  } catch (err) {
    console.warn(`[restart-notify] failed to write marker ${markerPath}:`, err);
  }
}

/**
 * Atomically claim and consume any pending restart marker for this session.
 * If found and fresh (< TTL), fire a silent message to the AI.
 *
 * Safe to call on every session open — no marker means noop.
 * Atomic via rename: only the caller that wins the rename gets to fire.
 */
export async function consumeRestartMarker(
  sessionDir: string,
  instance: SessionInstance,
): Promise<void> {
  const markerPath = path.join(sessionDir, MARKER_FILENAME);
  const processingPath = path.join(sessionDir, PROCESSING_FILENAME);
  const exists = fs.existsSync(markerPath);
  console.log(`[restart-notify] consumeRestartMarker called: sessionDir=${sessionDir} markerExists=${exists}`);

  // Atomic claim — whichever caller renames first gets the marker
  try {
    fs.renameSync(markerPath, processingPath);
  } catch {
    // No marker (or another caller got it) — nothing to do
    return;
  }

  let marker: RestartMarker | null = null;
  try {
    const raw = fs.readFileSync(processingPath, "utf8");
    marker = JSON.parse(raw) as RestartMarker;
  } catch (err) {
    console.warn(`[restart-notify] failed to read marker:`, err);
  }

  // Always remove the processing file once we've read it
  try { fs.unlinkSync(processingPath); } catch { /* ignore */ }

  if (!marker || !marker.triggeredAt) {
    console.warn(`[restart-notify] marker had no triggeredAt — skipping`);
    return;
  }

  const ageMs = Date.now() - new Date(marker.triggeredAt).getTime();
  if (Number.isNaN(ageMs) || ageMs > TTL_MS) {
    console.log(`[restart-notify] discarding stale marker (age=${ageMs}ms) for ${marker.sessionId}`);
    return;
  }

  // The AI process may still be initializing (e.g. Codex's JSON-RPC handshake) —
  // wait until it's ready to accept input.
  const ready = await instance.waitForReady(READY_WAIT_MS);
  if (!ready) {
    console.warn(`[restart-notify] session ${marker.sessionId} did not become ready within ${READY_WAIT_MS}ms — dropping notification`);
    return;
  }

  console.log(`[restart-notify] delivering silent restart notification to ${marker.sessionId} (age=${ageMs}ms, by=${marker.triggeredBy})`);
  instance.sendToAI(SILENT_MESSAGE);
}
