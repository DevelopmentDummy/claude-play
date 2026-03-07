import { NextRequest, NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { requireAuth } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof Response) return auth;
  const svc = getServices(auth.userId);
  // Reload from disk to pick up external changes (e.g. AI editing chat-history.json directly)
  svc.loadHistory();
  const url = req.nextUrl;
  const total = svc.chatHistory.length;

  const limitParam = url.searchParams.get("limit");
  const offsetParam = url.searchParams.get("offset");

  if (limitParam === null && offsetParam === null) {
    const limit = 10;
    const start = Math.max(0, total - limit);
    return NextResponse.json({
      messages: svc.chatHistory.slice(start),
      total,
      offset: start,
    });
  }

  const limit = Math.max(1, parseInt(limitParam || "10", 10));
  const offset = Math.max(0, parseInt(offsetParam || "0", 10));

  return NextResponse.json({
    messages: svc.chatHistory.slice(offset, offset + limit),
    total,
    offset,
  });
}
