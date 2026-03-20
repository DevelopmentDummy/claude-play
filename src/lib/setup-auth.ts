import { NextRequest, NextResponse } from "next/server";
import { isSetupComplete } from "./setup-guard";
import { verifyAuthToken, parseCookieToken } from "./auth";

/** Returns 401 response if setup is complete and request is not authenticated. null = OK. */
export function requireSetupAuth(req: NextRequest): NextResponse | null {
  if (!isSetupComplete()) return null;
  if (!process.env.ADMIN_PASSWORD) return null;
  const token = parseCookieToken(req.headers.get("cookie") || undefined);
  if (token && verifyAuthToken(token)) return null;
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
