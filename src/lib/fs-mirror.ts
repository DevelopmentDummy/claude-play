// 범용 재귀 디렉터리 복사 / additive 미러 유틸. SessionManager에서 추출(Wave 12 cluster 6).
import * as fs from "fs";
import * as path from "path";

export function copyDirRecursive(src: string, dest: string, skip?: Set<string>): void {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (skip && skip.has(entry.name)) continue;
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
    if (skip && skip.has(entry.name)) continue;
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
