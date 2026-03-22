import * as fs from "fs";
import * as path from "path";

interface OpenAIImageConfig {
  apiKey: string;
  model?: string;
}

interface GenerateRequest {
  prompt: string;
  filename: string;
  sessionDir: string;
  size?: string;
  quality?: string;
}

interface GenerateResult {
  success: boolean;
  filepath?: string;
  error?: string;
}

export class OpenAIImageClient {
  private apiKey: string;
  private model: string;

  constructor(config: OpenAIImageConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model || "gpt-image-1.5";
  }

  /** Sanitize a relative file path: preserve subdirectories but prevent traversal */
  private safePath(filePath: string): string {
    const normalized = path.posix.normalize(filePath.replace(/\\/g, "/"));
    const segments = normalized.split("/").filter(s => s && s !== ".." && s !== ".");
    return segments.join("/") || path.basename(filePath);
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    try {
      const res = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          prompt: req.prompt,
          n: 1,
          response_format: "b64_json",
          ...(req.size ? { size: req.size } : {}),
          ...(req.quality ? { quality: req.quality } : {}),
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        return { success: false, error: `OpenAI API error (${res.status}): ${errText}` };
      }

      const data = await res.json() as {
        data?: Array<{ b64_json?: string }>;
      };

      const b64 = data?.data?.[0]?.b64_json;
      if (!b64) {
        return { success: false, error: "No image data in OpenAI response" };
      }

      const imageBuffer = Buffer.from(b64, "base64");
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
