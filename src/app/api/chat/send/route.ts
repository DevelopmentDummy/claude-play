import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { requireAuth } from "@/lib/auth";

export async function POST(req: Request) {
  const auth = requireAuth(req);
  if (auth instanceof Response) return auth;
  const { text } = (await req.json()) as { text: string };
  const svc = getServices(auth.userId);
  const isOOC = text.startsWith("OOC:");
  svc.isOOC = isOOC;
  svc.addUserToHistory(text, isOOC);
  svc.claude.send(text);
  return NextResponse.json({ ok: true });
}
