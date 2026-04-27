import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getDataDir } from "./data-dir";

export interface SessionListItem {
  id: string;
  title: string;
  createdAt: string;
  lastActivityAt: number;
  contextSizeBytes: number | null;
  lastMessage: { role: "user" | "assistant"; preview: string } | null;
  model: string;
  provider: "claude" | "codex" | "gemini";
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

function sessionsRoot(): string {
  return path.join(getDataDir(), "sessions");
}

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

function safeStat(filePath: string): { size: number; mtimeMs: number } | null {
  try {
    const st = fs.statSync(filePath);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

// Claude Code encodes the project cwd by replacing every char outside
// [A-Za-z0-9_] with "-". Multiple non-alnum chars therefore collapse into runs of "-".
function encodeCwd(absPath: string): string {
  return absPath.replace(/[^A-Za-z0-9_]/g, "-");
}

function claudeContextFile(sessionDir: string, claudeSessionId: string): string | null {
  const projectsRoot = path.join(os.homedir(), ".claude", "projects");
  const primary = path.join(projectsRoot, encodeCwd(sessionDir), `${claudeSessionId}.jsonl`);
  if (fs.existsSync(primary)) return primary;
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projectsRoot);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const candidate = path.join(projectsRoot, d, `${claudeSessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function codexContextFile(threadId: string, createdAtIso: string): string | null {
  const root = path.join(os.homedir(), ".codex", "sessions");
  const created = new Date(createdAtIso);
  if (Number.isNaN(created.getTime())) return null;
  for (const offset of [0, -1, 1, -2, 2]) {
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
    const hit = entries.find((f) => f.includes(threadId) && f.endsWith(".jsonl"));
    if (hit) return path.join(dayDir, hit);
  }
  return null;
}

// Read tail of chat-history.json and find the last user/assistant message.
// chat-history.json is a JSON array; some entries lack "role" (tool/meta blocks).
// Strategy: read the last TAIL_BYTES, find the last `"role":"(user|assistant)"`
// occurrence, walk back to its enclosing `{`, then forward via brace-counting
// (string-aware) to the matching `}`, and parse that single object.
function readLastMessage(historyPath: string): { role: "user" | "assistant"; preview: string } | null {
  let fd: number | null = null;
  try {
    const stat = fs.statSync(historyPath);
    if (stat.size === 0) return null;
    fd = fs.openSync(historyPath, "r");
    const len = Math.min(stat.size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, stat.size - len);
    const tail = buf.toString("utf-8");

    const re = /"role"\s*:\s*"(user|assistant)"/g;
    let lastRoleIdx = -1;
    let lastRole: "user" | "assistant" | null = null;
    let m: RegExpExecArray | null;
    while ((m = re.exec(tail)) !== null) {
      lastRoleIdx = m.index;
      lastRole = m[1] as "user" | "assistant";
    }
    if (lastRoleIdx < 0 || !lastRole) return null;

    // Walk back to the enclosing top-level `{` by counting unmatched closes,
    // ignoring chars inside JSON strings.
    let depth = 0;
    let start = -1;
    let inString = false;
    for (let i = lastRoleIdx; i >= 0; i--) {
      const ch = tail[i];
      // crude: skip string detection for backward scan; rely on JSON.parse
      // to validate. We just need the matching `{`.
      if (ch === "}") depth++;
      else if (ch === "{") {
        if (depth === 0) { start = i; break; }
        depth--;
      }
      void inString;
    }
    if (start < 0) return null;
    if (start === 0 && stat.size > tail.length) {
      // The object's start may be truncated by the tail window — skip.
      return null;
    }

    // Forward scan with proper string handling to find matching `}`.
    depth = 0;
    inString = false;
    let escaped = false;
    let end = -1;
    for (let i = start; i < tail.length; i++) {
      const ch = tail[i];
      if (escaped) { escaped = false; continue; }
      if (ch === "\\" && inString) { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end < 0) return null;

    let obj: { role?: string; content?: unknown; text?: string };
    try {
      obj = JSON.parse(tail.slice(start, end + 1));
    } catch {
      return null;
    }
    if (obj.role !== "user" && obj.role !== "assistant") return null;
    const text = extractText(obj);
    if (!text) return null;
    const oneLine = text.replace(/\s+/g, " ").trim();
    if (!oneLine) return null;
    const preview = oneLine.length > PREVIEW_LEN ? oneLine.slice(0, PREVIEW_LEN) + "…" : oneLine;
    return { role: obj.role as "user" | "assistant", preview };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function extractText(m: { content?: unknown; text?: string; parts?: unknown }): string {
  if (typeof m.text === "string") return m.text;
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map((c) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object") {
          const t = (c as { text?: string }).text;
          if (typeof t === "string") return t;
        }
        return "";
      })
      .join(" ");
  }
  if (Array.isArray(m.parts)) {
    return m.parts
      .map((p) => {
        if (typeof p === "string") return p;
        if (p && typeof p === "object") {
          const t = (p as { text?: string }).text;
          if (typeof t === "string") return t;
        }
        return "";
      })
      .join(" ");
  }
  return "";
}

function enrichSession(
  id: string,
  dir: string,
  meta: SessionMeta,
  currentId?: string,
): SessionListItem {
  const provider = detectProvider(meta.model);

  let contextPath: string | null = null;
  if (provider === "claude" && meta.claudeSessionId) {
    contextPath = claudeContextFile(dir, meta.claudeSessionId);
  } else if (provider === "codex" && meta.codexThreadId && meta.createdAt) {
    contextPath = codexContextFile(meta.codexThreadId, meta.createdAt);
  }
  // Gemini: location not yet identified; leave null.

  let contextSizeBytes: number | null = null;
  let contextMtime: number | null = null;
  if (contextPath) {
    const st = safeStat(contextPath);
    if (st) {
      contextSizeBytes = st.size;
      contextMtime = st.mtimeMs;
    }
  }

  const historyStat = safeStat(path.join(dir, "chat-history.json"));
  const sessionStat = safeStat(path.join(dir, "session.json"));
  const createdAtMs = meta.createdAt ? Date.parse(meta.createdAt) : Date.now();

  const lastActivityAt =
    contextMtime ?? historyStat?.mtimeMs ?? sessionStat?.mtimeMs ?? createdAtMs;

  const lastMessage = historyStat ? readLastMessage(path.join(dir, "chat-history.json")) : null;

  return {
    id,
    title: meta.title || id,
    createdAt: meta.createdAt || new Date(createdAtMs).toISOString(),
    lastActivityAt,
    contextSizeBytes,
    lastMessage,
    model: meta.model || "",
    provider,
    isCurrent: id === currentId,
  };
}

export function listSessionsForPersona(slug: string, currentId?: string): SessionListItem[] {
  const root = sessionsRoot();
  let folders: string[];
  try {
    folders = fs.readdirSync(root);
  } catch {
    return [];
  }
  const items: SessionListItem[] = [];
  for (const folder of folders) {
    const dir = path.join(root, folder);
    const meta = readMeta(dir);
    if (!meta || meta.persona !== slug) continue;
    items.push(enrichSession(folder, dir, meta, currentId));
  }
  items.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return items;
}
