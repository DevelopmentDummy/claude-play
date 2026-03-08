import * as fs from "fs";
import * as path from "path";
import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const svc = getServices();
  const sessionDir = svc.sessions.getSessionDir(id);
  const varsPath = path.join(sessionDir, "variables.json");

  if (!fs.existsSync(varsPath)) {
    return NextResponse.json({ error: "variables.json not found" }, { status: 404 });
  }

  let patch: Record<string, unknown>;
  try {
    patch = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  try {
    const current = JSON.parse(fs.readFileSync(varsPath, "utf-8"));
    const merged = { ...current, ...patch };
    fs.writeFileSync(varsPath, JSON.stringify(merged, null, 2), "utf-8");
    return NextResponse.json(merged);
  } catch {
    return NextResponse.json({ error: "Failed to update variables" }, { status: 500 });
  }
}
