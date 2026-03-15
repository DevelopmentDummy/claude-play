import * as fs from "fs";
import * as path from "path";
import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

// System JSON files that cannot be patched via this endpoint
const PROTECTED_FILES = new Set([
  "session.json",
  "builder-session.json",
  "layout.json",
  "chat-history.json",
  "package.json",
  "tsconfig.json",
]);

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const svc = getServices();
  const sessionDir = svc.sessions.getSessionDir(id);

  // Determine target file: ?file=inventory.json or default to variables.json
  const url = new URL(req.url);
  const fileName = url.searchParams.get("file") || "variables.json";

  // Security: block path traversal and protected files
  if (fileName.includes("/") || fileName.includes("\\") || fileName.includes("..")) {
    return NextResponse.json({ error: "Invalid file name" }, { status: 400 });
  }
  if (!fileName.endsWith(".json")) {
    return NextResponse.json({ error: "Only .json files supported" }, { status: 400 });
  }
  if (PROTECTED_FILES.has(fileName)) {
    return NextResponse.json({ error: "Cannot modify protected file" }, { status: 403 });
  }

  const filePath = path.join(sessionDir, fileName);

  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ error: `${fileName} not found` }, { status: 404 });
  }

  let patch: Record<string, unknown>;
  try {
    patch = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  try {
    let raw = fs.readFileSync(filePath, "utf-8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const current = JSON.parse(raw);
    const merged = { ...current, ...patch };
    fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), "utf-8");
    return NextResponse.json(merged);
  } catch {
    return NextResponse.json({ error: `Failed to update ${fileName}` }, { status: 500 });
  }
}
