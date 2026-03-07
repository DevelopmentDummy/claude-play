import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { requireAuth } from "@/lib/auth";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const auth = requireAuth(req);
  if (auth instanceof Response) return auth;
  const { name } = await params;
  const url = new URL(req.url);
  const file = url.searchParams.get("file");
  if (!file) {
    return NextResponse.json({ error: "Missing file parameter" }, { status: 400 });
  }

  const { sessions } = getServices(auth.userId);
  const content = sessions.readPersonaFile(name, file);
  return NextResponse.json({ content });
}
