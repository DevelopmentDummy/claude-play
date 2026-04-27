import * as fs from "fs";
import * as path from "path";
import { NextResponse } from "next/server";
import { getServices, getSessionInstance } from "@/lib/services";

const PROTECTED_FILES = new Set([
  "session.json", "builder-session.json", "layout.json",
  "chat-history.json", "package.json", "tsconfig.json",
]);

const SYSTEM_JSON = new Set([
  "variables.json", "session.json", "builder-session.json",
  "comfyui-config.json", "layout.json", "chat-history.json",
  "package.json", "tsconfig.json", "character-tags.json",
  "voice.json", "chat-options.json", "policy-context.json",
  "pending-events.json", "pending-actions.json",
]);

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; name: string }> }
) {
  const { id, name } = await params;
  const sessionId = decodeURIComponent(id);

  // Path traversal check
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    return NextResponse.json({ error: "Invalid tool name" }, { status: 400 });
  }

  const svc = getServices();
  const sessionDir = svc.sessions.getSessionDir(sessionId);
  const toolPath = path.join(sessionDir, "tools", `${name}.js`);

  if (!fs.existsSync(toolPath)) {
    return NextResponse.json({ error: `Tool "${name}" not found` }, { status: 404 });
  }

  // Parse args
  let args: Record<string, unknown> = {};
  try {
    const body = await req.json();
    args = typeof body?.args === "object" && body.args !== null ? body.args : {};

    // Args are passed through as-is to the tool function.
    // Engine dispatchers handle both flat ({ action, key: val }) and
    // wrapped ({ action, params: { key: val } }) styles internally.
  } catch {
    // empty args is fine
  }

  const action = typeof args.action === "string" ? args.action : null;
  const timeoutMs = name === "pipeline"
    ? 30 * 60 * 1000
    : 10_000;

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

  // Resolve parent persona — lets engine actions read/write persona-scoped files
  // (e.g. shared gallery, persona-level images) without leaving the session sandbox API.
  let personaName: string | null = null;
  let personaDir: string | null = null;
  try {
    const info = svc.sessions.getSessionInfo(sessionId);
    if (info?.persona) {
      personaName = info.persona;
      personaDir = svc.sessions.getPersonaDir(info.persona);
    }
  } catch {}

  const context = { variables: { ...variables }, data, sessionDir, personaDir, personaName };

  // Execute tool with timeout
  try {
    // eslint-disable-next-line no-eval -- bypass webpack interception
    const nativeRequire = eval("require") as NodeRequire;
    delete nativeRequire.cache[toolPath];
    const mod = nativeRequire(toolPath);
    const fn = typeof mod === "function" ? mod : mod.default;
    if (typeof fn !== "function") {
      return NextResponse.json({ error: "Tool does not export a function" }, { status: 500 });
    }

    const resultPromise = fn(context, args);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`Tool execution timed out (${Math.round(timeoutMs / 1000)}s)${action ? ` [${action}]` : ""}`)),
        timeoutMs,
      )
    );
    const result = await Promise.race([resultPromise, timeoutPromise]) as {
      variables?: Record<string, unknown>;
      data?: Record<string, Record<string, unknown>>;
      result?: unknown;
      _available_actions?: Array<{ action: string; label: string; args_hint: string | null }>;
    } | undefined;

    // Apply variables patch
    if (result?.variables && typeof result.variables === "object") {
      try {
        const current = JSON.parse(fs.readFileSync(varsPath, "utf-8"));

        // Extract __modals from result to handle via group-aware logic
        const modalChanges = result.variables.__modals as Record<string, unknown> | undefined;
        delete result.variables.__modals;

        const merged = { ...current, ...result.variables };

        // Apply modal changes with group-aware logic
        if (modalChanges && typeof modalChanges === "object" && !Array.isArray(modalChanges)) {
          const modals: Record<string, unknown> = { ...(current.__modals || {}) };

          // Read modal groups from layout.json
          let modalGroups: Record<string, string[]> = {};
          const layoutPath = path.join(sessionDir, "layout.json");
          try {
            if (fs.existsSync(layoutPath)) {
              let layoutRaw = fs.readFileSync(layoutPath, "utf-8");
              if (layoutRaw.charCodeAt(0) === 0xfeff) layoutRaw = layoutRaw.slice(1);
              modalGroups = JSON.parse(layoutRaw)?.panels?.modalGroups || {};
            }
          } catch {}

          for (const [name, value] of Object.entries(modalChanges)) {
            if (value && value !== false && value !== null) {
              // Opening — close same-group modals first
              for (const members of Object.values(modalGroups)) {
                if (members.includes(name)) {
                  for (const member of members) {
                    if (member !== name) modals[member] = false;
                  }
                  break;
                }
              }
              modals[name] = value;
            } else {
              modals[name] = false;
            }
          }
          merged.__modals = modals;
        }

        fs.writeFileSync(varsPath, JSON.stringify(merged, null, 2), "utf-8");
      } catch {}
    }

    // Apply data file patches
    if (result?.data && typeof result.data === "object") {
      for (const [rawKey, patch] of Object.entries(result.data)) {
        const fileName = rawKey.endsWith(".json") ? rawKey : `${rawKey}.json`;
        if (fileName.includes("/") || fileName.includes("\\") || fileName.includes("..")) continue;
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

    // Auto-queue events from engine results
    const toolResult = result?.result as Record<string, unknown> | undefined;
    if (toolResult?.search_init_event && typeof toolResult.search_init_event === "string") {
      const instance = getSessionInstance(sessionId);
      if (instance) {
        instance.queueEvent(toolResult.search_init_event);
        instance.broadcast("event:pending", { headers: instance.getPendingEvents() });
      }
    }
    // Auto-queue result events (e.g. milking results, purchase confirmations)
    if (toolResult?.queue_events && Array.isArray(toolResult.queue_events)) {
      const instance = getSessionInstance(sessionId);
      if (instance) {
        for (const header of toolResult.queue_events) {
          if (typeof header === "string") instance.queueEvent(header);
        }
        instance.broadcast("event:pending", { headers: instance.getPendingEvents() });
      }
    }

    return NextResponse.json({
      ok: true,
      result: result?.result ?? null,
      _available_actions: result?._available_actions ?? null,
    });
  } catch (err) {
    console.error(`[tools/${name}] execution error:`, err);
    const message = err instanceof Error ? err.message : "Tool execution failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
