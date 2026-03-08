import { NextResponse } from "next/server";
import * as path from "path";
import { getServices } from "@/lib/services";
import { ComfyUIClient } from "@/lib/comfyui-client";

const COMFY_QUEUE_KEY = "__claude_bridge_comfy_queue__";
interface ComfyQueueState {
  running: number;
  jobs: Array<() => Promise<void>>;
}

function getComfyQueueState(): ComfyQueueState {
  const g = globalThis as unknown as Record<string, ComfyQueueState>;
  if (!g[COMFY_QUEUE_KEY]) {
    g[COMFY_QUEUE_KEY] = { running: 0, jobs: [] };
  }
  return g[COMFY_QUEUE_KEY];
}

function maxComfyConcurrency(): number {
  const parsed = parseInt(process.env.COMFYUI_MAX_CONCURRENCY || "1", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function scheduleComfyJob(job: () => Promise<void>): void {
  const state = getComfyQueueState();
  const max = maxComfyConcurrency();

  const runNext = () => {
    while (state.running < max && state.jobs.length > 0) {
      const next = state.jobs.shift();
      if (!next) return;
      state.running += 1;
      next()
        .catch(() => { /* handled in caller */ })
        .finally(() => {
          state.running -= 1;
          runNext();
        });
    }
  };

  state.jobs.push(job);
  runNext();
}

export async function POST(req: Request) {
  const svc = getServices();

  const body = (await req.json()) as {
    workflow?: string;
    params?: Record<string, unknown>;
    raw?: Record<string, unknown>;
    filename?: string;
    extraFiles?: Record<string, string>;
    loras?: Array<{ name: string; strength: number }>;
    persona?: string; // For builder: generate directly into persona directory
  };

  if (!body.filename) {
    return NextResponse.json(
      { error: "Missing filename" },
      { status: 400 }
    );
  }

  if (!body.workflow && !body.raw) {
    return NextResponse.json(
      { error: "Must provide either workflow (template) or raw (workflow JSON)" },
      { status: 400 }
    );
  }

  // Determine target directory: active session or persona dir (for builder)
  let targetDir: string;
  let workflowsDir: string;

  if (body.persona) {
    // Builder mode: save directly to persona directory
    if (!svc.sessions.personaExists(body.persona)) {
      return NextResponse.json(
        { error: `Persona "${body.persona}" not found` },
        { status: 404 }
      );
    }
    targetDir = svc.sessions.getPersonaDir(body.persona);
    // Workflows from the tools directory (source of truth)
    workflowsDir = path.join(
      process.cwd(), "data", "tools", "comfyui", "skills", "generate-image", "workflows"
    );
  } else if (svc.currentSessionId) {
    // Session mode: save to session directory
    targetDir = svc.sessions.getSessionDir(svc.currentSessionId);
    workflowsDir = path.join(
      process.cwd(), "data", "tools", "comfyui", "skills", "generate-image", "workflows"
    );
  } else {
    return NextResponse.json(
      { error: "No active session and no persona specified" },
      { status: 400 }
    );
  }

  const safeName = path.basename(body.filename);

  const host = process.env.COMFYUI_HOST || "127.0.0.1";
  const port = parseInt(process.env.COMFYUI_PORT || "8188", 10);
  const checkpoint = process.env.COMFYUI_CHECKPOINT;
  const client = new ComfyUIClient({ host, port, checkpoint }, workflowsDir);

  const resultPath = `images/${safeName}`;

  scheduleComfyJob(async () => {
    try {
      const result = body.raw
        ? await client.generateRaw({
            prompt: body.raw,
            filename: safeName,
            sessionDir: targetDir,
            extraFiles: body.extraFiles,
          })
        : await client.generate({
            workflow: body.workflow!,
            params: body.params || {},
            filename: safeName,
            sessionDir: targetDir,
            extraFiles: body.extraFiles,
            loras: body.loras,
          });
      if (result.success) {
        console.log(`[comfyui] Generated: ${result.filepath}`);
      } else {
        console.error(`[comfyui] Generation failed: ${result.error}`);
      }
    } catch (err) {
      console.error(`[comfyui] Unexpected error:`, err);
    }
  });

  return NextResponse.json({
    status: "queued",
    path: resultPath,
  });
}
