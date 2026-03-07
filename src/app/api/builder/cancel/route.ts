import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { requireAuth } from "@/lib/auth";

export async function POST(req: Request) {
  const auth = requireAuth(req);
  if (auth instanceof Response) return auth;
  const svc = getServices(auth.userId);

  svc.claude.kill();

  if (svc.builderPersonaName) {
    svc.sessions.deletePersona(svc.builderPersonaName);
    svc.builderPersonaName = null;
    svc.isBuilderActive = false;
  }

  return NextResponse.json({ ok: true });
}
