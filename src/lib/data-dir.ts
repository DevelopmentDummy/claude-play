import * as path from "path";
import * as fs from "fs";

/** Global data directory (contains personas/, sessions/, profiles/, tools/) */
export function getDataDir(): string {
  const envDir = process.env.DATA_DIR;
  const dir = envDir ? path.resolve(envDir) : path.join(process.cwd(), "data");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getAppRoot(): string {
  return process.cwd();
}
