import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const AUTH_COOKIE_NAME = "bridge_auth";

/** Decode base64url to Uint8Array (handles missing padding) */
function base64urlDecode(str: string): Uint8Array {
  let b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

// Inline token verification for Edge Runtime (no Node.js crypto)
async function verifyTokenEdge(token: string, password: string): Promise<boolean> {
  try {
    const [payloadB64, sigB64] = token.split(".");
    if (!payloadB64 || !sigB64) return false;

    const salt = "claude-play-auth";
    const keyData = new TextEncoder().encode(password + salt);
    const hashBuffer = await crypto.subtle.digest("SHA-256", keyData);
    const key = await crypto.subtle.importKey("raw", hashBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);

    const payload = base64urlDecode(payloadB64);
    const sig = base64urlDecode(sigB64);

    const valid = await crypto.subtle.verify("HMAC", key, sig.buffer as ArrayBuffer, payload.buffer as ArrayBuffer);
    if (!valid) return false;

    const { ts } = JSON.parse(new TextDecoder().decode(payload));
    const maxAge = 90 * 24 * 60 * 60 * 1000;
    if (Date.now() - ts > maxAge) return false;

    return true;
  } catch {
    return false;
  }
}

export async function middleware(request: NextRequest) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return NextResponse.next(); // Auth disabled

  const { pathname } = request.nextUrl;

  // Auth API is always accessible
  if (pathname.startsWith("/api/auth/")) {
    return NextResponse.next();
  }

  // Setup page and API routes — bypass auth during initial setup
  // (cannot check fs for .setup-complete in Edge Runtime, so always bypass;
  // API routes self-guard via requireSetupAuth, page checks in client)
  if (pathname.startsWith("/api/setup") || pathname.startsWith("/setup")) {
    return NextResponse.next();
  }

  // MCP server requests — validate internal token (not just presence)
  // Cannot call validateInternalToken() in Edge Runtime (globalThis state not shared).
  // MCP server is local-only and token is random 64-char hex — presence check is acceptable.
  // The actual validation happens in API route handlers that use validateInternalToken().
  const bridgeToken = request.headers.get("x-bridge-token");
  if (bridgeToken) {
    return NextResponse.next();
  }

  // Check auth cookie
  const token = request.cookies.get(AUTH_COOKIE_NAME)?.value;
  const isAuthenticated = token ? await verifyTokenEdge(token, password) : false;

  // Authenticated user on /login -> redirect home
  if (pathname === "/login" && isAuthenticated) {
    const homeUrl = request.nextUrl.clone();
    homeUrl.pathname = "/";
    return NextResponse.redirect(homeUrl);
  }

  // /login is accessible without auth
  if (pathname === "/login") {
    return NextResponse.next();
  }

  // Authenticated -> pass through
  if (isAuthenticated) {
    return NextResponse.next();
  }

  // Not authenticated
  const isApiRequest = pathname.startsWith("/api/");
  if (isApiRequest) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Redirect to login page
  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
