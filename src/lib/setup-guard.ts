// src/lib/setup-guard.ts
import fs from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { getDataDir } from "./data-dir";
import { verifyAuthToken, parseCookieToken } from "./auth";

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

/** Returns 401 response if setup is complete and request is not authenticated. null = OK. */
export function requireSetupAuth(req: NextRequest): NextResponse | null {
  if (!isSetupComplete()) return null; // During initial setup, no auth needed
  if (!process.env.ADMIN_PASSWORD) return null; // No password set, no auth
  const token = parseCookieToken(req.headers.get("cookie") || undefined);
  if (token && verifyAuthToken(token)) return null;
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
