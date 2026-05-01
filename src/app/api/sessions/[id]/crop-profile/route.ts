import { NextResponse } from "next/server";
import * as path from "path";
import * as fs from "fs";
import sharp from "sharp";
import { getSessionManager } from "@/lib/services";
import { ComfyUIClient } from "@/lib/comfyui-client";
import { wsBroadcast } from "@/lib/ws-server";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const sm = getSessionManager();
  const sessionDir = sm.getSessionDir(id);

  const body = (await req.json()) as {
    sourceImage: string;
    crop: { x: number; y: number; width: number; height: number };
  };

  if (!body.sourceImage || !body.crop) {
    return NextResponse.json(
      { error: "Missing sourceImage or crop" },
      { status: 400 }
    );
  }

  const sourceImagePath = path.join(sessionDir, body.sourceImage);
  if (!fs.existsSync(sourceImagePath)) {
    return NextResponse.json(
      { error: `Source image not found: ${body.sourceImage}` },
      { status: 404 }
    );
  }

  const imagesDir = path.join(sessionDir, "images");
  fs.mkdirSync(imagesDir, { recursive: true });

  // Step 1: Crop with sharp → profile.png
  const profilePath = path.join(imagesDir, "profile.png");
  const { x, y, width, height } = body.crop;
  await sharp(sourceImagePath)
    .extract({
      left: Math.round(x),
      top: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
    })
    .toFile(profilePath);

  console.log(
    `[crop-profile] Cropped ${body.sourceImage} (${x},${y},${width}x${height}) → profile.png`
  );

  // Step 2: Face-crop for icon
  const host = process.env.COMFYUI_HOST || "127.0.0.1";
  const port = parseInt(process.env.COMFYUI_PORT || "8188", 10);
  const workflowsDir = path.join(
    process.cwd(), "data", "tools", "comfyui", "skills", "generate-image", "workflows"
  );
  const client = new ComfyUIClient({ host, port }, workflowsDir);

  let iconResult;
  try {
    iconResult = await client.faceCrop(profilePath, "icon.png", sessionDir);
  } catch (err) {
    console.error(`[crop-profile] Face crop failed:`, err);
    iconResult = { success: false, error: String(err) };
  }

  // Step 3: Sync to persona directory
  const sessionInfo = sm.getSessionInfo(id);
  const personaName = sessionInfo?.persona;
  let personaSynced = false;
  if (personaName && sm.personaExists(personaName)) {
    try {
      const personaImagesDir = path.join(
        sm.getPersonaDir(personaName), "images"
      );
      fs.mkdirSync(personaImagesDir, { recursive: true });
      fs.copyFileSync(profilePath, path.join(personaImagesDir, "profile.png"));
      if (iconResult?.success) {
        const sessionIconPath = path.join(imagesDir, "icon.png");
        if (fs.existsSync(sessionIconPath)) {
          fs.copyFileSync(
            sessionIconPath,
            path.join(personaImagesDir, "icon.png")
          );
        }
      }
      personaSynced = true;
    } catch (err) {
      console.error(`[crop-profile] Persona sync failed:`, err);
    }
  }

  // Step 4: Broadcast
  const timestamp = Date.now();
  wsBroadcast("profile:update", {
    sessionId: id,
    profile: "images/profile.png",
    icon: iconResult?.success ? "images/icon.png" : null,
    timestamp,
  }, { sessionId: id });

  return NextResponse.json({
    status: "success",
    profile: "images/profile.png",
    icon: iconResult?.success ? "images/icon.png" : null,
    iconError: iconResult?.success ? undefined : iconResult?.error,
    personaSynced,
  });
}
