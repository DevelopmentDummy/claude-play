import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";
import { getDataDir } from "@/lib/data-dir";

function getStylesDir(): string {
  const dir = path.join(getDataDir(), "styles");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** GET /api/styles — list all writing styles */
export async function GET() {
  const dir = getStylesDir();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  const styles = files.map((f) => {
    const name = f.replace(/\.md$/, "");
    const content = fs.readFileSync(path.join(dir, f), "utf-8");
    return { name, content };
  });
  return NextResponse.json(styles);
}

/** POST /api/styles — create or update a writing style */
export async function POST(req: Request) {
  const body = await req.json();
  const { name, content } = body as { name?: string; content?: string };
  if (!name?.trim()) {
    return NextResponse.json({ error: "Missing name" }, { status: 400 });
  }
  // Sanitize: no path traversal
  const safeName = name.trim().replace(/[/\\:*?"<>|]/g, "_");
  const dir = getStylesDir();
  fs.writeFileSync(path.join(dir, `${safeName}.md`), content || "", "utf-8");
  return NextResponse.json({ ok: true, name: safeName });
}

/** DELETE /api/styles — delete a writing style */
export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const name = url.searchParams.get("name");
  if (!name?.trim()) {
    return NextResponse.json({ error: "Missing name" }, { status: 400 });
  }
  const dir = getStylesDir();
  const filePath = path.join(dir, `${name}.md`);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
  return NextResponse.json({ ok: true });
}
