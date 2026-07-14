import { NextResponse } from "next/server";
import * as path from "path";
import * as fs from "fs";
import { getSessionManager } from "@/lib/services";
import { GeminiImageClient } from "@/lib/gemini-image";
import { validateInternalToken } from "@/lib/auth";
import { flattenGeneratedFile, cleanupEmptyImagesDir } from "@/lib/external-mcp/flatten";

export async function POST(req: Request) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "GEMINI_API_KEY not configured" },
      { status: 500 }
    );
  }

  const sm = getSessionManager();

  const body = (await req.json()) as {
    prompt: string;
    filename?: string;
    persona?: string;
    sessionId?: string;
    referenceImage?: string | string[];
    aspectRatio?: string;
    imageSize?: string;
    outputDir?: string; // 외부 MCP: 절대경로 지정 시 세션/페르소나 대신 이 디렉토리에 저장
  };

  if (!body.prompt) {
    return NextResponse.json({ error: "Missing prompt" }, { status: 400 });
  }

  const filename = body.filename || `gemini_${Date.now()}.png`;

  // Determine target directory
  let targetDir: string;
  const externalOutputDir = body.outputDir?.trim() || null;

  if (externalOutputDir) {
    // 외부 MCP 전용 — 내부 토큰 인증 요청에서만 허용 (쿠키 인증으로 임의 경로 쓰기 방지)
    if (!validateInternalToken(req)) {
      return NextResponse.json(
        { error: "outputDir requires internal token authentication" },
        { status: 403 }
      );
    }
    if (!path.isAbsolute(externalOutputDir)) {
      return NextResponse.json({ error: "outputDir must be an absolute path" }, { status: 400 });
    }
    fs.mkdirSync(externalOutputDir, { recursive: true });
    targetDir = externalOutputDir;
  } else if (body.persona) {
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

  const model = process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image-preview";
  const client = new GeminiImageClient({ apiKey, model });

  const resultPath = `images/${filename}`;

  // 외부 분기: 폴링 UI가 없으므로 완료를 기다렸다가 절대경로로 응답
  if (externalOutputDir) {
    const result = await client.generate({
      prompt: body.prompt,
      filename,
      sessionDir: targetDir,
      referenceImage: body.referenceImage,
      aspectRatio: body.aspectRatio,
      imageSize: body.imageSize,
    });
    if (!result.success) {
      return NextResponse.json({ error: result.error || "Image generation failed" }, { status: 502 });
    }
    const abs = flattenGeneratedFile(externalOutputDir, result.filepath || resultPath);
    cleanupEmptyImagesDir(externalOutputDir);
    return NextResponse.json({ status: "success", path: abs });
  }

  // Background generation (fire-and-forget)
  client
    .generate({
      prompt: body.prompt,
      filename,
      sessionDir: targetDir,
      referenceImage: body.referenceImage,
      aspectRatio: body.aspectRatio,
      imageSize: body.imageSize,
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
