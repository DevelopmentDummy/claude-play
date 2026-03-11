import { NextRequest, NextResponse } from "next/server";
import { getSessionInstance, getSessionManager } from "@/lib/services";
import type { HistoryMessage } from "@/lib/services";
import * as fs from "fs";
import * as path from "path";

/** Load history from an active instance, or fall back to disk */
function loadHistoryForSession(sessionId: string): HistoryMessage[] {
  const instance = getSessionInstance(sessionId);
  if (instance) {
    instance.loadHistory();
    return instance.chatHistory;
  }
  // Fallback: load from disk via SessionManager
  const sm = getSessionManager();
  try {
    const dir = sm.getSessionDir(sessionId);
    const fp = path.join(dir, "chat-history.json");
    if (fs.existsSync(fp)) {
      return JSON.parse(fs.readFileSync(fp, "utf-8"));
    }
  } catch { /* ignore */ }
  return [];
}

/** PATCH: Toggle ooc flag on a specific message */
export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as { id?: string; ooc?: boolean; sessionId?: string };
  if (!body.id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }
  const sessionId = body.sessionId || req.nextUrl.searchParams.get("sessionId");
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  }

  const instance = getSessionInstance(sessionId);
  if (instance) {
    instance.loadHistory();
    const msg = instance.chatHistory.find((m) => m.id === body.id);
    if (!msg) {
      return NextResponse.json({ error: "message not found" }, { status: 404 });
    }
    msg.ooc = body.ooc || undefined;
    if (msg.role === "user") {
      if (body.ooc && !msg.content.startsWith("OOC:")) {
        msg.content = `OOC: ${msg.content}`;
      } else if (!body.ooc && msg.content.startsWith("OOC:")) {
        msg.content = msg.content.replace(/^OOC:\s*/, "");
      }
    }
    instance.saveHistory();
    return NextResponse.json({ ok: true, message: msg });
  }

  // Fallback: edit on disk
  const sm = getSessionManager();
  try {
    const dir = sm.getSessionDir(sessionId);
    const fp = path.join(dir, "chat-history.json");
    if (!fs.existsSync(fp)) {
      return NextResponse.json({ error: "message not found" }, { status: 404 });
    }
    const history: HistoryMessage[] = JSON.parse(fs.readFileSync(fp, "utf-8"));
    const msg = history.find((m) => m.id === body.id);
    if (!msg) {
      return NextResponse.json({ error: "message not found" }, { status: 404 });
    }
    msg.ooc = body.ooc || undefined;
    if (msg.role === "user") {
      if (body.ooc && !msg.content.startsWith("OOC:")) {
        msg.content = `OOC: ${msg.content}`;
      } else if (!body.ooc && msg.content.startsWith("OOC:")) {
        msg.content = msg.content.replace(/^OOC:\s*/, "");
      }
    }
    fs.writeFileSync(fp, JSON.stringify(history), "utf-8");
    return NextResponse.json({ ok: true, message: msg });
  } catch {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
}

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  }

  const history = loadHistoryForSession(sessionId);
  const total = history.length;

  const limitParam = url.searchParams.get("limit");
  const offsetParam = url.searchParams.get("offset");

  if (limitParam === null && offsetParam === null) {
    const limit = 10;
    const start = Math.max(0, total - limit);
    return NextResponse.json({
      messages: history.slice(start),
      total,
      offset: start,
    });
  }

  const limit = Math.max(1, parseInt(limitParam || "10", 10));
  const offset = Math.max(0, parseInt(offsetParam || "0", 10));

  return NextResponse.json({
    messages: history.slice(offset, offset + limit),
    total,
    offset,
  });
}
