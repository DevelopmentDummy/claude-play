import { NextResponse } from "next/server";
import * as path from "path";
import * as fs from "fs";
import { getServices } from "@/lib/services";
import { ComfyUIClient } from "@/lib/comfyui-client";

/**
 * POST: Generate voice .pt file or test TTS audio
 * Body: { mode: "create-voice" | "test", design?: string, language?: string }
 * - create-voice: Generate .pt from reference audio or design prompt
 * - test: Generate test audio with given text
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  console.log("[voice/generate] WARNING: App Router route handler called!");
  const { name } = await params;
  const svc = getServices();
  const personaDir = svc.sessions.getPersonaDir(name);

  if (!fs.existsSync(personaDir)) {
    return NextResponse.json({ error: "Persona not found" }, { status: 404 });
  }

  const body = (await req.json()) as {
    mode: "create-voice" | "test";
    design?: string;
    language?: string;
    text?: string;
  };

  const host = process.env.COMFYUI_HOST || "127.0.0.1";
  const port = parseInt(process.env.COMFYUI_PORT || "8188", 10);
  const client = new ComfyUIClient({ host, port }, "");

  const languageMap: Record<string, string> = {
    ko: "Korean", en: "English", ja: "Japanese", zh: "Chinese",
    de: "German", fr: "French", ru: "Russian", pt: "Portuguese",
    es: "Spanish", it: "Italian",
  };
  const lang = languageMap[body.language || "ko"] || "Korean";

  const voiceConfig = svc.sessions.readVoiceConfig(personaDir);

  if (body.mode === "create-voice") {
    // Step 1: Get or generate reference audio
    const refAudioPath = voiceConfig?.referenceAudio
      ? path.join(personaDir, voiceConfig.referenceAudio)
      : null;
    const hasRefAudio = refAudioPath && fs.existsSync(refAudioPath);

    let audioForVoiceLib: string;

    if (hasRefAudio) {
      audioForVoiceLib = refAudioPath;
    } else if (body.design) {
      // Generate sample audio via VoiceDesign first
      const samplePrompt: Record<string, unknown> = {
        "1": {
          class_type: "AILab_Qwen3TTSVoiceDesign",
          inputs: {
            text: "안녕하세요. 반갑습니다. 오늘도 좋은 하루 되세요.",
            instruct: body.design,
            model_size: "1.7B",
            language: lang,
            unload_models: true,
            seed: Math.floor(Math.random() * 2 ** 32),
          },
        },
        "2": {
          class_type: "SaveAudio",
          inputs: {
            audio: ["1", 0],
            filename_prefix: "voice_sample",
          },
        },
      };

      const samplePath = path.join(personaDir, "voice-ref-generated.flac");
      const sampleResult = await client.generateTts(samplePrompt, samplePath);
      if (!sampleResult.success) {
        return NextResponse.json(
          { error: `Failed to generate voice sample: ${sampleResult.error}` },
          { status: 500 }
        );
      }
      audioForVoiceLib = samplePath;
    } else {
      return NextResponse.json(
        { error: "Need either reference audio or design prompt" },
        { status: 400 }
      );
    }

    // Step 2: Extract voice .pt via VoicesLibrary + test VoiceClone as output node
    const voiceName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
    const testText = "안녕하세요. 반갑습니다. 오늘도 좋은 하루 되세요.";
    const extractPrompt: Record<string, unknown> = {
      "10": {
        class_type: "LoadAudio",
        inputs: { audio: audioForVoiceLib },
      },
      "1": {
        class_type: "AILab_Qwen3TTSVoicesLibrary",
        inputs: {
          reference_audio: ["10", 0],
          reference_text: voiceConfig?.referenceText || "",
          model_size: voiceConfig?.modelSize || "1.7B",
          device: "auto",
          precision: "bf16",
          x_vector_only: !(voiceConfig?.referenceText),
          voice_name: voiceName,
          save_path: path.join(personaDir, "voice"),
          unload_models: true,
        },
      },
      // VoiceClone using the extracted voice — serves as output node
      "2": {
        class_type: "AILab_Qwen3TTSVoiceClone",
        inputs: {
          target_text: testText,
          model_size: voiceConfig?.modelSize || "1.7B",
          language: lang,
          voice: ["1", 0],
          unload_models: true,
          max_new_tokens: 512,
          repetition_penalty: 1.2,
          seed: Math.floor(Math.random() * 2 ** 32),
        },
      },
      "3": {
        class_type: "SaveAudioMP3",
        inputs: {
          audio: ["2", 0],
          filename_prefix: "voice_test",
          quality: "128k",
        },
      },
    };

    const timestamp = Date.now();
    const testAudioFilename = `voice-test-${timestamp}.mp3`;
    const testOutputPath = path.join(personaDir, "audio", testAudioFilename);
    const result = await client.generateTts(extractPrompt, testOutputPath);

    if (!result.success) {
      return NextResponse.json(
        { error: `Voice generation failed: ${result.error}` },
        { status: 500 }
      );
    }

    // Check if .pt file was created
    const ptPath = path.join(personaDir, "voice", `${voiceName}.pt`);
    if (!fs.existsSync(ptPath)) {
      return NextResponse.json(
        { error: "Voice .pt file was not created" },
        { status: 500 }
      );
    }

    // Update voice.json
    const updatedConfig = svc.sessions.readVoiceConfig(personaDir) || { enabled: true };
    svc.sessions.writeVoiceConfig(personaDir, {
      ...updatedConfig,
      voiceFile: `voice/${voiceName}.pt`,
    });

    return NextResponse.json({
      ok: true,
      voiceFile: `voice/${voiceName}.pt`,
      testAudioUrl: `/api/personas/${encodeURIComponent(name)}/voice/generate?file=${testAudioFilename}`,
    });

  } else if (body.mode === "test") {
    // Test TTS: generate audio and return URL
    if (!body.text) {
      return NextResponse.json({ error: "Missing text" }, { status: 400 });
    }

    const prompt: Record<string, unknown> = {};
    let ttsNode: Record<string, unknown>;

    const voiceFile = voiceConfig?.voiceFile
      ? path.join(personaDir, voiceConfig.voiceFile)
      : null;
    const hasVoiceFile = voiceFile && fs.existsSync(voiceFile);

    const refAudio = voiceConfig?.referenceAudio
      ? path.join(personaDir, voiceConfig.referenceAudio)
      : null;
    const hasRefAudio = refAudio && fs.existsSync(refAudio);

    if (hasVoiceFile) {
      prompt["10"] = {
        class_type: "AILab_Qwen3TTSLoadVoice",
        inputs: { voice_name: "", custom_path: voiceFile },
      };
      ttsNode = {
        class_type: "AILab_Qwen3TTSVoiceClone",
        inputs: {
          target_text: body.text,
          model_size: voiceConfig?.modelSize || "1.7B",
          language: lang,
          voice: ["10", 0],
          unload_models: false,
          max_new_tokens: 512,
          repetition_penalty: 1.2,
          seed: Math.floor(Math.random() * 2 ** 32),
        },
      };
    } else if (hasRefAudio) {
      prompt["10"] = {
        class_type: "LoadAudio",
        inputs: { audio: refAudio },
      };
      ttsNode = {
        class_type: "AILab_Qwen3TTSVoiceClone",
        inputs: {
          target_text: body.text,
          model_size: voiceConfig?.modelSize || "1.7B",
          language: lang,
          reference_audio: ["10", 0],
          unload_models: false,
          max_new_tokens: 512,
          repetition_penalty: 1.2,
          seed: Math.floor(Math.random() * 2 ** 32),
        },
      };
    } else if (body.design || voiceConfig?.design) {
      ttsNode = {
        class_type: "AILab_Qwen3TTSVoiceDesign",
        inputs: {
          text: body.text,
          instruct: body.design || voiceConfig?.design || "",
          model_size: "1.7B",
          language: lang,
          unload_models: false,
          seed: Math.floor(Math.random() * 2 ** 32),
        },
      };
    } else {
      return NextResponse.json({ error: "No voice configuration" }, { status: 400 });
    }

    prompt["1"] = ttsNode;
    prompt["2"] = {
      class_type: "SaveAudioMP3",
      inputs: {
        audio: ["1", 0],
        filename_prefix: "tts_test",
        quality: "128k",
      },
    };

    const timestamp = Date.now();
    const audioFilename = `tts-test-${timestamp}.mp3`;
    const outputPath = path.join(personaDir, "audio", audioFilename);

    const result = await client.generateTts(prompt, outputPath);
    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      url: `/api/personas/${encodeURIComponent(name)}/voice/generate?file=${audioFilename}`,
    });
  }

  return NextResponse.json({ error: "Invalid mode" }, { status: 400 });
}

/** GET: Serve test audio file */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const svc = getServices();
  const personaDir = svc.sessions.getPersonaDir(name);

  const url = new URL(req.url);
  const file = url.searchParams.get("file");
  if (!file) {
    return NextResponse.json({ error: "Missing file param" }, { status: 400 });
  }

  const safeName = path.basename(file);
  const filePath = path.join(personaDir, "audio", safeName);
  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  const buffer = fs.readFileSync(filePath);
  return new NextResponse(buffer, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Content-Length": String(buffer.length),
    },
  });
}
