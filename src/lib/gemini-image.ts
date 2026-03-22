import * as fs from "fs";
import * as path from "path";

interface GeminiImageConfig {
  apiKey: string;
  model?: string;
}

interface GenerateRequest {
  prompt: string;
  filename: string;
  sessionDir: string;
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

  /** Sanitize a relative file path: preserve subdirectories but prevent traversal */
  private safePath(filePath: string): string {
    const normalized = path.posix.normalize(filePath.replace(/\\/g, "/"));
    const segments = normalized.split("/").filter(s => s && s !== ".." && s !== ".");
    return segments.join("/") || path.basename(filePath);
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: req.prompt }] }],
          generationConfig: {
            responseModalities: ["IMAGE"],
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
      const imagesDir = path.join(req.sessionDir, "images");
      fs.mkdirSync(imagesDir, { recursive: true });

      const safeName = this.safePath(req.filename);
      const filepath = path.join(imagesDir, safeName);
      fs.mkdirSync(path.dirname(filepath), { recursive: true });
      fs.writeFileSync(filepath, imageBuffer);

      return { success: true, filepath: `images/${safeName}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }
}
