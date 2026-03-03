import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export async function POST(req: Request) {
  const { text } = (await req.json()) as { text: string };
  const { claude } = getServices();
  claude.send(text);
  return NextResponse.json({ ok: true });
}
