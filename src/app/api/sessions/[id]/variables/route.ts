import * as fs from "fs";
import * as path from "path";
import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { getSessionInstance } from "@/lib/session-registry";
import { mutateSessionJson, applyPatch } from "@/lib/session-state";

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

  // Extract __refreshPanels before merging — it's a signal, not persistent data
  const refreshPanels = patch.__refreshPanels as string[] | undefined;
  delete patch.__refreshPanels;

  const r = await mutateSessionJson(filePath, (current) => {
    const merged = applyPatch(current, patch);
    if (
      patch.__modals && typeof patch.__modals === "object" && !Array.isArray(patch.__modals) &&
      typeof current.__modals === "object" && !Array.isArray(current.__modals) && current.__modals !== null
    ) {
      merged.__modals = {
        ...(current.__modals as Record<string, unknown>),
        ...(patch.__modals as Record<string, unknown>),
      };
    }
    return merged;
  });
  if (!r.ok) {
    return NextResponse.json({ error: `Failed to update ${fileName}` }, { status: 500 });
  }

  if (Array.isArray(refreshPanels) && refreshPanels.length > 0) {
    const instance = getSessionInstance(id);
    if (instance) {
      for (const name of refreshPanels) instance.panels.invalidatePanel(name);
    }
  }

  return NextResponse.json(r.value);
}
