import { NextResponse } from "next/server";
import { ComfyUIClient } from "@/lib/comfyui-client";

export async function GET() {
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
