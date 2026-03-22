import { NextResponse } from "next/server";
import { getSessionManager } from "@/lib/services";
import { OpenAIImageClient } from "@/lib/openai-image";

export async function POST(req: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY not configured" },
      { status: 500 }
    );
  }

  const sm = getSessionManager();

  const body = (await req.json()) as {
    prompt: string;
    filename?: string;
    persona?: string;
    sessionId?: string;
    size?: string;
    quality?: string;
  };

  if (!body.prompt) {
    return NextResponse.json({ error: "Missing prompt" }, { status: 400 });
  }

  const filename = body.filename || `openai_${Date.now()}.png`;

  // Determine target directory
  let targetDir: string;

  if (body.persona) {
    if (!sm.personaExists(body.persona)) {
      return NextResponse.json(
        { error: `Persona "${body.persona}" not found` },
        { status: 404 }
      );
    }
    targetDir = sm.getPersonaDir(body.persona);
  } else if (body.sessionId) {
    targetDir = sm.getSessionDir(body.sessionId);
  } else {
    return NextResponse.json(
      { error: "No sessionId and no persona specified" },
      { status: 400 }
    );
  }

  const model = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1.5";
  const client = new OpenAIImageClient({ apiKey, model });

  const resultPath = `images/${filename}`;

  // Background generation (fire-and-forget)
  client
    .generate({
      prompt: body.prompt,
      filename,
      sessionDir: targetDir,
      size: body.size,
      quality: body.quality,
    })
    .then((result) => {
      if (result.success) {
        console.log(`[openai] Generated: ${result.filepath}`);
      } else {
        console.error(`[openai] Generation failed: ${result.error}`);
      }
    })
    .catch((err) => {
      console.error(`[openai] Unexpected error:`, err);
    });

  return NextResponse.json({
    status: "queued",
    path: resultPath,
  });
}
