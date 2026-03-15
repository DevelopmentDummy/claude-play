import { NextResponse } from "next/server";
import * as path from "path";
import * as fs from "fs";
import { getSessionManager } from "@/lib/services";
import { ComfyUIClient } from "@/lib/comfyui-client";

export async function POST(req: Request) {
  const sm = getSessionManager();

  const body = (await req.json()) as {
    workflow?: string;
    params?: Record<string, unknown>;
    raw?: Record<string, unknown>;
    filename?: string;
    extraFiles?: Record<string, string>;
    loras?: Array<{ name: string; strength: number }>;
    persona?: string; // For builder: generate directly into persona directory
    sessionId?: string;
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
    if (!sm.personaExists(body.persona)) {
      return NextResponse.json(
        { error: `Persona "${body.persona}" not found` },
        { status: 404 }
      );
    }
    targetDir = sm.getPersonaDir(body.persona);
    // Workflows from the tools directory (source of truth)
    workflowsDir = path.join(
      process.cwd(), "data", "tools", "comfyui", "skills", "generate-image", "workflows"
    );
  } else if (body.sessionId) {
    // Session mode: save to session directory
    targetDir = sm.getSessionDir(body.sessionId);
    workflowsDir = path.join(
      process.cwd(), "data", "tools", "comfyui", "skills", "generate-image", "workflows"
    );
  } else {
    return NextResponse.json(
      { error: "No sessionId and no persona specified" },
      { status: 400 }
    );
  }

  const safeName = path.basename(body.filename);

  const host = process.env.COMFYUI_HOST || "127.0.0.1";
  const port = parseInt(process.env.COMFYUI_PORT || "8188", 10);
  // Read checkpoint from config preset, env var as override
  let checkpoint = process.env.COMFYUI_CHECKPOINT;
  if (!checkpoint) {
    // Try session/persona config, then global fallback
    const configPaths = [
      path.join(targetDir, "comfyui-config.json"),
      path.join(process.cwd(), "data", "tools", "comfyui", "comfyui-config.json"),
    ];
    for (const configPath of configPaths) {
      try {
        if (!fs.existsSync(configPath)) continue;
        const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        const presetName = config?.active_preset;
        const preset = presetName && config?.presets?.[presetName];
        const ckpt = preset?.checkpoint || config?.checkpoint;
        if (ckpt) { checkpoint = ckpt; break; }
      } catch { /* ignore */ }
    }
  }
  const client = new ComfyUIClient({ host, port, checkpoint }, workflowsDir);

  const resultPath = `images/${safeName}`;

  // Phase 1: Build prompt (awaited — catches template/param errors early)
  let prompt: Record<string, unknown>;
  try {
    if (body.raw) {
      prompt = body.raw;
    } else {
      prompt = await client.buildPrompt(
        body.workflow!,
        body.params || {},
        targetDir,
        body.loras
      ) as Record<string, unknown>;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[comfyui] Prompt build failed: ${message}`);
    return NextResponse.json({ error: `Prompt build failed: ${message}` }, { status: 400 });
  }

  // Phase 2: Route by backend
  if (await client.isGpuManagerAvailable()) {
    // GPU Manager is synchronous — fire-and-forget the entire generation.
    // GPU Manager health check passed, so queue entry is reliable.
    (async () => {
      try {
        const result = body.raw
          ? await client.generateRaw({ prompt: body.raw, filename: safeName, sessionDir: targetDir, extraFiles: body.extraFiles })
          : await client.generate({ workflow: body.workflow!, params: body.params || {}, filename: safeName, sessionDir: targetDir, extraFiles: body.extraFiles, loras: body.loras });
        if (result.success) {
          console.log(`[comfyui] Generated (gpu-manager): ${result.filepath}`);
        } else {
          console.error(`[comfyui] Generation failed (gpu-manager): ${result.error}`);
        }
      } catch (err) {
        console.error(`[comfyui] Unexpected error (gpu-manager):`, err);
      }
    })();
  } else {
    // Direct ComfyUI: await queue entry, fire-and-forget polling + download
    const handle = await client.submitToQueue(prompt);
    if ("error" in handle) {
      console.error(`[comfyui] Queue submission failed: ${handle.error}`);
      return NextResponse.json({ error: handle.error }, { status: 502 });
    }

    (async () => {
      try {
        const result = await client.waitAndDownload(handle.promptId, safeName, targetDir, body.extraFiles);
        if (result.success) {
          console.log(`[comfyui] Generated (direct): ${result.filepath}`);
        } else {
          console.error(`[comfyui] Generation failed (direct): ${result.error}`);
        }
      } catch (err) {
        console.error(`[comfyui] Unexpected error (direct):`, err);
      }
    })();
  }

  return NextResponse.json({
    status: "queued",
    path: resultPath,
  });
}
