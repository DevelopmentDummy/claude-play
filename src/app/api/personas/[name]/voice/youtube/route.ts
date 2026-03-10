import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { getServices } from "@/lib/services";

const execFileAsync = promisify(execFile);

/**
 * POST: Download YouTube audio, trim to range, save as reference audio
 * Body: { url: string, start?: number, end?: number, preview?: boolean }
 * - start/end in seconds
 * - preview=true: return trimmed audio without saving as reference
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const { sessions } = getServices();
  const dir = sessions.getPersonaDir(name);

  if (!fs.existsSync(dir)) {
    return NextResponse.json({ error: "Persona not found" }, { status: 404 });
  }

  const body = (await req.json()) as {
    url: string;
    start?: number;
    end?: number;
    preview?: boolean;
  };

  if (!body.url) {
    return NextResponse.json({ error: "Missing url" }, { status: 400 });
  }

  const tmpDir = os.tmpdir();
  const tmpId = `yt-${Date.now()}`;
  const tmpRaw = path.join(tmpDir, `${tmpId}-raw`);
  const tmpOut = path.join(tmpDir, `${tmpId}.mp3`);

  try {
    // Step 1: Download audio with yt-dlp
    await execFileAsync("yt-dlp", [
      "-x",
      "--audio-format", "mp3",
      "--audio-quality", "0",
      "-o", tmpRaw + ".%(ext)s",
      body.url,
    ], { timeout: 60000 });

    // Find the downloaded file (yt-dlp may output different extensions before converting)
    const rawFile = tmpRaw + ".mp3";
    if (!fs.existsSync(rawFile)) {
      return NextResponse.json({ error: "Download failed" }, { status: 500 });
    }

    // Step 2: Trim with ffmpeg
    const ffmpegArgs = ["-i", rawFile, "-y"];
    if (body.start != null) {
      ffmpegArgs.push("-ss", String(body.start));
    }
    if (body.end != null) {
      const duration = (body.end) - (body.start || 0);
      if (duration <= 0) {
        return NextResponse.json({ error: "Invalid time range" }, { status: 400 });
      }
      ffmpegArgs.push("-t", String(duration));
    }
    ffmpegArgs.push("-c", "copy", tmpOut);

    await execFileAsync("ffmpeg", ffmpegArgs, { timeout: 30000 });

    if (!fs.existsSync(tmpOut)) {
      return NextResponse.json({ error: "Trim failed" }, { status: 500 });
    }

    const audioBuffer = fs.readFileSync(tmpOut);

    // Cleanup temp files
    try { fs.unlinkSync(rawFile); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpOut); } catch { /* ignore */ }

    if (body.preview) {
      // Return audio data for preview playback
      return new NextResponse(audioBuffer, {
        headers: {
          "Content-Type": "audio/mpeg",
          "Content-Length": String(audioBuffer.length),
        },
      });
    }

    // Step 3: Save as reference audio
    const filename = "voice-ref.mp3";
    fs.writeFileSync(path.join(dir, filename), audioBuffer);

    const config = sessions.readVoiceConfig(dir) || { enabled: true };
    config.referenceAudio = filename;
    sessions.writeVoiceConfig(dir, config);

    return NextResponse.json({ ok: true, filename });
  } catch (err: unknown) {
    // Cleanup on error
    try { fs.unlinkSync(tmpRaw + ".mp3"); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpOut); } catch { /* ignore */ }

    const message = err instanceof Error ? err.message : String(err);
    console.error("[youtube-voice]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
