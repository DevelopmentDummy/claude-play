import { NextResponse } from "next/server";
import { getSessionManager } from "@/lib/services";
import { OpenAIImageClient } from "@/lib/openai-image";
import { CodexImageClient } from "@/lib/codex-image";

// Backend selection:
//   "codex" (default) — render via the Codex CLI's built-in image_gen tool,
//                        covered by the ChatGPT subscription (no per-call cost).
//   "api"             — render via the metered OpenAI Responses API (needs OPENAI_API_KEY).
function selectedBackend(): "codex" | "api" {
  return (process.env.OPENAI_IMAGE_BACKEND || "codex").toLowerCase() === "api" ? "api" : "codex";
}

export async function POST(req: Request) {
  const backend = selectedBackend();

  const sm = getSessionManager();

  const body = (await req.json()) as {
    prompt: string;
    filename?: string;
    persona?: string;
    sessionId?: string;
    referenceImage?: string;
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

  // Build the chosen backend client (the API path requires a key).
  let client: { generate: (r: {
    prompt: string; filename: string; sessionDir: string;
    referenceImage?: string; size?: string; quality?: string;
  }) => Promise<{ success: boolean; filepath?: string; error?: string }> };

  if (backend === "api") {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "OPENAI_API_KEY not configured" }, { status: 500 });
    }
    const model = process.env.OPENAI_IMAGE_MODEL || "gpt-5.5";
    client = new OpenAIImageClient({ apiKey, model });
  } else {
    client = new CodexImageClient();
  }

  const resultPath = `images/${filename}`;
  const logTag = backend === "api" ? "openai" : "codex-image";

  // Background generation (fire-and-forget)
  client
    .generate({
      prompt: body.prompt,
      filename,
      sessionDir: targetDir,
      referenceImage: body.referenceImage,
      size: body.size,
      quality: body.quality,
    })
    .then((result) => {
      if (result.success) {
        console.log(`[${logTag}] Generated: ${result.filepath}`);
      } else {
        console.error(`[${logTag}] Generation failed: ${result.error}`);
      }
    })
    .catch((err) => {
      console.error(`[${logTag}] Unexpected error:`, err);
    });

  return NextResponse.json({
    status: "queued",
    path: resultPath,
  });
}
