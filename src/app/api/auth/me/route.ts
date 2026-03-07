import { NextResponse } from "next/server";
import { getUserIdFromRequest, validateToken, COOKIE_NAME } from "@/lib/auth";

export async function GET(req: Request) {
  const cookie = req.headers.get("cookie") || "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  if (!match) {
    return NextResponse.json({ user: null });
  }
  const user = validateToken(match[1]);
  return NextResponse.json({ user: user || null });
}
