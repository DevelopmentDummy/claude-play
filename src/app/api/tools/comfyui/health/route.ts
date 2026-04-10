import { NextResponse } from "next/server";
import { ComfyUIClient } from "@/lib/comfyui-client";

export async function GET() {
  const host = process.env.COMFYUI_HOST || "127.0.0.1";
  const port = parseInt(process.env.COMFYUI_PORT || "8188", 10);
  const gpuManagerPort = process.env.GPU_MANAGER_PORT || "3342";
  const client = new ComfyUIClient({ host, port }, "");

  const result: Record<string, unknown> = {
    comfyui: { host, port, status: "unknown" },
    gpuManager: { port: gpuManagerPort, status: "unknown" },
  };

  // Check ComfyUI direct connection
  const comfyReachable = await client.isComfyUIReachable();
  (result.comfyui as Record<string, unknown>).status = comfyReachable ? "connected" : "unreachable";

  if (comfyReachable) {
    try {
      const res = await fetch(`http://${host}:${port}/system_stats`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) {
        (result.comfyui as Record<string, unknown>).systemStats = await res.json();
      }
    } catch { /* ignore */ }
  }

  // Check GPU Manager
  try {
    const res = await fetch(`http://127.0.0.1:${gpuManagerPort}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    (result.gpuManager as Record<string, unknown>).status = res.ok ? "connected" : "unreachable";
    if (res.ok) {
      try {
        (result.gpuManager as Record<string, unknown>).info = await res.json();
      } catch { /* ignore */ }
    }
  } catch {
    (result.gpuManager as Record<string, unknown>).status = "unreachable";
  }

  const anyConnected = comfyReachable ||
    (result.gpuManager as Record<string, unknown>).status === "connected";

  return NextResponse.json(result, { status: anyConnected ? 200 : 503 });
}
