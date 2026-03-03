import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const { sessions } = getServices();
  sessions.deleteProfile(slug);
  return NextResponse.json({ ok: true });
}
