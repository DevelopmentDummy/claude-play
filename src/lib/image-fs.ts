import * as fs from "fs";
import * as path from "path";

/** Reference-image input MIME types accepted by the image-generation APIs. */
const REF_IMAGE_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif",
};

/** MIME type for a reference image path; defaults to image/png for unknown extensions. */
export function refImageMime(filePath: string): string {
  return REF_IMAGE_MIME[path.extname(filePath).toLowerCase()] || "image/png";
}

/** Sanitize a relative file path: preserve subdirectories but prevent traversal. */
export function safeImagePath(filePath: string): string {
  const normalized = path.posix.normalize(filePath.replace(/\\/g, "/"));
  const segments = normalized.split("/").filter(s => s && s !== ".." && s !== ".");
  return segments.join("/") || path.basename(filePath);
}

/**
 * Write a generated image into the session's `images/` directory, creating any
 * intermediate dirs. Returns the relative path (`images/<safeName>`) suitable
 * for storing in a generation result.
 */
export function writeSessionImage(sessionDir: string, filename: string, buffer: Buffer): string {
  const imagesDir = path.join(sessionDir, "images");
  fs.mkdirSync(imagesDir, { recursive: true });
  const safeName = safeImagePath(filename);
  const filepath = path.join(imagesDir, safeName);
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, buffer);
  return `images/${safeName}`;
}
