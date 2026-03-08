import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export async function POST(req: Request) {
  const { text } = (await req.json()) as { text: string };
  const svc = getServices();
  const isOOC = text.startsWith("OOC:");
  svc.isOOC = isOOC;
  svc.addUserToHistory(text, isOOC);
  svc.claude.send(text);
  return NextResponse.json({ ok: true });
}
