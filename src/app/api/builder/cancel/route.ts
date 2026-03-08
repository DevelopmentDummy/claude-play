import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export async function POST() {
  const svc = getServices();

  svc.claude.kill();

  if (svc.builderPersonaName) {
    svc.sessions.deletePersona(svc.builderPersonaName);
    svc.builderPersonaName = null;
    svc.isBuilderActive = false;
  }

  return NextResponse.json({ ok: true });
}
