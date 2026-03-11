import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const { sessions } = getServices();
  const dir = sessions.getPersonaDir(name);
  const options = sessions.readOptions(dir);
  return NextResponse.json(options);
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const body = await req.json();
  const { sessions } = getServices();
  const dir = sessions.getPersonaDir(name);
  sessions.writeOptions(dir, body);
  return NextResponse.json({ ok: true });
}
