import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getDataDir } from "./data-dir";

export interface ConversationListItem {
  /** Provider-side conversation/session id (jsonl name, codex thread id, gemini session id) */
  conversationId: string;
  provider: "claude" | "codex" | "gemini";
  filePath: string;
  sizeBytes: number;
  mtime: number;
  lastMessage: { role: "user" | "assistant"; preview: string } | null;
  /** True when this conversationId matches the one currently linked in session.json */
  isCurrent: boolean;
}

interface SessionMeta {
  persona?: string;
  title?: string;
  createdAt?: string;
  model?: string;
  claudeSessionId?: string;
  codexThreadId?: string;
  geminiSessionId?: string;
}

const TAIL_BYTES = 256 * 1024;
const PREVIEW_LEN = 60;

function readMeta(folderPath: string): SessionMeta | null {
  try {
    const raw = fs.readFileSync(path.join(folderPath, "session.json"), "utf-8");
    return JSON.parse(raw) as SessionMeta;
  } catch {
    return null;
  }
}

function detectProvider(model?: string): "claude" | "codex" | "gemini" {
  if (!model) return "claude";
  const lower = model.split(":")[0].toLowerCase();
  if (/^(gpt-5|codex-mini|o3|o4)/.test(lower)) return "codex";
  if (/^gemini/.test(lower)) return "gemini";
  return "claude";
}

// Claude Code encodes the project cwd by replacing every char outside [A-Za-z0-9]
// with "-" — underscores included.
// Example: "C:\repo\claude bridge\data\sessions\be_a_god-2026-04-21T19-18-59"
//       => "C--repo-claude-bridge-data-sessions-be-a-god-2026-04-21T19-18-59"
function encodeCwd(absPath: string): string {
  return absPath.replace(/[^A-Za-z0-9]/g, "-");
}

function safeStat(filePath: string): { size: number; mtimeMs: number } | null {
  try {
    const st = fs.statSync(filePath);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

function listClaudeConversations(sessionDir: string, currentId?: string): ConversationListItem[] {
  const projectsRoot = path.join(os.homedir(), ".claude", "projects");
  const expectedFolder = path.join(projectsRoot, encodeCwd(sessionDir));
  const items: ConversationListItem[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(expectedFolder);
  } catch {
    return items;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    const conversationId = entry.replace(/\.jsonl$/, "");
    const filePath = path.join(expectedFolder, entry);
    const st = safeStat(filePath);
    if (!st) continue;
    items.push({
      conversationId,
      provider: "claude",
      filePath,
      sizeBytes: st.size,
      mtime: st.mtimeMs,
      lastMessage: readLastClaudeMessage(filePath),
      isCurrent: conversationId === currentId,
    });
  }
  return items;
}

function listCodexConversations(_sessionDir: string, sessionMeta: SessionMeta, currentId?: string): ConversationListItem[] {
  // Codex sessions are filed by date under ~/.codex/sessions/YYYY/MM/DD/.
  // There's no per-cwd folder, so we have to walk a date window and filter
  // by cwd recorded inside each rollout file. For now we only list rollouts
  // whose date is near the session's createdAt — a reasonable heuristic.
  const root = path.join(os.homedir(), ".codex", "sessions");
  const created = sessionMeta.createdAt ? new Date(sessionMeta.createdAt) : null;
  if (!created || Number.isNaN(created.getTime())) return [];
  const items: ConversationListItem[] = [];
  // Scan ±60 days around creation to cover long-running sessions.
  for (let offset = -60; offset <= 60; offset++) {
    const dt = new Date(created);
    dt.setDate(dt.getDate() + offset);
    const dayDir = path.join(
      root,
      String(dt.getFullYear()),
      String(dt.getMonth() + 1).padStart(2, "0"),
      String(dt.getDate()).padStart(2, "0"),
    );
    let entries: string[];
    try {
      entries = fs.readdirSync(dayDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const filePath = path.join(dayDir, entry);
      // rollout filenames look like rollout-<date>-<threadId>.jsonl
      const m = entry.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/);
      if (!m) continue;
      const threadId = m[1];
      // Filter to rollouts whose recorded cwd matches our session dir.
      if (!rolloutMatchesCwd(filePath, _sessionDir)) continue;
      const st = safeStat(filePath);
      if (!st) continue;
      items.push({
        conversationId: threadId,
        provider: "codex",
        filePath,
        sizeBytes: st.size,
        mtime: st.mtimeMs,
        lastMessage: readLastCodexMessage(filePath),
        isCurrent: threadId === currentId,
      });
    }
  }
  return items;
}

function rolloutMatchesCwd(filePath: string, sessionDir: string): boolean {
  // Read first 4KB, search for `"cwd":"..."` entry.
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(4096);
    fs.readSync(fd, buf, 0, 4096, 0);
    const head = buf.toString("utf-8");
    const m = head.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)+)"/);
    if (!m) return false;
    // JSON-decode the captured string (handle backslash escapes).
    let cwd: string;
    try { cwd = JSON.parse(`"${m[1]}"`); } catch { cwd = m[1]; }
    return path.resolve(cwd) === path.resolve(sessionDir);
  } catch {
    return false;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

function readLastClaudeMessage(filePath: string): { role: "user" | "assistant"; preview: string } | null {
  return readLastJsonlMessage(filePath, (raw) => {
    // Claude jsonl: { type: "user" | "assistant", message: { role, content: [{type:"text", text}, ...] }, ... }
    if (!raw || typeof raw !== "object") return null;
    const obj = raw as { type?: unknown; message?: { content?: unknown } };
    if (obj.type !== "user" && obj.type !== "assistant") return null;
    const role = obj.type as "user" | "assistant";
    const message = obj.message;
    if (!message) return null;
    const content = message.content;
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part === "object") {
          const t = (part as { text?: string }).text;
          if (typeof t === "string") text += t + " ";
        } else if (typeof part === "string") {
          text += part + " ";
        }
      }
    }
    text = text.trim();
    if (!text) return null;
    return { role, text };
  });
}

function readLastCodexMessage(filePath: string): { role: "user" | "assistant"; preview: string } | null {
  return readLastJsonlMessage(filePath, (obj) => {
    // Codex rollout entries are diverse; try common shapes.
    const o = obj as Record<string, unknown>;
    const role = (o.role || o.type) as string | undefined;
    if (role !== "user" && role !== "assistant") return null;
    let text = "";
    if (typeof o.text === "string") text = o.text;
    else if (typeof o.content === "string") text = o.content;
    else if (Array.isArray(o.content)) {
      for (const part of o.content) {
        if (part && typeof part === "object") {
          const t = (part as { text?: string }).text;
          if (typeof t === "string") text += t + " ";
        }
      }
    }
    text = text.trim();
    if (!text) return null;
    return { role, text };
  });
}

function readLastJsonlMessage(
  filePath: string,
  extract: (obj: unknown) => { role: "user" | "assistant"; text: string } | null,
): { role: "user" | "assistant"; preview: string } | null {
  let fd: number | null = null;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size === 0) return null;
    fd = fs.openSync(filePath, "r");
    const len = Math.min(stat.size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, stat.size - len);
    const tail = buf.toString("utf-8");
    const lines = tail.split(/\r?\n/);
    // Drop the first line if the tail window started mid-file (it may be truncated).
    const safeLines = stat.size > tail.length ? lines.slice(1) : lines;
    for (let i = safeLines.length - 1; i >= 0; i--) {
      const line = safeLines[i].trim();
      if (!line) continue;
      let obj: unknown;
      try { obj = JSON.parse(line); } catch { continue; }
      const hit = extract(obj);
      if (!hit) continue;
      const oneLine = hit.text.replace(/\s+/g, " ").trim();
      if (!oneLine) continue;
      const preview = oneLine.length > PREVIEW_LEN ? oneLine.slice(0, PREVIEW_LEN) + "…" : oneLine;
      return { role: hit.role, preview };
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

/**
 * List all provider-side conversations (Claude/Codex/Gemini) tied to the given
 * app session directory, sorted by mtime desc. Used by the "Sessions" menu so
 * the user can pick a different conversation to resume.
 */
export function listConversationsForSession(sessionId: string): {
  provider: "claude" | "codex" | "gemini";
  currentId: string | null;
  items: ConversationListItem[];
} {
  const sessionDir = path.join(getDataDir(), "sessions", sessionId);
  const meta = readMeta(sessionDir);
  if (!meta) return { provider: "claude", currentId: null, items: [] };

  const provider = detectProvider(meta.model);
  const currentId =
    provider === "claude" ? meta.claudeSessionId :
    provider === "codex" ? meta.codexThreadId :
    meta.geminiSessionId;

  let items: ConversationListItem[] = [];
  if (provider === "claude") {
    items = listClaudeConversations(sessionDir, currentId);
  } else if (provider === "codex") {
    items = listCodexConversations(sessionDir, meta, currentId);
  }
  // Gemini: storage location not yet identified; return empty list.

  items.sort((a, b) => b.mtime - a.mtime);
  return { provider, currentId: currentId ?? null, items };
}

/** Update session.json's provider conversation id for resume. */
export function relinkConversation(sessionId: string, conversationId: string): { ok: true } | { ok: false; error: string } {
  const sessionDir = path.join(getDataDir(), "sessions", sessionId);
  const metaPath = path.join(sessionDir, "session.json");
  let meta: SessionMeta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as SessionMeta;
  } catch (e) {
    return { ok: false, error: `cannot read session.json: ${(e as Error).message}` };
  }
  const provider = detectProvider(meta.model);
  if (provider === "claude") meta.claudeSessionId = conversationId;
  else if (provider === "codex") meta.codexThreadId = conversationId;
  else meta.geminiSessionId = conversationId;
  try {
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
  } catch (e) {
    return { ok: false, error: `cannot write session.json: ${(e as Error).message}` };
  }
  return { ok: true };
}
