import Database from "better-sqlite3";
import * as bcrypt from "bcryptjs";
import * as crypto from "crypto";
import * as path from "path";
import * as fs from "fs";
import { getDataDir } from "./data-dir";

const DB_NAME = "bridge.db";
const COOKIE_NAME = "cb_token";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;
  const dataDir = getDataDir();
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  db = new Database(path.join(dataDir, DB_NAME));
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
  `);
  return db;
}

export interface User {
  id: string;
  username: string;
  display_name: string;
  created_at: number;
}

export function createUser(username: string, password: string, displayName?: string): User {
  const d = getDb();
  const id = crypto.randomUUID();
  const hash = bcrypt.hashSync(password, 10);
  const name = displayName || username;
  d.prepare("INSERT INTO users (id, username, password_hash, display_name) VALUES (?, ?, ?, ?)").run(id, username, hash, name);
  return { id, username, display_name: name, created_at: Math.floor(Date.now() / 1000) };
}

export function loginUser(username: string, password: string): { user: User; token: string } | null {
  const d = getDb();
  const row = d.prepare("SELECT * FROM users WHERE username = ?").get(username) as {
    id: string; username: string; password_hash: string; display_name: string; created_at: number;
  } | undefined;
  if (!row) return null;
  if (!bcrypt.compareSync(password, row.password_hash)) return null;
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = Math.floor((Date.now() + SESSION_TTL_MS) / 1000);
  d.prepare("INSERT INTO auth_sessions (token, user_id, expires_at) VALUES (?, ?, ?)").run(token, row.id, expiresAt);
  return {
    user: { id: row.id, username: row.username, display_name: row.display_name, created_at: row.created_at },
    token,
  };
}

export function validateToken(token: string): User | null {
  const d = getDb();
  const now = Math.floor(Date.now() / 1000);
  // Clean expired sessions
  d.prepare("DELETE FROM auth_sessions WHERE expires_at < ?").run(now);
  const row = d.prepare(`
    SELECT u.id, u.username, u.display_name, u.created_at
    FROM auth_sessions s JOIN users u ON s.user_id = u.id
    WHERE s.token = ? AND s.expires_at > ?
  `).get(token, now) as User | undefined;
  return row || null;
}

export function deleteToken(token: string): void {
  getDb().prepare("DELETE FROM auth_sessions WHERE token = ?").run(token);
}

export function getUserCount(): number {
  return (getDb().prepare("SELECT COUNT(*) as cnt FROM users").get() as { cnt: number }).cnt;
}

/** Extract userId from request cookies. Returns null if invalid. */
export function getUserIdFromRequest(req: Request): string | null {
  const cookie = req.headers.get("cookie") || "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  if (!match) return null;
  const user = validateToken(match[1]);
  return user?.id || null;
}

/** Require auth — returns userId or 401 Response */
export function requireAuth(req: Request): { userId: string } | Response {
  // 1) Cookie-based auth (browser)
  const userId = getUserIdFromRequest(req);
  if (userId) return { userId };

  // 2) Internal token auth (MCP server)
  const token = req.headers.get(INTERNAL_HEADER);
  const internalUserId = req.headers.get(INTERNAL_USER_HEADER);
  if (token && internalUserId && token === getInternalToken()) {
    return { userId: internalUserId };
  }

  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

/** Extract token from cookie header string (for WebSocket upgrade) */
export function getUserIdFromCookie(cookieHeader: string): string | null {
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  if (!match) return null;
  const user = validateToken(match[1]);
  return user?.id || null;
}

// ── Internal token for MCP server authentication ──
const INTERNAL_TOKEN_KEY = "__claude_bridge_internal_token__";
const INTERNAL_HEADER = "x-bridge-token";
const INTERNAL_USER_HEADER = "x-bridge-user-id";

export function getInternalToken(): string {
  const g = globalThis as unknown as Record<string, string>;
  if (!g[INTERNAL_TOKEN_KEY]) {
    g[INTERNAL_TOKEN_KEY] = crypto.randomBytes(32).toString("hex");
  }
  return g[INTERNAL_TOKEN_KEY];
}

export { COOKIE_NAME };
