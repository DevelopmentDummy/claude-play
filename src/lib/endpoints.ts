/**
 * Single source of truth for the service's own ports / base URLs.
 * Mirrors the port relationships defined in server.ts:
 *   TTS = PORT+1, GPU manager = PORT+2 (default PORT 3340 → 3341 / 3342).
 * Every consumer should use these instead of re-deriving the defaults, so a
 * non-default PORT stays consistent everywhere.
 *
 * NOTE: src/mcp/claude-play-mcp-server.mjs intentionally keeps its own copy
 * (a .mjs module that cannot import this .ts file).
 */
export function getPort(): number {
  return parseInt(process.env.PORT || "3340", 10);
}

export function getTtsPort(): number {
  return parseInt(process.env.TTS_PORT || String(getPort() + 1), 10);
}

export function getGpuManagerPort(): number {
  return parseInt(process.env.GPU_MANAGER_PORT || String(getPort() + 2), 10);
}

/** Self API base, e.g. http://127.0.0.1:3340 (honors CLAUDE_PLAY_API_BASE; no trailing slash). */
export function getApiBase(): string {
  return (process.env.CLAUDE_PLAY_API_BASE || `http://127.0.0.1:${getPort()}`).replace(/\/+$/, "");
}

/** GPU manager base URL, e.g. http://127.0.0.1:3342 */
export function getGpuManagerUrl(): string {
  return `http://127.0.0.1:${getGpuManagerPort()}`;
}

/** Edge-TTS server base URL, e.g. http://127.0.0.1:3341 */
export function getTtsServerUrl(): string {
  return `http://127.0.0.1:${getTtsPort()}`;
}
