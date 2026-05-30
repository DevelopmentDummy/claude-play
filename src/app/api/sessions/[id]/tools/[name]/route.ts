import * as fs from "fs";
import * as path from "path";
import { NextResponse } from "next/server";
import { getServices, getSessionInstance } from "@/lib/services";
import { spawnBackgroundClaude } from "@/lib/background-session";
import { mutateSessionJson, applyPatch, loadSessionData, resolveSessionFilePath } from "@/lib/session-state";

const PROTECTED_FILES = new Set([
  "session.json", "builder-session.json", "layout.json",
  "chat-history.json", "package.json", "tsconfig.json",
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
  const { variables, data } = loadSessionData(sessionDir);

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

    const failed: string[] = [];

    // Apply variables patch (중앙화 + __modals 그룹 로직 보존)
    if (result?.variables && typeof result.variables === "object") {
      const modalChanges = result.variables.__modals as Record<string, unknown> | undefined;
      delete result.variables.__modals;
      const restVars = result.variables as Record<string, unknown>;
      const vr = await mutateSessionJson(varsPath, (current) => {
        const merged = applyPatch(current, restVars);
        if (modalChanges && typeof modalChanges === "object" && !Array.isArray(modalChanges)) {
          const modals: Record<string, unknown> = { ...((current.__modals as Record<string, unknown>) || {}) };
          let modalGroups: Record<string, string[]> = {};
          const layoutPath = path.join(sessionDir, "layout.json");
          try {
            if (fs.existsSync(layoutPath)) {
              let layoutRaw = fs.readFileSync(layoutPath, "utf-8");
              if (layoutRaw.charCodeAt(0) === 0xfeff) layoutRaw = layoutRaw.slice(1);
              modalGroups = JSON.parse(layoutRaw)?.panels?.modalGroups || {};
            }
          } catch {}
          for (const [mName, value] of Object.entries(modalChanges)) {
            if (value && value !== false && value !== null) {
              for (const members of Object.values(modalGroups)) {
                if (members.includes(mName)) {
                  for (const member of members) if (member !== mName) modals[member] = false;
                  break;
                }
              }
              modals[mName] = value;
            } else {
              modals[mName] = false;
            }
          }
          merged.__modals = modals;
        }
        return merged;
      });
      if (!vr.ok) failed.push("variables.json");
    }

    // Apply data file patches
    if (result?.data && typeof result.data === "object") {
      for (const [rawKey, patch] of Object.entries(result.data)) {
        if (!patch || typeof patch !== "object") continue;
        const fileName = rawKey.endsWith(".json") ? rawKey : `${rawKey}.json`;
        if (PROTECTED_FILES.has(fileName)) continue;
        const filePath = resolveSessionFilePath(sessionDir, fileName);
        if (!filePath) continue;
        const dr = await mutateSessionJson(filePath, (current) =>
          applyPatch(current, patch as Record<string, unknown>),
        );
        if (!dr.ok) failed.push(fileName);
      }
    }

    // Honor fire-and-forget background AI request from engine result.
    // Engine actions can return `result.fireAi: { prompt, model?, effort?, notify?, useSessionContext? }`
    // to spawn a background Claude session — used for auto daily summaries on day advance.
    const fireAi = (result?.result as { fireAi?: unknown })?.fireAi;
    if (fireAi && typeof fireAi === "object") {
      try {
        const fa = fireAi as {
          prompt?: string;
          model?: string;
          effort?: string;
          notify?: boolean;
          useSessionContext?: boolean;
        };
        if (typeof fa.prompt === "string" && fa.prompt.trim()) {
          console.log(`[tools/${name} fireAi] spawning bg claude for ${sessionId} (model=${fa.model || "default"}, effort=${fa.effort || "default"})`);
          spawnBackgroundClaude({
            sessionDir,
            prompt: fa.prompt,
            model: fa.model,
            effort: fa.effort,
            notify: fa.notify ?? false,
            useSessionContext: fa.useSessionContext ?? true,
            callerSessionId: sessionId,
          });
        }
      } catch (err) {
        console.error(`[tools/${name} fireAi] spawn error:`, err);
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
      ...(failed.length ? { failed } : {}),
    });
  } catch (err) {
    console.error(`[tools/${name}] execution error:`, err);
    const message = err instanceof Error ? err.message : "Tool execution failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
