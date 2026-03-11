import { NextResponse } from "next/server";
import * as path from "path";
import * as fs from "fs";
import sharp from "sharp";
import { getSessionManager } from "@/lib/services";
import { ComfyUIClient } from "@/lib/comfyui-client";
import { wsBroadcast } from "@/lib/ws-server";

/**
 * Update profile image and auto-generate face-cropped icon.
 * 1. Copies sourceImage → images/profile.png
 * 2. Runs YOLO face detection → images/icon.png (256x256)
 * 3. Syncs both to persona directory
 */
export async function POST(req: Request) {
  const sm = getSessionManager();

  const body = (await req.json()) as {
    sourceImage: string; // Relative path, e.g. "images/mira-walk-flustered-202.png"
    persona?: string;
    sessionId?: string;
    crop?: { x: number; y: number; width: number; height: number };
  };

  if (!body.sourceImage) {
    return NextResponse.json(
      { error: "Missing sourceImage" },
      { status: 400 }
    );
  }

  const sessionId = body.sessionId;
  if (!sessionId) {
    return NextResponse.json(
      { error: "sessionId required" },
      { status: 400 }
    );
  }

  const sessionDir = sm.getSessionDir(sessionId);

  const sourceImagePath = path.join(sessionDir, body.sourceImage);
  if (!fs.existsSync(sourceImagePath)) {
    return NextResponse.json(
      { error: `Source image not found: ${body.sourceImage}` },
      { status: 404 }
    );
  }

  // If no crop coordinates → open crop modal panel via variables.json and return immediately
  if (!body.crop) {
    const varsPath = path.join(sessionDir, "variables.json");
    try {
      const vars = fs.existsSync(varsPath)
        ? JSON.parse(fs.readFileSync(varsPath, "utf-8"))
        : {};
      vars.__cropSource = body.sourceImage;
      vars.__modals = { ...(vars.__modals || {}), "profile-crop": "dismissible" };
      fs.writeFileSync(varsPath, JSON.stringify(vars, null, 2), "utf-8");
    } catch (err) {
      console.error("[update-profile] Failed to update variables for crop modal:", err);
    }
    return NextResponse.json({
      status: "pending_crop",
      message: "Crop modal opened for user. Profile will be updated after user confirms crop area.",
    });
  }

  const imagesDir = path.join(sessionDir, "images");
  fs.mkdirSync(imagesDir, { recursive: true });

  // Step 1: Crop source image and save as profile.png
  const profilePath = path.join(imagesDir, "profile.png");
  await sharp(sourceImagePath)
    .extract({
      left: Math.round(body.crop.x),
      top: Math.round(body.crop.y),
      width: Math.round(body.crop.width),
      height: Math.round(body.crop.height),
    })
    .toFile(profilePath);
  console.log(`[update-profile] Cropped ${body.sourceImage} → profile.png`);

  // Step 2: Face-crop for icon
  const host = process.env.COMFYUI_HOST || "127.0.0.1";
  const port = parseInt(process.env.COMFYUI_PORT || "8188", 10);
  const workflowsDir = path.join(
    process.cwd(), "data", "tools", "comfyui", "skills", "generate-image", "workflows"
  );
  const client = new ComfyUIClient({ host, port }, workflowsDir);

  let iconResult;
  try {
    iconResult = await client.faceCrop(sourceImagePath, "icon.png", sessionDir);
  } catch (err) {
    console.error(`[update-profile] Face crop failed:`, err);
    iconResult = { success: false, error: String(err) };
  }

  // Step 3: Sync to persona directory
  const sessionInfo = sm.getSessionInfo(sessionId);
  const personaName = body.persona || sessionInfo?.persona;
  let personaSynced = false;
  if (personaName && sm.personaExists(personaName)) {
    try {
      const personaImagesDir = path.join(sm.getPersonaDir(personaName), "images");
      fs.mkdirSync(personaImagesDir, { recursive: true });
      fs.copyFileSync(profilePath, path.join(personaImagesDir, "profile.png"));
      if (iconResult?.success) {
        const sessionIconPath = path.join(imagesDir, "icon.png");
        if (fs.existsSync(sessionIconPath)) {
          fs.copyFileSync(sessionIconPath, path.join(personaImagesDir, "icon.png"));
        }
      }
      personaSynced = true;
      console.log(`[update-profile] Synced profile & icon to persona: ${personaName}`);
    } catch (err) {
      console.error(`[update-profile] Persona sync failed:`, err);
    }
  }

  // Broadcast profile update to all connected clients so frontend can refresh images
  const timestamp = Date.now();
  wsBroadcast("profile:update", {
    sessionId,
    profile: "images/profile.png",
    icon: iconResult?.success ? "images/icon.png" : null,
    timestamp,
  });

  return NextResponse.json({
    status: "success",
    profile: "images/profile.png",
    icon: iconResult?.success ? "images/icon.png" : null,
    iconError: iconResult?.success ? undefined : iconResult?.error,
    personaSynced,
    personaName: personaName || null,
  });
}
