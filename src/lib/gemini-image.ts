import * as fs from "fs";
import * as path from "path";
import { refImageMime, writeSessionImage } from "./image-fs";

interface GeminiImageConfig {
  apiKey: string;
  model?: string;
}

interface GenerateRequest {
  prompt: string;
  filename: string;
  sessionDir: string;
  referenceImage?: string | string[];
  aspectRatio?: string;
  imageSize?: string;
}

interface GenerateResult {
  success: boolean;
  filepath?: string;
  error?: string;
}

export class GeminiImageClient {
  private apiKey: string;
  private model: string;

  constructor(config: GeminiImageConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model || "gemini-3.1-flash-image-preview";
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

      const inputParts: Array<Record<string, unknown>> = [{ text: req.prompt }];

      const refImages = req.referenceImage
        ? Array.isArray(req.referenceImage) ? req.referenceImage : [req.referenceImage]
        : [];

      for (const ref of refImages) {
        const refPath = path.resolve(req.sessionDir, ref);
        if (refPath.startsWith(req.sessionDir) && fs.existsSync(refPath)) {
          const base64 = fs.readFileSync(refPath).toString("base64");
          inputParts.push({ inlineData: { mimeType: refImageMime(refPath), data: base64 } });
        }
      }

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: inputParts }],
          generationConfig: {
            responseModalities: ["IMAGE"],
            ...(req.aspectRatio || req.imageSize ? {
              imageConfig: {
                ...(req.aspectRatio ? { aspectRatio: req.aspectRatio } : {}),
                ...(req.imageSize ? { imageSize: req.imageSize } : {}),
              },
            } : {}),
          },
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        return { success: false, error: `Gemini API error (${res.status}): ${errText}` };
      }

      const data = await res.json() as {
        candidates?: Array<{
          content?: {
            parts?: Array<{
              inlineData?: { mimeType?: string; data?: string };
              text?: string;
            }>;
          };
        }>;
      };

      // Find the image part in the response
      const parts = data.candidates?.[0]?.content?.parts;
      if (!parts) {
        return { success: false, error: "No content in Gemini response" };
      }

      const imagePart = parts.find((p) => p.inlineData?.data);
      if (!imagePart?.inlineData?.data) {
        return { success: false, error: "No image data in Gemini response" };
      }

      const imageBuffer = Buffer.from(imagePart.inlineData.data, "base64");
      const filepath = writeSessionImage(req.sessionDir, req.filename, imageBuffer);
      return { success: true, filepath };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }
}
