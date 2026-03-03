import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const { sessions } = getServices();
  sessions.deletePersona(name);
  return NextResponse.json({ ok: true });
}
