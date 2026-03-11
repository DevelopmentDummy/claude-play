import { NextResponse } from "next/server";
import { getServices, closeSessionInstance } from "@/lib/services";

export async function POST(req: Request) {
  const body = (await req.json()) as { name: string };
  const { name } = body;
  const svc = getServices();

  closeSessionInstance(name);

  if (name && svc.sessions.personaExists(name)) {
    svc.sessions.deletePersona(name);
  }

  return NextResponse.json({ ok: true });
}
