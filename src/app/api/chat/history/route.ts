import { NextRequest, NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { requireAuth } from "@/lib/auth";

/** PATCH: Toggle ooc flag on a specific message */
export async function PATCH(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof Response) return auth;
  const body = await req.json().catch(() => ({})) as { id?: string; ooc?: boolean };
  if (!body.id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }
  const svc = getServices(auth.userId);
  svc.loadHistory();
  const msg = svc.chatHistory.find((m) => m.id === body.id);
  if (!msg) {
    return NextResponse.json({ error: "message not found" }, { status: 404 });
  }
  msg.ooc = body.ooc || undefined;
  // Strip or add OOC: prefix on user messages to keep content consistent
  if (msg.role === "user") {
    if (body.ooc && !msg.content.startsWith("OOC:")) {
      msg.content = `OOC: ${msg.content}`;
    } else if (!body.ooc && msg.content.startsWith("OOC:")) {
      msg.content = msg.content.replace(/^OOC:\s*/, "");
    }
  }
  svc.saveHistory();
  return NextResponse.json({ ok: true, message: msg });
}

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
