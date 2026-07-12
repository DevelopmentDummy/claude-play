import * as path from "path";
import * as fs from "fs";

// "data" 리터럴을 런타임에 조립한다. path.join(process.cwd(), "data")를 그대로 두면
// next build의 file tracer(@vercel/nft)가 정적 평가해 data/ 디렉터리 전체(수백만 파일)를
// 라우트별 추적 산출물로 쓸어 담아 빌드가 분 단위로 느려진다. outputFileTracingExcludes는
// 결과 필터일 뿐 디렉터리 워크 비용을 막지 못하므로 표현식 자체를 불투명하게 만드는 게 유일한 방어다.
const DATA_DIR_NAME = Buffer.from([0x64, 0x61, 0x74, 0x61]).toString();

/** Global data directory (contains personas/, sessions/, profiles/, tools/) */
export function getDataDir(): string {
  const envDir = process.env.DATA_DIR;
  const dir = envDir ? path.resolve(envDir) : path.join(process.cwd(), DATA_DIR_NAME);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getAppRoot(): string {
  return process.cwd();
}
