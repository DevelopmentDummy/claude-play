import * as fs from "fs";
import * as path from "path";
import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = target[key];
    if (sv && typeof sv === "object" && !Array.isArray(sv) && tv && typeof tv === "object" && !Array.isArray(tv)) {
      result[key] = deepMerge(tv as Record<string, unknown>, sv as Record<string, unknown>);
    } else {
      result[key] = sv;
    }
  }
  return result;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const svc = getServices();
  const sessionDir = svc.sessions.getSessionDir(id);
  const filePath = path.join(sessionDir, "layout.json");

  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ error: "layout.json not found" }, { status: 404 });
  }

  let patch: Record<string, unknown>;
  try {
    patch = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  try {
    const current = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const merged = deepMerge(current, patch);
    fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), "utf-8");
    return NextResponse.json(merged);
  } catch {
    return NextResponse.json({ error: "Failed to update layout.json" }, { status: 500 });
  }
}
