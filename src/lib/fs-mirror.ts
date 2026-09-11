// 범용 재귀 디렉터리 복사 / additive 미러 유틸. SessionManager에서 추출(Wave 12 cluster 6).
import * as fs from "fs";
import * as path from "path";
import { createHash } from "node:crypto";

/** Refresh template files without deleting session-only files. Preserve replaced
 * bytes in content-addressed backups; an unchanged reopen does no writes. */
export function refreshDirectoryWithBackups(src: string, dest: string, backup: string): void {
  if (!fs.existsSync(src)) return;
  const ensureDirectory = (dir: string): void => {
    if (fs.existsSync(dir)) {
      const stat = fs.lstatSync(dir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe skill directory: ${dir}`);
    } else {
      const parent = path.dirname(dir);
      if (parent !== dir) ensureDirectory(parent);
      fs.mkdirSync(dir);
    }
  };
  const walk = (source: string, target: string, saved: string): void => {
    if (fs.lstatSync(source).isSymbolicLink()) throw new Error(`Linked skill source: ${source}`);
    ensureDirectory(target);
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      if (isTransientBackgroundLog(entry.name)) continue;
      if (entry.isSymbolicLink()) throw new Error(`Linked skill entry: ${entry.name}`);
      const from = path.join(source, entry.name);
      const to = path.join(target, entry.name);
      const old = path.join(saved, entry.name);
      if (entry.isDirectory()) { walk(from, to, old); continue; }
      if (!entry.isFile()) continue;
      const incoming = fs.readFileSync(from);
      if (fs.existsSync(to)) {
        if (!fs.lstatSync(to).isFile() || fs.lstatSync(to).isSymbolicLink()) throw new Error(`Unsafe skill target: ${to}`);
        const current = fs.readFileSync(to);
        if (current.equals(incoming)) continue;
        ensureDirectory(path.dirname(old));
        const savedFile = `${old}.${createHash("sha256").update(current).digest("hex")}.bak`;
        try { fs.writeFileSync(savedFile, current, { flag: "wx" }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if (!fs.lstatSync(savedFile).isFile() || fs.lstatSync(savedFile).isSymbolicLink() || !fs.readFileSync(savedFile).equals(current)) throw new Error(`Invalid skill backup: ${savedFile}`);
        }
      }
      fs.writeFileSync(to, incoming);
    }
  };
  // Validate existing ancestors too (a provider folder can itself be a junction).
  for (const root of [dest, backup]) {
    for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
      if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) throw new Error(`Linked skill directory: ${dir}`);
      if (path.dirname(dir) === dir) break;
    }
  }
  walk(src, dest, backup);
}

/** Transient background-AI runtime logs (background-<provider>.log) must never be
 *  mirrored or cloned into another persona/session dir, regardless of the caller's
 *  skip set — they are per-run artifacts, not template content. */
function isTransientBackgroundLog(name: string): boolean {
  return /^background-.*\.log$/.test(name);
}

export function copyDirRecursive(src: string, dest: string, skip?: Set<string>): void {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if ((skip && skip.has(entry.name)) || isTransientBackgroundLog(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/** Like copyDirRecursive but never overwrites existing files in dest.
 *  Recurses into subdirs so files newly added inside existing dirs are caught. */
export function mirrorAdditive(src: string, dest: string, skip?: Set<string>): void {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if ((skip && skip.has(entry.name)) || isTransientBackgroundLog(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      // Recurse even if destPath exists — catch new files inside existing subdirs.
      // Top-level skip set doesn't propagate to subdirs (intentional — e.g.
      // `images` skipped at top level but persona may add panels/img/*.png).
      mirrorAdditive(srcPath, destPath);
    } else if (!fs.existsSync(destPath)) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
