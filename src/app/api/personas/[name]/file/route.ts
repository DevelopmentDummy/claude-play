import { NextResponse } from "next/server";
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
