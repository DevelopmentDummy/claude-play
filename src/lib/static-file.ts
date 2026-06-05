import * as path from "path";

/**
 * Content-Type lookup for static files served from disk. Superset of the
 * per-route maps that previously drifted (some omitted .svg / .gif / audio);
 * every shared extension maps to the same type, so consolidating here only
 * adds correct types for extensions that previously fell back to octet-stream.
 */
export const STATIC_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
};

/** Content-Type for a file path; defaults to application/octet-stream. */
export function mimeForPath(filePath: string): string {
  return STATIC_MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

/**
 * Resolve `relPath` against `baseDir` and ensure the result stays inside it
 * (blocks path traversal). Returns the absolute path, or null if it escapes.
 */
export function resolveInside(baseDir: string, relPath: string): string | null {
  const resolved = path.resolve(baseDir, relPath);
  if (!resolved.startsWith(baseDir + path.sep) && resolved !== baseDir) {
    return null;
  }
  return resolved;
}
