import { NextRequest, NextResponse } from "next/server";
import { writeEnvFile, readEnvFile } from "@/lib/env-file";
import { markSetupComplete } from "@/lib/setup-guard";
import { requireSetupAuth } from "@/lib/setup-auth";

export async function POST(req: NextRequest) {
  const authError = requireSetupAuth(req);
  if (authError) return authError;

  const body = await req.json();
  const updates: Record<string, string> = {};

  if (body.adminPassword) updates.ADMIN_PASSWORD = String(body.adminPassword);
  if (body.comfyuiEnabled === false) {
    updates.COMFYUI_HOST = "";
    updates.COMFYUI_PORT = "";
  } else {
    if (body.comfyuiHost) updates.COMFYUI_HOST = String(body.comfyuiHost);
    if (body.comfyuiPort) updates.COMFYUI_PORT = String(body.comfyuiPort);
  }
  if (body.geminiKey) updates.GEMINI_API_KEY = String(body.geminiKey);
  if (body.civitaiKey) updates.CIVITAI_API_KEY = String(body.civitaiKey);
  if (body.ttsEnabled !== undefined) updates.TTS_ENABLED = String(body.ttsEnabled);
  if (body.port) updates.PORT = String(body.port);

  // Merge with existing
  const existing = readEnvFile();
  writeEnvFile({ ...existing, ...updates });

  // Update process.env immediately
  for (const [k, v] of Object.entries(updates)) {
    process.env[k] = v;
  }

  // Mark setup complete
  markSetupComplete();

  // Trigger restart after response is sent
  setTimeout(() => {
    const { spawn } = require("child_process");
    // Spawn a new server process, then exit current one
    const child = spawn(process.argv[0], process.argv.slice(1), {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      env: { ...process.env, ...updates },
    });
    child.unref();
    process.exit(0);
  }, 500);

  return NextResponse.json({ ok: true, restart: true });
}
