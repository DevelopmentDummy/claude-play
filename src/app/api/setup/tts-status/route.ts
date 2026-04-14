import { NextResponse } from "next/server";

export async function GET() {
  const gpuManagerPort = parseInt(process.env.GPU_MANAGER_PORT || String((parseInt(process.env.PORT || "3340", 10)) + 2), 10);
  try {
    const res = await fetch(`http://127.0.0.1:${gpuManagerPort}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = await res.json();
      return NextResponse.json({
        gpuManagerAvailable: true,
        ttsAvailable: data.tts_available ?? false,
        voxcpmAvailable: data.voxcpm_available ?? false,
      });
    }
    return NextResponse.json({ gpuManagerAvailable: false, ttsAvailable: false });
  } catch {
    return NextResponse.json({ gpuManagerAvailable: false, ttsAvailable: false });
  }
}
