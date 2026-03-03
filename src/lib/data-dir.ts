import * as path from "path";

export function getDataDir(): string {
  const envDir = process.env.DATA_DIR;
  if (envDir) {
    return path.resolve(envDir);
  }
  return path.join(process.cwd(), "data");
}

export function getAppRoot(): string {
  return process.cwd();
}
