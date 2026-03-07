import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { ComfyUIClient } from "@/lib/comfyui-client";

export async function GET(req: Request) {
  const auth = requireAuth(req);
  if (auth instanceof Response) return auth;
  const host = process.env.COMFYUI_HOST || "127.0.0.1";
  const port = parseInt(process.env.COMFYUI_PORT || "8188", 10);
  const client = new ComfyUIClient({ host, port }, "");

  try {
    const models = await client.getAvailableModels();
    return NextResponse.json(models);
  } catch {
    return NextResponse.json(
      { error: "Failed to query ComfyUI models" },
      { status: 502 }
    );
  }
}
