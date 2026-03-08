import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { GeminiImageClient } from "@/lib/gemini-image";

export async function POST(req: Request) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "GEMINI_API_KEY not configured" },
      { status: 500 }
    );
  }

  const svc = getServices();

  const body = (await req.json()) as {
    prompt: string;
    filename?: string;
    persona?: string;
  };

  if (!body.prompt) {
    return NextResponse.json({ error: "Missing prompt" }, { status: 400 });
  }

  const filename = body.filename || `gemini_${Date.now()}.png`;

  // Determine target directory
  let targetDir: string;

  if (body.persona) {
    if (!svc.sessions.personaExists(body.persona)) {
      return NextResponse.json(
        { error: `Persona "${body.persona}" not found` },
        { status: 404 }
      );
    }
    targetDir = svc.sessions.getPersonaDir(body.persona);
  } else if (svc.currentSessionId) {
    targetDir = svc.sessions.getSessionDir(svc.currentSessionId);
  } else {
    return NextResponse.json(
      { error: "No active session and no persona specified" },
      { status: 400 }
    );
  }

  const model = process.env.GEMINI_IMAGE_MODEL || "gemini-2.0-flash-exp";
  const client = new GeminiImageClient({ apiKey, model });

  const resultPath = `images/${filename}`;

  // Background generation (fire-and-forget)
  client
    .generate({
      prompt: body.prompt,
      filename,
      sessionDir: targetDir,
    })
    .then((result) => {
      if (result.success) {
        console.log(`[gemini] Generated: ${result.filepath}`);
      } else {
        console.error(`[gemini] Generation failed: ${result.error}`);
      }
    })
    .catch((err) => {
      console.error(`[gemini] Unexpected error:`, err);
    });

  return NextResponse.json({
    status: "queued",
    path: resultPath,
  });
}
