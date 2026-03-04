import { NextRequest, NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export async function GET(req: NextRequest) {
  const svc = getServices();
  const url = req.nextUrl;
  const total = svc.chatHistory.length;

  // If no pagination params, return paginated with defaults (last 10)
  const limitParam = url.searchParams.get("limit");
  const offsetParam = url.searchParams.get("offset");

  if (limitParam === null && offsetParam === null) {
    // Default: return last 10 messages
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
