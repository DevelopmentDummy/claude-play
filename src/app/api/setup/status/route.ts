import { NextRequest, NextResponse } from "next/server";
import { readEnvFile } from "@/lib/env-file";
import { isSetupComplete, requireSetupAuth } from "@/lib/setup-guard";

export async function GET(req: NextRequest) {
  const authError = requireSetupAuth(req);
  if (authError) return authError;

  const env = readEnvFile();
  return NextResponse.json({
    setupComplete: isSetupComplete(),
    adminPassword: !!env.ADMIN_PASSWORD,
    comfyui: !!(env.COMFYUI_HOST || env.COMFYUI_PORT),
    comfyuiHost: env.COMFYUI_HOST || "127.0.0.1",
    comfyuiPort: env.COMFYUI_PORT || "8188",
    geminiKey: !!env.GEMINI_API_KEY,
    civitaiKey: !!env.CIVITAI_API_KEY,
    ttsEnabled: env.TTS_ENABLED !== "false",
    port: env.PORT || "3340",
  });
}
