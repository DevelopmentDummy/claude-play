import { NextResponse } from "next/server";
import { loginUser, COOKIE_NAME } from "@/lib/auth";

export async function POST(req: Request) {
  const { username, password } = (await req.json()) as { username: string; password: string };
  if (!username || !password) {
    return NextResponse.json({ error: "Username and password required" }, { status: 400 });
  }

  const result = loginUser(username, password);
  if (!result) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  const res = NextResponse.json({ user: result.user });
  res.cookies.set(COOKIE_NAME, result.token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60, // 30 days
  });
  return res;
}
