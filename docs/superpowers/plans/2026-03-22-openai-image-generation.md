# OpenAI Image Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add GPT image generation (gpt-image-1.5) as a third image provider alongside ComfyUI and Gemini.

**Architecture:** Mirror the existing Gemini image generation pattern — client library, API route, MCP tool. Uses OpenAI Images API (`POST /v1/images/generations`) with base64 response format.

**Tech Stack:** OpenAI REST API (no SDK dependency), existing Next.js API routes, MCP server.

---

### Task 1: Create OpenAI Image Client

**Files:**
- Create: `src/lib/openai-image.ts`

- [ ] **Step 1: Create `OpenAIImageClient` class**

```typescript
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

      const data = await res.json();
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
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/openai-image.ts
git commit -m "feat: add OpenAI image generation client"
```

---

### Task 2: Create API Route

**Files:**
- Create: `src/app/api/tools/openai/generate/route.ts`

- [ ] **Step 1: Create route handler** (mirrors `api/tools/gemini/generate/route.ts`)

```typescript
import { NextResponse } from "next/server";
import { getSessionManager } from "@/lib/services";
import { OpenAIImageClient } from "@/lib/openai-image";

export async function POST(req: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "OPENAI_API_KEY not configured" }, { status: 500 });
  }

  const sm = getSessionManager();
  const body = await req.json();

  if (!body.prompt) {
    return NextResponse.json({ error: "Missing prompt" }, { status: 400 });
  }

  const filename = body.filename || `openai_${Date.now()}.png`;

  let targetDir: string;
  if (body.persona) {
    if (!sm.personaExists(body.persona)) {
      return NextResponse.json({ error: `Persona "${body.persona}" not found` }, { status: 404 });
    }
    targetDir = sm.getPersonaDir(body.persona);
  } else if (body.sessionId) {
    targetDir = sm.getSessionDir(body.sessionId);
  } else {
    return NextResponse.json({ error: "No sessionId and no persona specified" }, { status: 400 });
  }

  const model = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1.5";
  const client = new OpenAIImageClient({ apiKey, model });
  const resultPath = `images/${filename}`;

  client.generate({
    prompt: body.prompt,
    filename,
    sessionDir: targetDir,
    size: body.size,
    quality: body.quality,
  }).then((result) => {
    if (result.success) console.log(`[openai] Generated: ${result.filepath}`);
    else console.error(`[openai] Generation failed: ${result.error}`);
  }).catch((err) => {
    console.error(`[openai] Unexpected error:`, err);
  });

  return NextResponse.json({ status: "queued", path: resultPath });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/tools/openai/generate/route.ts
git commit -m "feat: add OpenAI image generation API route"
```

---

### Task 3: Register MCP Tool

**Files:**
- Modify: `src/mcp/claude-play-mcp-server.mjs` (after `generate_image_gemini` tool, ~line 678)

- [ ] **Step 1: Add `generate_image_openai` tool registration**

```javascript
server.registerTool(
  "generate_image_openai",
  {
    description: "Generate an image using OpenAI GPT image model (gpt-image-1.5).",
    inputSchema: {
      prompt: z.string().min(1),
      filename: z.string().optional(),
      persona: z.string().optional(),
      size: z.string().optional().describe("Image size: 1024x1024, 1536x1024, 1024x1536, auto (default: auto)"),
      quality: z.string().optional().describe("Quality: low, medium, high (default: auto)"),
    },
  },
  async (input) => {
    try {
      const payload = withPersona({
        prompt: input.prompt,
        filename: pickString(input.filename) || `openai_${Date.now()}.png`,
        ...(input.persona ? { persona: input.persona } : {}),
        size: pickString(input.size),
        quality: pickString(input.quality),
      });
      const data = await requestJson("POST", "/api/tools/openai/generate", payload);
      const imagePath =
        data && typeof data === "object" && data.path && typeof data.path === "string"
          ? data.path
          : null;
      return ok({
        ...data,
        output_token: imagePath ? `$IMAGE:${imagePath}$` : null,
      });
    } catch (error) {
      return fail(error);
    }
  }
);
```

- [ ] **Step 2: Commit**

```bash
git add src/mcp/claude-play-mcp-server.mjs
git commit -m "feat: register generate_image_openai MCP tool"
```

---

### Task 4: Document Environment Variables

**Files:**
- Modify: `CLAUDE.md` (Environment Variables section)

- [ ] **Step 1: Add `OPENAI_API_KEY` and `OPENAI_IMAGE_MODEL` to env vars list**

- [ ] **Step 2: Add `/api/tools/openai/generate` to API routes table**

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add OpenAI image generation env vars and API route"
```
