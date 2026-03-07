import { NextResponse } from "next/server";
import { createUser, loginUser, getUserCount, COOKIE_NAME } from "@/lib/auth";

export async function POST(req: Request) {
  const { username, password, displayName } = (await req.json()) as {
    username: string; password: string; displayName?: string;
  };

  if (!username || !password) {
    return NextResponse.json({ error: "Username and password required" }, { status: 400 });
  }
  if (username.length < 2 || password.length < 4) {
    return NextResponse.json({ error: "Username min 2 chars, password min 4 chars" }, { status: 400 });
  }

  try {
    createUser(username, password, displayName);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("UNIQUE constraint")) {
      return NextResponse.json({ error: "Username already taken" }, { status: 409 });
    }
    return NextResponse.json({ error: "Registration failed" }, { status: 500 });
  }

  // Auto-login after registration
  const result = loginUser(username, password);
  if (!result) {
    return NextResponse.json({ error: "Registration succeeded but login failed" }, { status: 500 });
  }

  const res = NextResponse.json({ user: result.user });
  res.cookies.set(COOKIE_NAME, result.token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });
  return res;
}
