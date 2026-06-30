import * as fs from "fs";
import * as path from "path";
import { refImageMime, writeSessionImage } from "./image-fs";

interface OpenAIImageConfig {
  apiKey: string;
  /** Responses API orchestration model (e.g. gpt-5.5). The image is rendered by
   *  the built-in `image_generation` tool's GPT Image model, selected automatically. */
  model?: string;
}

interface GenerateRequest {
  prompt: string;
  filename: string;
  sessionDir: string;
  referenceImage?: string;
  size?: string;
  quality?: string;
}

interface GenerateResult {
  success: boolean;
  filepath?: string;
  error?: string;
}

/** Map a filename extension to an image_generation `output_format` value. */
function outputFormatFor(filename: string): "png" | "jpeg" | "webp" {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "jpeg";
  if (ext === ".webp") return "webp";
  return "png";
}

export class OpenAIImageClient {
  private apiKey: string;
  private model: string;

  constructor(config: OpenAIImageConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model || "gpt-5.5";
  }

  /** Resolve and validate reference image, return file buffer or null */
  private resolveReferenceImage(sessionDir: string, refPath: string): { buffer: Buffer; mimeType: string } | null {
    const resolved = path.resolve(sessionDir, refPath);
    if (!resolved.startsWith(sessionDir) || !fs.existsSync(resolved)) return null;
    return { buffer: fs.readFileSync(resolved), mimeType: refImageMime(resolved) };
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    try {
      const refImage = req.referenceImage
        ? this.resolveReferenceImage(req.sessionDir, req.referenceImage)
        : null;

      if (req.referenceImage && !refImage) {
        return { success: false, error: `Reference image not found or outside session: ${req.referenceImage}` };
      }

      // Two distinct model slots, often confused:
      //  (1) orchestration model — the Responses reasoning model that drives the
      //      tool. MUST be a Responses-capable model (e.g. gpt-5.5), NOT an image
      //      model. (2) renderer model — the image model the image_generation tool
      //      actually uses (gpt-image-1 / gpt-image-2).
      // If OPENAI_IMAGE_MODEL was mistakenly set to a `gpt-image-*` id, treat it as
      // the renderer and fall back to gpt-5.5 for orchestration, so a misconfig
      // self-corrects instead of 400-ing the whole /v1/responses call.
      const isImageModel = this.model.startsWith("gpt-image");
      const orchestrationModel = isImageModel ? "gpt-5.5" : this.model;
      const toolModel =
        process.env.OPENAI_IMAGE_TOOL_MODEL ||
        (isImageModel ? this.model : "gpt-image-2");

      // image_generation tool config — only emit non-default fields.
      // Pin the renderer model: the Responses image_generation tool otherwise
      // auto-selects `gpt-image-1.5` for the action=edit + quality=high combo,
      // which 400s ("model_not_found") on accounts without 1.5 access. Pinning
      // to gpt-image-1 (env-overridable) keeps high-quality edits working.
      const tool: Record<string, unknown> = {
        type: "image_generation",
        model: toolModel,
        output_format: outputFormatFor(req.filename),
      };
      if (req.size) tool.size = req.size;
      if (req.quality) tool.quality = req.quality;
      if (refImage) tool.action = "edit";

      // Build the Responses `input`. Text-only generation passes the prompt as a
      // plain string; editing passes a content list carrying the reference image
      // as a base64 data URL alongside the instruction text.
      const input: unknown = refImage
        ? [{
            role: "user",
            content: [
              { type: "input_text", text: req.prompt },
              {
                type: "input_image",
                image_url: `data:${refImage.mimeType};base64,${refImage.buffer.toString("base64")}`,
              },
            ],
          }]
        : req.prompt;

      const instructions = refImage
        ? "You are an image editing service. Use the image_generation tool to edit the provided reference image according to the instructions. Always produce an image; do not reply with text only."
        : "You are an image generation service. Use the image_generation tool to render the described image. Always produce an image; do not reply with text only.";

      const res = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: orchestrationModel,
          instructions,
          input,
          tools: [tool],
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        return { success: false, error: `OpenAI API error (${res.status}): ${errText}` };
      }

      const data = await res.json() as {
        output?: Array<{ type?: string; result?: string }>;
        error?: { message?: string } | null;
      };

      if (data?.error?.message) {
        return { success: false, error: `OpenAI error: ${data.error.message}` };
      }

      // Image bytes come back on the image_generation_call output item's `result`.
      const b64 = data?.output?.find((o) => o.type === "image_generation_call" && o.result)?.result;
      if (!b64) {
        return { success: false, error: "No image_generation_call in OpenAI response (model may have replied with text only)" };
      }

      const imageBuffer = Buffer.from(b64, "base64");
      const filepath = writeSessionImage(req.sessionDir, req.filename, imageBuffer);
      return { success: true, filepath };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }
}
