import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";
import { getServices } from "@/lib/services";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const url = new URL(req.url);
  const file = url.searchParams.get("file");
  if (!file) {
    return NextResponse.json({ error: "Missing file parameter" }, { status: 400 });
  }

  const { sessions } = getServices();
  const content = sessions.readPersonaFile(name, file);
  return NextResponse.json({ content });
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const url = new URL(req.url);
  const file = url.searchParams.get("file");
  if (!file) {
    return NextResponse.json({ error: "Missing file parameter" }, { status: 400 });
  }

  // Only allow safe filenames (no path traversal)
  if (file.includes("..") || path.isAbsolute(file)) {
    return NextResponse.json({ error: "Invalid file path" }, { status: 400 });
  }

  const { sessions } = getServices();
  const personaDir = sessions.getPersonaDir(name);
  if (!fs.existsSync(personaDir)) {
    return NextResponse.json({ error: "Persona not found" }, { status: 404 });
  }

  const body = await req.json();
  const content = typeof body.content === "string" ? body.content : JSON.stringify(body.content, null, 2);
  fs.writeFileSync(path.join(personaDir, file), content, "utf-8");
  return NextResponse.json({ ok: true });
}
