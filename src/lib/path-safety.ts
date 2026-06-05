/**
 * Path-segment safety checks shared by API routes that take a session id or
 * persona name as a single path segment and use it to build a filesystem path.
 */

/**
 * True when a path segment is empty or contains separators / traversal
 * sequences — i.e. unsafe to use as a single component of a filesystem path.
 */
export function isUnsafePathSegment(value: string | undefined | null): boolean {
  return !value || value.includes("/") || value.includes("..") || value.includes("\\");
}
