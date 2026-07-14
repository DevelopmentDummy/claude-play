import * as fs from "fs";
import * as path from "path";

/**
 * 생성 클라이언트(comfyui-client, image-fs)는 `{dir}/images/` 저장을 전제한다.
 * 외부(outputDir) 분기는 생성 완료 후 이 헬퍼로 파일을 outputDir 직하로 옮긴다.
 * relPath는 클라이언트가 반환한 상대경로(`images/foo.png` 형태). 절대경로를 반환한다.
 */
export function flattenGeneratedFile(outputDir: string, relPath: string): string {
  const normalized = relPath.replace(/\\/g, "/");
  const rel = normalized.startsWith("images/") ? normalized.slice("images/".length) : normalized;
  const src = path.join(outputDir, normalized);
  const dest = path.join(outputDir, rel);
  if (src !== dest && fs.existsSync(src)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.rmSync(dest, { force: true });
    fs.renameSync(src, dest);
  }
  return dest;
}

/** flatten 후 비어 있는 `{outputDir}/images/`를 정리한다 (내용 있으면 보존). */
export function cleanupEmptyImagesDir(outputDir: string): void {
  const imagesDir = path.join(outputDir, "images");
  try {
    if (fs.existsSync(imagesDir) && fs.readdirSync(imagesDir).length === 0) {
      fs.rmdirSync(imagesDir);
    }
  } catch {
    /* 정리 실패는 무해 — 무시 */
  }
}
