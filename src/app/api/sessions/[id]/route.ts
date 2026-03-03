import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { sessions } = getServices();
  sessions.deleteSession(id);
  return NextResponse.json({ ok: true });
}
