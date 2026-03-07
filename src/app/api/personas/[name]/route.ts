import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { requireAuth } from "@/lib/auth";

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const auth = requireAuth(req);
  if (auth instanceof Response) return auth;
  const { name } = await params;
  const { sessions } = getServices(auth.userId);
  sessions.deletePersona(name);
  return NextResponse.json({ ok: true });
}
