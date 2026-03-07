import * as path from "path";
import * as fs from "fs";

/** Global data directory (contains bridge.db, tools/, users/) */
export function getDataDir(): string {
  const envDir = process.env.DATA_DIR;
  if (envDir) {
    return path.resolve(envDir);
  }
  return path.join(process.cwd(), "data");
}

/** Per-user data directory: data/users/{userId}/ */
export function getUserDataDir(userId: string): string {
  const dir = path.join(getDataDir(), "users", userId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getAppRoot(): string {
  return process.cwd();
}
