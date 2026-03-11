import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { sessions } = getServices();
  const dir = sessions.getSessionDir(id);
  const schema = sessions.readOptionsSchema();
  const values = sessions.resolveOptions(dir);
  return NextResponse.json({ schema, values });
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();
  const { sessions } = getServices();
  const dir = sessions.getSessionDir(id);
  sessions.writeOptions(dir, body);
  return NextResponse.json({ ok: true });
}
