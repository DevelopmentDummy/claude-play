import * as crypto from "crypto";

// ── Internal token for MCP server authentication ──
// MCP server processes use this token to authenticate API calls back to Bridge.
const INTERNAL_TOKEN_KEY = "__claude_play_internal_token__";

export function getInternalToken(): string {
  const g = globalThis as unknown as Record<string, string>;
  if (!g[INTERNAL_TOKEN_KEY]) {
    g[INTERNAL_TOKEN_KEY] = crypto.randomBytes(32).toString("hex");
  }
  return g[INTERNAL_TOKEN_KEY];
}

/** Validate internal token from MCP server request. Returns true if valid. */
export function validateInternalToken(req: Request): boolean {
  const token = req.headers.get("x-bridge-token");
  return !!token && token === getInternalToken();
}

// ── Admin authentication ──
const AUTH_COOKIE_NAME = "bridge_auth";
const AUTH_SALT = "claude-play-auth";
const TOKEN_MAX_AGE = 90 * 24 * 60 * 60; // 90 days in seconds

/** Check if admin auth is enabled (ADMIN_PASSWORD env var is set) */
export function isAuthEnabled(): boolean {
  return !!process.env.ADMIN_PASSWORD;
}

/** Derive signing key from password + salt */
function deriveKey(): Buffer {
  return crypto.createHash("sha256").update(process.env.ADMIN_PASSWORD + AUTH_SALT).digest();
}

/** Create signed auth token */
export function createAuthToken(): string {
  const payload = Buffer.from(JSON.stringify({ ts: Date.now() }));
  const sig = crypto.createHmac("sha256", deriveKey()).update(payload).digest();
  return payload.toString("base64url") + "." + sig.toString("base64url");
}

/** Verify auth token. Returns true if valid and not expired. */
export function verifyAuthToken(token: string): boolean {
  try {
    const [payloadB64, sigB64] = token.split(".");
    if (!payloadB64 || !sigB64) return false;

    const payload = Buffer.from(payloadB64, "base64url");
    const sig = Buffer.from(sigB64, "base64url");
    const expected = crypto.createHmac("sha256", deriveKey()).update(payload).digest();

    if (sig.length !== expected.length) return false;
    if (!crypto.timingSafeEqual(sig, expected)) return false;

    const { ts } = JSON.parse(payload.toString());
    if (Date.now() - ts > TOKEN_MAX_AGE * 1000) return false;

    return true;
  } catch {
    return false;
  }
}

/** Verify password with timing-safe comparison (hash both to avoid length leak) */
export function verifyPassword(input: string): boolean {
  const password = process.env.ADMIN_PASSWORD || "";
  const inputHash = crypto.createHash("sha256").update(input).digest();
  const passwordHash = crypto.createHash("sha256").update(password).digest();
  return crypto.timingSafeEqual(inputHash, passwordHash);
}

/** Parse auth token from raw Cookie header string (for WebSocket/raw HTTP) */
export function parseCookieToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${AUTH_COOKIE_NAME}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export { AUTH_COOKIE_NAME, TOKEN_MAX_AGE };
