import * as fs from "fs";
import * as path from "path";
import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

const PROTECTED_FILES = new Set([
  "session.json", "builder-session.json", "layout.json",
  "chat-history.json", "package.json", "tsconfig.json",
]);

const SYSTEM_JSON = new Set([
  "variables.json", "session.json", "builder-session.json",
  "comfyui-config.json", "layout.json", "chat-history.json",
  "package.json", "tsconfig.json", "character-tags.json",
  "voice.json", "chat-options.json", "policy-context.json",
]);

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; name: string }> }
) {
  const { id, name } = await params;

  // Path traversal check
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    return NextResponse.json({ error: "Invalid tool name" }, { status: 400 });
  }

  const svc = getServices();
  const sessionDir = svc.sessions.getSessionDir(id);
  const toolPath = path.join(sessionDir, "tools", `${name}.js`);

  if (!fs.existsSync(toolPath)) {
    return NextResponse.json({ error: `Tool "${name}" not found` }, { status: 404 });
  }

  // Parse args
  let args: Record<string, unknown> = {};
  try {
    const body = await req.json();
    args = typeof body?.args === "object" && body.args !== null ? body.args : {};
  } catch {
    // empty args is fine
  }

  // Build context
  const varsPath = path.join(sessionDir, "variables.json");
  let variables: Record<string, unknown> = {};
  try {
    variables = JSON.parse(fs.readFileSync(varsPath, "utf-8"));
  } catch {}

  // Load custom data files
  const data: Record<string, unknown> = {};
  try {
    for (const f of fs.readdirSync(sessionDir)) {
      if (f.endsWith(".json") && !SYSTEM_JSON.has(f)) {
        try {
          data[f.replace(".json", "")] = JSON.parse(
            fs.readFileSync(path.join(sessionDir, f), "utf-8")
          );
        } catch {}
      }
    }
  } catch {}

  const context = { variables: { ...variables }, data, sessionDir };

  // Execute tool with timeout
  try {
    const toolUrl = `file://${toolPath.replace(/\\/g, "/")}?t=${Date.now()}`;
    const mod = await import(toolUrl);
    const fn = typeof mod.default === "function" ? mod.default : mod;
    if (typeof fn !== "function") {
      return NextResponse.json({ error: "Tool does not export a function" }, { status: 500 });
    }

    const resultPromise = fn(context, args);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Tool execution timed out (10s)")), 10_000)
    );
    const result = await Promise.race([resultPromise, timeoutPromise]) as {
      variables?: Record<string, unknown>;
      data?: Record<string, Record<string, unknown>>;
      result?: unknown;
    } | undefined;

    // Apply variables patch
    if (result?.variables && typeof result.variables === "object") {
      try {
        const current = JSON.parse(fs.readFileSync(varsPath, "utf-8"));
        const merged = { ...current, ...result.variables };
        fs.writeFileSync(varsPath, JSON.stringify(merged, null, 2), "utf-8");
      } catch {}
    }

    // Apply data file patches
    if (result?.data && typeof result.data === "object") {
      for (const [fileName, patch] of Object.entries(result.data)) {
        if (!fileName.endsWith(".json") || fileName.includes("/") || fileName.includes("\\") || fileName.includes("..")) continue;
        if (PROTECTED_FILES.has(fileName)) continue;
        const filePath = path.join(sessionDir, fileName);
        try {
          let current: Record<string, unknown> = {};
          if (fs.existsSync(filePath)) {
            current = JSON.parse(fs.readFileSync(filePath, "utf-8"));
          }
          const merged = { ...current, ...patch };
          fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), "utf-8");
        } catch {}
      }
    }

    return NextResponse.json({ ok: true, result: result?.result ?? null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Tool execution failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
