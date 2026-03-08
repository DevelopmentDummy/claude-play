import * as crypto from "crypto";

// ── Internal token for MCP server authentication ──
// MCP server processes use this token to authenticate API calls back to Bridge.
const INTERNAL_TOKEN_KEY = "__claude_bridge_internal_token__";

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
