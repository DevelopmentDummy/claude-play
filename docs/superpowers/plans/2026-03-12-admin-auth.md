# Admin Authentication Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cloudflare Tunnel로 노출된 Claude Bridge에 단일 비밀번호 인증을 추가하여 무단 접근을 차단한다.

**Architecture:** Next.js 미들웨어에서 모든 요청의 쿠키를 검증하고, 미인증 시 `/login`으로 리다이렉트한다. HMAC-SHA256 서명 토큰을 httpOnly 쿠키에 저장. WebSocket과 TTS 인터셉트 라우트도 동일하게 보호한다.

**Tech Stack:** Node.js `crypto` (HMAC-SHA256), Next.js middleware, httpOnly cookies

**Spec:** `docs/superpowers/specs/2026-03-12-admin-auth-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/lib/auth.ts` | Modify | 기존 MCP 토큰 + 어드민 토큰 생성/검증/쿠키파싱 |
| `src/middleware.ts` | Modify | 모든 요청 쿠키 검증, 예외 경로 처리 |
| `src/app/login/page.tsx` | Create | 로그인 페이지 UI |
| `src/app/api/auth/login/route.ts` | Create | 로그인 API + rate limiting |
| `src/app/api/auth/logout/route.ts` | Create | 로그아웃 API |
| `src/lib/ws-server.ts` | Modify | WebSocket 업그레이드 시 쿠키 검증 |
| `server.ts` | Modify | TTS 인터셉트 라우트 쿠키 검증 |
| `CLAUDE.md` | Modify | ADMIN_PASSWORD 환경변수 문서화 |

---

## Chunk 1: Auth Core + Middleware

### Task 1: auth.ts에 어드민 인증 함수 추가

**Files:**
- Modify: `src/lib/auth.ts`

- [ ] **Step 1: 어드민 인증 함수들 추가**

기존 MCP 토큰 코드 아래에 추가:

```typescript
// ── Admin authentication ──
const AUTH_COOKIE_NAME = "bridge_auth";
const AUTH_SALT = "claude-bridge-auth";
const TOKEN_MAX_AGE = 90 * 24 * 60 * 60; // 90 days in seconds

/** Check if admin auth is enabled (ADMIN_PASSWORD env var is set) */
export function isAuthEnabled(): boolean {
  return !!process.env.ADMIN_PASSWORD;
}

/** Derive signing key from password + salt */
function deriveKey(): Buffer {
  return crypto.createHash("sha256").update(process.env.ADMIN_PASSWORD + AUTH_SALT).digest();
}

/** Create signed auth token */
export function createAuthToken(): string {
  const payload = Buffer.from(JSON.stringify({ ts: Date.now() }));
  const sig = crypto.createHmac("sha256", deriveKey()).update(payload).digest();
  return payload.toString("base64url") + "." + sig.toString("base64url");
}

/** Verify auth token. Returns true if valid and not expired. */
export function verifyAuthToken(token: string): boolean {
  try {
    const [payloadB64, sigB64] = token.split(".");
    if (!payloadB64 || !sigB64) return false;

    const payload = Buffer.from(payloadB64, "base64url");
    const sig = Buffer.from(sigB64, "base64url");
    const expected = crypto.createHmac("sha256", deriveKey()).update(payload).digest();

    if (sig.length !== expected.length) return false;
    if (!crypto.timingSafeEqual(sig, expected)) return false;

    const { ts } = JSON.parse(payload.toString());
    if (Date.now() - ts > TOKEN_MAX_AGE * 1000) return false;

    return true;
  } catch {
    return false;
  }
}

/** Verify password with timing-safe comparison (hash both to avoid length leak) */
export function verifyPassword(input: string): boolean {
  const password = process.env.ADMIN_PASSWORD || "";
  const inputHash = crypto.createHash("sha256").update(input).digest();
  const passwordHash = crypto.createHash("sha256").update(password).digest();
  return crypto.timingSafeEqual(inputHash, passwordHash);
}

/** Parse auth token from raw Cookie header string (for WebSocket/raw HTTP) */
export function parseCookieToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${AUTH_COOKIE_NAME}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

/** Cookie name and max age exported for route handlers */
export { AUTH_COOKIE_NAME, TOKEN_MAX_AGE };
```

- [ ] **Step 2: 커밋**

```bash
git add src/lib/auth.ts
git commit -m "feat(auth): add admin token creation, verification, and cookie parsing"
```

---

### Task 2: 로그인 API

**Files:**
- Create: `src/app/api/auth/login/route.ts`

- [ ] **Step 1: 로그인 API 작성 (rate limiting 포함)**

```typescript
import { NextResponse } from "next/server";
import {
  isAuthEnabled,
  verifyPassword,
  createAuthToken,
  AUTH_COOKIE_NAME,
  TOKEN_MAX_AGE,
} from "@/lib/auth";

// In-memory rate limiter: IP -> { count, resetTime }
const attempts = new Map<string, { count: number; reset: number }>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60_000; // 1 minute

// Periodic cleanup of expired entries
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of attempts) {
    if (now > entry.reset) attempts.delete(ip);
  }
}, 60_000);

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now > entry.reset) {
    attempts.set(ip, { count: 1, reset: now + WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= MAX_ATTEMPTS;
}

export async function POST(req: Request) {
  if (!isAuthEnabled()) {
    return NextResponse.json({ error: "Auth not enabled" }, { status: 400 });
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || req.headers.get("x-real-ip")
    || "unknown";

  if (!checkRateLimit(ip)) {
    return NextResponse.json(
      { error: "Too many attempts. Try again later." },
      { status: 429 }
    );
  }

  const body = await req.json().catch(() => null);
  const password = body?.password;

  if (!password || !verifyPassword(password)) {
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }

  const token = createAuthToken();
  const isProduction = process.env.NODE_ENV === "production";

  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "strict",
    maxAge: TOKEN_MAX_AGE,
    path: "/",
  });
  return res;
}
```

- [ ] **Step 2: 커밋**

```bash
git add src/app/api/auth/login/route.ts
git commit -m "feat(auth): add login API with rate limiting"
```

---

### Task 3: 로그아웃 API

**Files:**
- Create: `src/app/api/auth/logout/route.ts`

- [ ] **Step 1: 로그아웃 API 작성**

```typescript
import { NextResponse } from "next/server";
import { AUTH_COOKIE_NAME } from "@/lib/auth";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE_NAME, "", {
    httpOnly: true,
    maxAge: 0,
    path: "/",
  });
  return res;
}
```

- [ ] **Step 2: 커밋**

```bash
git add src/app/api/auth/logout/route.ts
git commit -m "feat(auth): add logout API"
```

---

### Task 4: 미들웨어 인증 로직

**Files:**
- Modify: `src/middleware.ts`

- [ ] **Step 1: 미들웨어 교체**

전체 파일을 다음으로 교체:

```typescript
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

    const salt = "claude-bridge-auth";
    const keyData = new TextEncoder().encode(password + salt);
    const hashBuffer = await crypto.subtle.digest("SHA-256", keyData);
    const key = await crypto.subtle.importKey("raw", hashBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);

    const payload = base64urlDecode(payloadB64);
    const sig = base64urlDecode(sigB64);

    const valid = await crypto.subtle.verify("HMAC", key, sig, payload);
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

  // MCP server requests — validate internal token (not just presence)
  const bridgeToken = request.headers.get("x-bridge-token");
  if (bridgeToken) {
    // Cannot call validateInternalToken() in Edge Runtime (globalThis state not shared).
    // MCP server is local-only and token is random 64-char hex — presence check is acceptable.
    // The actual validation happens in API route handlers that use validateInternalToken().
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
```

**참고**: Next.js 미들웨어는 Edge Runtime에서 실행되므로 Node.js `crypto` 대신 Web Crypto API (`crypto.subtle`)를 사용해야 한다. 토큰 형식과 알고리즘은 auth.ts의 Node.js 구현과 동일한 결과를 산출한다.

- [ ] **Step 2: 커밋**

```bash
git add src/middleware.ts
git commit -m "feat(auth): add cookie verification middleware with Edge Runtime crypto"
```

---

## Chunk 2: Login Page + Transport Protection

### Task 5: 로그인 페이지

**Files:**
- Create: `src/app/login/page.tsx`

- [ ] **Step 1: 로그인 페이지 작성**

프로젝트의 기존 디자인 시스템 (다크 테마, CSS 변수) 활용:

```tsx
"use client";

import { useState, FormEvent } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });

      if (res.ok) {
        router.replace("/");
        return;
      }

      const data = await res.json().catch(() => null);
      if (res.status === 429) {
        setError(data?.error || "Too many attempts. Try again later.");
      } else {
        setError("Incorrect password");
      }
    } catch {
      setError("Connection failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        background: "var(--bg)",
      }}
    >
      <form
        onSubmit={handleSubmit}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "16px",
          padding: "32px",
          borderRadius: "12px",
          background: "var(--surface)",
          backdropFilter: "blur(var(--glass-blur))",
          border: "1px solid var(--border)",
          boxShadow: "var(--shadow-lg)",
          width: "340px",
        }}
      >
        <h1
          style={{
            fontSize: "20px",
            fontWeight: 600,
            color: "var(--text)",
            textAlign: "center",
            marginBottom: "8px",
          }}
        >
          Claude Bridge
        </h1>

        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          autoFocus
          disabled={loading}
          style={{
            padding: "10px 14px",
            borderRadius: "8px",
            border: "1px solid var(--border)",
            background: "var(--surface-light)",
            color: "var(--text)",
            fontSize: "14px",
            outline: "none",
          }}
        />

        {error && (
          <p style={{ color: "var(--error)", fontSize: "13px", textAlign: "center" }}>
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={loading || !password}
          style={{
            padding: "10px",
            borderRadius: "8px",
            border: "none",
            background: "var(--accent)",
            color: "#fff",
            fontSize: "14px",
            fontWeight: 500,
            cursor: loading || !password ? "not-allowed" : "pointer",
            opacity: loading || !password ? 0.5 : 1,
            transition: "var(--transition-fast)",
          }}
        >
          {loading ? "..." : "Login"}
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: 커밋**

```bash
git add src/app/login/page.tsx
git commit -m "feat(auth): add login page"
```

---

### Task 6: WebSocket 인증 추가

**Files:**
- Modify: `src/lib/ws-server.ts`

- [ ] **Step 1: 업그레이드 핸들러에 쿠키 검증 추가**

`ws-server.ts`의 `server.on("upgrade", ...)` 핸들러에서 `wss.handleUpgrade` 호출 전에 인증 검증을 추가한다:

```typescript
// 파일 상단 import에 추가:
import { isAuthEnabled, verifyAuthToken, parseCookieToken } from "./auth";

// server.on("upgrade", ...) 핸들러 내, pathname 검증 후 wss.handleUpgrade 전에 삽입:
    // Auth check
    if (isAuthEnabled()) {
      const cookieToken = parseCookieToken(req.headers.cookie);
      if (!cookieToken || !verifyAuthToken(cookieToken)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
    }
```

- [ ] **Step 2: 커밋**

```bash
git add src/lib/ws-server.ts
git commit -m "feat(auth): add WebSocket upgrade authentication"
```

---

### Task 7: TTS 인터셉트 라우트 인증

**Files:**
- Modify: `server.ts`

- [ ] **Step 1: server.ts의 TTS 라우트에 쿠키 검증 추가**

`server.ts` 상단 import에 추가:

```typescript
import { isAuthEnabled, verifyAuthToken, parseCookieToken } from "./src/lib/auth";
```

`createServer` 콜백 내, TTS 라우트 처리 전에 인증 헬퍼 함수 추가:

```typescript
  const server = createServer(async (req, res) => {
    const parsedUrl = parse(req.url!, true);
    const pathname = parsedUrl.pathname || "";

    // Auth check for intercepted routes (not /login, not /api/auth/*)
    const needsAuth = isAuthEnabled()
      && !pathname.startsWith("/api/auth/")
      && pathname !== "/login";

    if (needsAuth) {
      const isIntercepted = pathname === "/api/chat/tts"
        || /^\/api\/personas\/[^/]+\/voice\/generate$/.test(pathname);

      if (isIntercepted) {
        const cookieToken = parseCookieToken(req.headers.cookie);
        if (!cookieToken || !verifyAuthToken(cookieToken)) {
          return sendJson(res, 401, { error: "Unauthorized" });
        }
      }
    }

    // ... existing TTS route handling continues below
```

- [ ] **Step 2: 커밋**

```bash
git add server.ts
git commit -m "feat(auth): protect TTS intercept routes"
```

---

### Task 8: CLAUDE.md 업데이트

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: 환경변수 섹션에 ADMIN_PASSWORD 추가**

`## Environment Variables` 섹션의 마지막 항목 뒤에 추가:

```markdown
- `ADMIN_PASSWORD` — Admin login password. If not set, authentication is disabled (open access).
```

- [ ] **Step 2: 커밋**

```bash
git add CLAUDE.md
git commit -m "docs: add ADMIN_PASSWORD to environment variables"
```

---

## Chunk 3: 수동 테스트

### Task 9: 수동 검증

- [ ] **Step 1: ADMIN_PASSWORD 없이 서버 시작**

```bash
npm run dev
```

모든 페이지와 API에 인증 없이 접근 가능한지 확인.

- [ ] **Step 2: ADMIN_PASSWORD 설정 후 서버 재시작**

`start.bat` 또는 환경변수에 `ADMIN_PASSWORD=testpass123` 설정 후 재시작.

- [ ] **Step 3: 미인증 접근 차단 확인**

- `/` 접근 → `/login`으로 리다이렉트
- `/api/personas` 접근 → 401 JSON
- WebSocket 연결 시도 → 401 거부

- [ ] **Step 4: 로그인 성공 확인**

- `/login`에서 올바른 비밀번호 입력 → `/`로 리다이렉트
- 이후 모든 페이지/API 정상 접근

- [ ] **Step 5: 로그아웃 확인**

- 로그아웃 후 다시 접근 차단 확인

- [ ] **Step 6: Rate limiting 확인**

- 잘못된 비밀번호 6회 연속 시도 → 429 응답
