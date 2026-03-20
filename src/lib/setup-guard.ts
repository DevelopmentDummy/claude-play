import fs from "fs";
import path from "path";
import { getDataDir } from "./data-dir";

export function isSetupComplete(): boolean {
  return fs.existsSync(path.join(getDataDir(), ".setup-complete"));
}

export function markSetupComplete(): void {
  const dir = getDataDir();
  fs.writeFileSync(path.join(dir, ".setup-complete"), new Date().toISOString(), "utf-8");
}

const SETUP_EXCLUDE = ["/setup", "/api/setup", "/api/auth", "/_next", "/favicon.ico"];
const STATIC_EXTENSIONS = [".svg", ".png", ".jpg", ".ico", ".json", ".txt", ".xml", ".webmanifest"];

export function shouldRedirectToSetup(pathname: string): boolean {
  if (isSetupComplete()) return false;
  if (STATIC_EXTENSIONS.some((ext) => pathname.endsWith(ext))) return false;
  return !SETUP_EXCLUDE.some((prefix) => pathname.startsWith(prefix));
}
