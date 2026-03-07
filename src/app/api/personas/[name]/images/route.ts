import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { requireAuth } from "@/lib/auth";
import * as path from "path";
import * as fs from "fs";

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

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
  const personaDir = sessions.getPersonaDir(name);
  const safeName = path.basename(file);
  const filePath = path.join(personaDir, "images", safeName);

  if (!fs.existsSync(filePath)) {
    return new NextResponse(null, { status: 404 });
  }

  const ext = path.extname(safeName).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  const data = fs.readFileSync(filePath);

  return new NextResponse(data, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=60",
    },
  });
}
