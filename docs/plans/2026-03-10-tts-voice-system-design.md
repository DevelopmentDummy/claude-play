# TTS Voice System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add per-character text-to-speech to Claude Bridge using Qwen3-TTS 1.7B locally, with GPU queue manager to prevent VRAM conflicts with ComfyUI.

**Architecture:** Qwen3-TTS 1.7B runs as a separate Python FastAPI process. Bridge server communicates via HTTP. A GPU mutex queue ensures ComfyUI and TTS never run simultaneously. Audio files are saved to session `audio/` dir and served via existing file API.

**Tech Stack:** Python + FastAPI + Qwen3-TTS (server), TypeScript + Next.js (client), WebSocket (events)

**Note:** No test framework configured in this project. Verify each task by running `npm run build` and manual testing.

---

### Task 1: GPU Queue Manager

**Files:**
- Create: `src/lib/gpu-queue.ts`

**Step 1: Create GPU queue singleton**

```typescript
// src/lib/gpu-queue.ts

const GPU_QUEUE_KEY = "__claude_bridge_gpu_queue__";

interface QueueItem {
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  label: string;
}

class GpuQueue {
  private queue: QueueItem[] = [];
  private running = false;

  async enqueue<T>(label: string, task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        task: task as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
        label,
      });
      this.process();
    });
  }

  get pending(): number {
    return this.queue.length;
  }

  get busy(): boolean {
    return this.running;
  }

  private async process(): Promise<void> {
    if (this.running) return;
    const item = this.queue.shift();
    if (!item) return;

    this.running = true;
    console.log(`[gpu-queue] Starting: ${item.label} (${this.queue.length} queued)`);
    try {
      const result = await item.task();
      item.resolve(result);
    } catch (err) {
      item.reject(err);
    } finally {
      this.running = false;
      console.log(`[gpu-queue] Done: ${item.label}`);
      this.process();
    }
  }
}

export function getGpuQueue(): GpuQueue {
  const g = globalThis as unknown as Record<string, GpuQueue>;
  if (!g[GPU_QUEUE_KEY]) {
    g[GPU_QUEUE_KEY] = new GpuQueue();
  }
  return g[GPU_QUEUE_KEY];
}
```

**Step 2: Verify build**

Run: `npm run build`
Expected: PASS (no imports of gpu-queue yet, just needs to compile)

**Step 3: Commit**

```bash
git add src/lib/gpu-queue.ts
git commit -m "feat: add GPU mutex queue for ComfyUI/TTS time-sharing"
```

---

### Task 2: Wrap ComfyUI in GPU Queue

**Files:**
- Modify: `src/app/api/tools/comfyui/generate/route.ts` — wrap generate calls with GPU queue

**Step 1: Find where ComfyUI generate is called**

Check `src/app/api/tools/comfyui/generate/route.ts` for the generate call. Wrap the `comfyui.generate()` / `comfyui.generateRaw()` / `comfyui.faceCrop()` calls with `getGpuQueue().enqueue()`.

The ComfyUI client itself stays unchanged — the queue wrapping happens at the API route level where calls are made.

**Step 2: Add queue wrapper to ComfyUI generate route**

Add import and wrap the generate call:
```typescript
import { getGpuQueue } from "@/lib/gpu-queue";

// In the POST handler, where comfyui.generate() or comfyui.generateRaw() is called:
const result = await getGpuQueue().enqueue("comfyui:generate", () =>
  mode === "raw"
    ? comfyui.generateRaw({ prompt: rawPrompt, filename, sessionDir, extraFiles })
    : comfyui.generate({ workflow, params, filename, sessionDir, extraFiles, loras })
);
```

Also check `src/app/api/tools/gemini/generate/route.ts` — Gemini is external API, do NOT wrap it.

**Step 3: Verify build**

Run: `npm run build`
Expected: PASS

**Step 4: Commit**

```bash
git add src/app/api/tools/comfyui/generate/route.ts
git commit -m "feat: wrap ComfyUI generate calls with GPU queue"
```

---

### Task 3: TTS Python Server

**Files:**
- Create: `tools/tts-server/server.py`
- Create: `tools/tts-server/requirements.txt`
- Create: `tools/tts-server/README.md`

**Step 1: Create requirements.txt**

```
fastapi>=0.115.0
uvicorn>=0.34.0
transformers>=4.48.0
torch>=2.5.0
torchaudio>=2.5.0
soundfile>=0.13.0
```

**Step 2: Create FastAPI TTS server**

```python
# tools/tts-server/server.py
import os
import io
import tempfile
import torch
import torchaudio
import soundfile as sf
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from typing import Optional

app = FastAPI(title="Qwen3-TTS Server")

# Global model reference
model = None
processor = None

class GenerateRequest(BaseModel):
    text: str
    reference_audio: Optional[str] = None  # path to wav file for voice cloning
    design: Optional[str] = None           # text prompt for voice design
    language: Optional[str] = "ko"
    speed: Optional[float] = 1.0
    output_path: str                       # where to save the audio

@app.on_event("startup")
async def load_model():
    global model, processor
    from transformers import AutoTokenizer, AutoModelForCausalLM

    model_name = os.getenv("TTS_MODEL", "Qwen/Qwen3-TTS-1.7B")
    print(f"[tts] Loading model: {model_name}")

    processor = AutoTokenizer.from_pretrained(model_name, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        model_name,
        torch_dtype=torch.float16,
        device_map="cuda",
        trust_remote_code=True,
    )
    print("[tts] Model loaded successfully")

@app.get("/tts/health")
async def health():
    return {"status": "ok" if model is not None else "loading", "model": os.getenv("TTS_MODEL", "Qwen/Qwen3-TTS-1.7B")}

@app.post("/tts/generate")
async def generate(req: GenerateRequest):
    if model is None:
        raise HTTPException(status_code=503, detail="Model not loaded yet")

    try:
        # Build the prompt based on mode (clone vs design)
        if req.reference_audio and os.path.exists(req.reference_audio):
            # Voice cloning mode
            audio, sr = torchaudio.load(req.reference_audio)
            if sr != 24000:
                audio = torchaudio.functional.resample(audio, sr, 24000)
            # Use model's voice cloning capability
            response = model.generate(
                text=req.text,
                reference_audio=audio,
                language=req.language,
                speed=req.speed,
            )
        elif req.design:
            # Voice design mode
            response = model.generate(
                text=req.text,
                voice_design=req.design,
                language=req.language,
                speed=req.speed,
            )
        else:
            # Default voice
            response = model.generate(
                text=req.text,
                language=req.language,
                speed=req.speed,
            )

        # Save audio to output path
        os.makedirs(os.path.dirname(req.output_path), exist_ok=True)
        sf.write(req.output_path, response.cpu().numpy(), 24000)

        return {"success": True, "filepath": req.output_path}

    except Exception as e:
        print(f"[tts] Generation error: {e}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("TTS_PORT", "8800"))
    uvicorn.run(app, host="0.0.0.0", port=port)
```

**Important:** The exact Qwen3-TTS API may differ from this skeleton. After installing, check the [Qwen3-TTS GitHub](https://github.com/QwenLM/Qwen3-TTS) for the correct inference API (e.g. `pipeline`, `model.generate()`, or `model.synthesize()`). Update `server.py` accordingly. This skeleton provides the HTTP interface structure.

**Step 3: Create README**

```markdown
# TTS Server (Qwen3-TTS)

Local TTS server for Claude Bridge.

## Setup

```bash
cd tools/tts-server
pip install -r requirements.txt
python server.py
```

Server runs on port 8800 by default (env: `TTS_PORT`).

## Environment Variables

- `TTS_PORT` — Server port (default: 8800)
- `TTS_MODEL` — HuggingFace model name (default: Qwen/Qwen3-TTS-1.7B)
```

**Step 4: Commit**

```bash
git add tools/tts-server/
git commit -m "feat: add Qwen3-TTS Python FastAPI server skeleton"
```

---

### Task 4: TTS Client

**Files:**
- Create: `src/lib/tts-client.ts`

**Step 1: Create TTS HTTP client**

```typescript
// src/lib/tts-client.ts
import * as fs from "fs";
import * as path from "path";

interface TtsConfig {
  baseUrl: string; // e.g. "http://127.0.0.1:8800"
}

interface TtsGenerateRequest {
  text: string;
  referenceAudio?: string;  // absolute path to wav file
  design?: string;          // text prompt for voice design
  language?: string;
  speed?: number;
  outputPath: string;       // absolute path where to save audio
}

interface TtsResult {
  success: boolean;
  filepath?: string;
  error?: string;
}

export class TtsClient {
  private baseUrl: string;

  constructor(config: TtsConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/tts/health`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return false;
      const data = await res.json() as { status: string };
      return data.status === "ok";
    } catch {
      return false;
    }
  }

  async generate(req: TtsGenerateRequest): Promise<TtsResult> {
    try {
      // Ensure output directory exists
      fs.mkdirSync(path.dirname(req.outputPath), { recursive: true });

      const res = await fetch(`${this.baseUrl}/tts/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: req.text,
          reference_audio: req.referenceAudio || null,
          design: req.design || null,
          language: req.language || "ko",
          speed: req.speed || 1.0,
          output_path: req.outputPath,
        }),
        signal: AbortSignal.timeout(120_000), // 2 min timeout for long text
      });

      if (!res.ok) {
        const errText = await res.text();
        return { success: false, error: `TTS server error (${res.status}): ${errText}` };
      }

      const data = await res.json() as { success: boolean; filepath?: string; error?: string };
      return data;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }
}

const TTS_KEY = "__claude_bridge_tts_client__";

export function getTtsClient(): TtsClient | null {
  if (process.env.TTS_ENABLED === "false") return null;

  const g = globalThis as unknown as Record<string, TtsClient>;
  if (!g[TTS_KEY]) {
    const baseUrl = process.env.TTS_URL || "http://127.0.0.1:8800";
    g[TTS_KEY] = new TtsClient({ baseUrl });
  }
  return g[TTS_KEY];
}
```

**Step 2: Verify build**

Run: `npm run build`
Expected: PASS

**Step 3: Commit**

```bash
git add src/lib/tts-client.ts
git commit -m "feat: add TTS client for Qwen3-TTS server communication"
```

---

### Task 5: Voice Config in Session Manager

**Files:**
- Modify: `src/lib/session-manager.ts`

**Step 1: Add voice.json to SYSTEM_JSON exclusion set**

At the top of session-manager.ts, add `"voice.json"` to the `SYSTEM_JSON` set so it's not loaded as a custom data file:

```typescript
const SYSTEM_JSON = new Set([
  "variables.json", "session.json", "builder-session.json",
  "comfyui-config.json", "layout.json", "chat-history.json",
  "package.json", "tsconfig.json", "character-tags.json",
  "voice.json",  // ← add this
]);
```

**Step 2: Add voice config reader method**

Add to the `SessionManager` class:

```typescript
/** Read voice.json from a directory (persona or session) */
readVoiceConfig(dir: string): { enabled: boolean; referenceAudio?: string; design?: string; language?: string; speed?: number } | null {
  const voicePath = path.join(dir, "voice.json");
  if (!fs.existsSync(voicePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(voicePath, "utf-8"));
  } catch {
    return null;
  }
}

/** Write voice.json to a directory */
writeVoiceConfig(dir: string, config: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dir, "voice.json"), JSON.stringify(config, null, 2), "utf-8");
}
```

**Step 3: Verify build**

Run: `npm run build`
Expected: PASS

**Step 4: Commit**

```bash
git add src/lib/session-manager.ts
git commit -m "feat: add voice.json support to SessionManager"
```

---

### Task 6: Voice Config API Routes

**Files:**
- Create: `src/app/api/personas/[name]/voice/route.ts`
- Create: `src/app/api/personas/[name]/voice/upload/route.ts`

**Step 1: Create voice config GET/PUT route**

```typescript
// src/app/api/personas/[name]/voice/route.ts
import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const { sessions } = getServices();
  const dir = sessions.getPersonaDir(name);
  const config = sessions.readVoiceConfig(dir);
  return NextResponse.json(config || { enabled: false });
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const body = await req.json();
  const { sessions } = getServices();
  const dir = sessions.getPersonaDir(name);
  sessions.writeVoiceConfig(dir, body);
  return NextResponse.json({ ok: true });
}
```

**Step 2: Create voice reference audio upload route**

```typescript
// src/app/api/personas/[name]/voice/upload/route.ts
import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";
import { getServices } from "@/lib/services";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const { sessions } = getServices();
  const dir = sessions.getPersonaDir(name);

  const formData = await req.formData();
  const file = formData.get("audio") as File | null;
  if (!file) {
    return NextResponse.json({ error: "No audio file provided" }, { status: 400 });
  }

  // Validate file type
  const ext = path.extname(file.name).toLowerCase();
  if (![".wav", ".mp3", ".ogg", ".flac"].includes(ext)) {
    return NextResponse.json({ error: "Unsupported audio format" }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const filename = `voice-ref${ext}`;
  fs.writeFileSync(path.join(dir, filename), buffer);

  // Update voice.json to reference this file
  const config = sessions.readVoiceConfig(dir) || { enabled: true };
  config.referenceAudio = filename;
  sessions.writeVoiceConfig(dir, config);

  return NextResponse.json({ ok: true, filename });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const { sessions } = getServices();
  const dir = sessions.getPersonaDir(name);

  const config = sessions.readVoiceConfig(dir);
  if (config?.referenceAudio) {
    const filePath = path.join(dir, config.referenceAudio);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    config.referenceAudio = undefined;
    sessions.writeVoiceConfig(dir, config);
  }

  return NextResponse.json({ ok: true });
}
```

**Step 3: Verify build**

Run: `npm run build`
Expected: PASS

**Step 4: Commit**

```bash
git add src/app/api/personas/[name]/voice/
git commit -m "feat: add voice config and reference audio upload API routes"
```

---

### Task 7: TTS Trigger in Services

**Files:**
- Modify: `src/lib/services.ts`

This is the core integration. When an AI response completes (the `result` event handler around line 277), trigger TTS generation after saving history.

**Step 1: Add imports**

At the top of `services.ts`:
```typescript
import { getGpuQueue } from "./gpu-queue";
import { getTtsClient } from "./tts-client";
```

**Step 2: Add TTS trigger function inside `initServices()`**

Add after the `saveHistory()` function definition (~line 220), inside `initServices()`:

```typescript
/** Trigger TTS for the last assistant message (fire-and-forget) */
function triggerTts(dialogText: string): void {
  const tts = getTtsClient();
  if (!tts) return;

  const sessionId = svc.currentSessionId;
  if (!sessionId || svc.isBuilderActive) return;

  const sessionDir = sessions.getSessionDir(sessionId);
  const voiceConfig = sessions.readVoiceConfig(sessionDir);
  if (!voiceConfig?.enabled) return;

  // Find the last assistant message index for the audio:ready event
  const messageIndex = svc.chatHistory.length - 1;
  const messageId = svc.chatHistory[messageIndex]?.id;
  if (!messageId) return;

  // Resolve reference audio path
  const refAudio = voiceConfig.referenceAudio
    ? path.join(sessionDir, voiceConfig.referenceAudio)
    : undefined;
  const refExists = refAudio && fs.existsSync(refAudio);

  const timestamp = Date.now();
  const audioFilename = `tts-${timestamp}.wav`;
  const outputPath = path.join(sessionDir, "audio", audioFilename);

  // Broadcast queued status
  broadcast("audio:status", { status: "queued", messageId });

  getGpuQueue()
    .enqueue("tts:generate", () =>
      tts.generate({
        text: dialogText,
        referenceAudio: refExists ? refAudio : undefined,
        design: voiceConfig.design,
        language: voiceConfig.language,
        speed: voiceConfig.speed,
        outputPath,
      })
    )
    .then((result) => {
      if (result.success) {
        const url = `/api/sessions/${sessionId}/files?path=audio/${audioFilename}`;
        broadcast("audio:ready", { url, messageId });
      } else {
        console.error("[tts] Generation failed:", result.error);
        broadcast("audio:status", { status: "error", messageId, error: result.error });
      }
    })
    .catch((err) => {
      console.error("[tts] Queue error:", err);
      broadcast("audio:status", { status: "error", messageId });
    });
}
```

**Step 3: Call triggerTts in the result handler**

In the `msg.type === "result"` block (~line 277), after `svc.panels.reload()` (line 316), add:

```typescript
// Trigger TTS for the last assistant dialog (non-OOC only)
if (!isOOC && svc.chatHistory.length > 0) {
  const lastMsg = svc.chatHistory[svc.chatHistory.length - 1];
  if (lastMsg.role === "assistant" && lastMsg.content) {
    // Strip special tokens and choice tags for clean TTS text
    const ttsText = lastMsg.content
      .replace(/\$(?:IMAGE|PANEL):[^$]+\$/g, "")
      .replace(/<choice>[\s\S]*?<\/choice>/g, "")
      .trim();
    if (ttsText) {
      triggerTts(ttsText);
    }
  }
}
```

**Step 4: Verify build**

Run: `npm run build`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/services.ts
git commit -m "feat: trigger TTS generation on AI response completion"
```

---

### Task 8: Frontend — Auto-play Toggle in StatusBar

**Files:**
- Modify: `src/components/StatusBar.tsx`
- Modify: `src/app/chat/[sessionId]/page.tsx`

**Step 1: Add autoPlay prop and toggle button to StatusBar**

Add to `StatusBarProps`:
```typescript
autoPlay?: boolean;
onAutoPlayToggle?: () => void;
```

Add the toggle button in StatusBar's JSX, near the Sync button:
```tsx
{onAutoPlayToggle && (
  <button
    onClick={onAutoPlayToggle}
    className={`px-2 py-1 rounded-md text-xs border transition-all duration-fast ${
      autoPlay
        ? "text-accent border-accent/60 bg-accent/10"
        : "text-text-dim border-border/60 hover:border-border hover:text-text"
    }`}
    title={autoPlay ? "Auto-play voice ON" : "Auto-play voice OFF"}
  >
    {autoPlay ? "\u{1F50A}" : "\u{1F507}"}
  </button>
)}
```

**Step 2: Add autoPlay state in ChatPage**

In `src/app/chat/[sessionId]/page.tsx`, add state:
```typescript
const [autoPlay, setAutoPlay] = useState(() => {
  if (typeof window !== "undefined") {
    return localStorage.getItem("tts-autoplay") !== "false";
  }
  return true;
});

const handleAutoPlayToggle = useCallback(() => {
  setAutoPlay((prev) => {
    const next = !prev;
    localStorage.setItem("tts-autoplay", String(next));
    return next;
  });
}, []);
```

Pass to StatusBar:
```tsx
<StatusBar
  // ...existing props
  autoPlay={autoPlay}
  onAutoPlayToggle={handleAutoPlayToggle}
/>
```

**Step 3: Handle audio WebSocket events in ChatPage**

Add WebSocket event handlers for `audio:ready` and `audio:status`:
```typescript
// Track audio URLs per message
const [audioMap, setAudioMap] = useState<Record<string, string>>({});
const audioRef = useRef<HTMLAudioElement | null>(null);

// In the WebSocket message handler:
if (event === "audio:ready") {
  const { url, messageId } = data;
  setAudioMap((prev) => ({ ...prev, [messageId]: url }));
  // Auto-play if enabled
  if (autoPlay) {
    if (audioRef.current) {
      audioRef.current.pause();
    }
    const audio = new Audio(url);
    audioRef.current = audio;
    audio.play().catch(() => {});
  }
}
```

Pass `audioMap` to ChatMessages component.

**Step 4: Verify build**

Run: `npm run build`
Expected: PASS

**Step 5: Commit**

```bash
git add src/components/StatusBar.tsx src/app/chat/[sessionId]/page.tsx
git commit -m "feat: add TTS auto-play toggle and audio event handling"
```

---

### Task 9: Frontend — Per-message Speaker Button

**Files:**
- Modify: `src/components/ChatMessages.tsx`

**Step 1: Add audioMap prop and speaker button**

Add to `ChatMessagesProps`:
```typescript
audioMap?: Record<string, string>;  // messageId → audio URL
```

Add a speaker button to each assistant message bubble. Place it near the existing OOC toggle button that appears on hover:

```tsx
{/* Speaker button for messages with audio */}
{msg.role === "assistant" && audioMap?.[msg.id] && (
  <button
    onClick={() => {
      const audio = new Audio(audioMap[msg.id]);
      audio.play().catch(() => {});
    }}
    className="opacity-0 group-hover:opacity-100 transition-opacity text-text-dim hover:text-accent text-xs ml-1"
    title="Play voice"
  >
    &#x1F50A;
  </button>
)}
```

The exact placement depends on the existing message bubble JSX structure — put it adjacent to the OOC toggle that already appears on hover via `group-hover:opacity-100`.

**Step 2: Add loading/queued indicator**

Show a small pulsing indicator when TTS is generating:
```tsx
{msg.role === "assistant" && audioStatus?.[msg.id] === "generating" && (
  <span className="text-xs text-accent animate-pulse ml-1">&#x1F3A4;</span>
)}
```

Add `audioStatus?: Record<string, string>` to props, pass from ChatPage.

**Step 3: Verify build**

Run: `npm run build`
Expected: PASS

**Step 4: Commit**

```bash
git add src/components/ChatMessages.tsx
git commit -m "feat: add per-message TTS speaker button in chat"
```

---

### Task 10: Frontend — Voice Upload UI

**Files:**
- Determine the correct persona settings/overview component (check `src/app/builder/[name]/page.tsx` or home page persona list)
- Create or modify the appropriate component

**Step 1: Identify where persona settings are managed**

Check the builder page (`src/app/builder/[name]/page.tsx`) and the home page (`src/app/page.tsx`) to find where persona configuration UI lives. The voice settings should be accessible from the persona overview or a dedicated settings panel.

**Step 2: Create VoiceSettings component**

```tsx
// src/components/VoiceSettings.tsx
"use client";

import { useState, useEffect, useRef } from "react";

interface VoiceSettingsProps {
  personaName: string;
}

export default function VoiceSettings({ personaName }: VoiceSettingsProps) {
  const [config, setConfig] = useState({
    enabled: false,
    referenceAudio: "",
    design: "",
    language: "ko",
    speed: 1.0,
  });
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Load voice config
  useEffect(() => {
    fetch(`/api/personas/${encodeURIComponent(personaName)}/voice`)
      .then((r) => r.json())
      .then(setConfig)
      .catch(() => {});
  }, [personaName]);

  // Save voice config (debounced on change)
  async function saveConfig(updated: typeof config) {
    setConfig(updated);
    setSaving(true);
    await fetch(`/api/personas/${encodeURIComponent(personaName)}/voice`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updated),
    });
    setSaving(false);
  }

  // Upload reference audio
  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const form = new FormData();
    form.append("audio", file);
    const res = await fetch(
      `/api/personas/${encodeURIComponent(personaName)}/voice/upload`,
      { method: "POST", body: form }
    );
    const data = await res.json();
    if (data.ok) {
      setConfig((prev) => ({ ...prev, referenceAudio: data.filename, enabled: true }));
    }
  }

  // Delete reference audio
  async function handleDelete() {
    await fetch(
      `/api/personas/${encodeURIComponent(personaName)}/voice/upload`,
      { method: "DELETE" }
    );
    setConfig((prev) => ({ ...prev, referenceAudio: "" }));
  }

  return (
    <div className="space-y-3 p-4 rounded-lg border border-border/60 bg-surface/50">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-text">Voice Settings</h3>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => saveConfig({ ...config, enabled: e.target.checked })}
            className="accent-accent"
          />
          <span className="text-xs text-text-dim">Enable TTS</span>
        </label>
      </div>

      {/* Reference Audio */}
      <div>
        <label className="text-xs text-text-dim block mb-1">Reference Voice (3-30s audio)</label>
        {config.referenceAudio ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-text">{config.referenceAudio}</span>
            <audio
              src={`/api/personas/${encodeURIComponent(personaName)}/images?file=../${config.referenceAudio}`}
              controls
              className="h-8"
            />
            <button onClick={handleDelete} className="text-xs text-error hover:underline">
              Remove
            </button>
          </div>
        ) : (
          <div>
            <input
              ref={fileRef}
              type="file"
              accept=".wav,.mp3,.ogg,.flac"
              onChange={handleUpload}
              className="hidden"
            />
            <button
              onClick={() => fileRef.current?.click()}
              className="px-3 py-1.5 text-xs rounded border border-dashed border-border/60 text-text-dim hover:border-accent hover:text-accent transition-all"
            >
              Upload audio file
            </button>
          </div>
        )}
      </div>

      {/* Voice Design Prompt */}
      <div>
        <label className="text-xs text-text-dim block mb-1">Voice Design (text prompt)</label>
        <input
          type="text"
          value={config.design}
          onChange={(e) => setConfig({ ...config, design: e.target.value })}
          onBlur={() => saveConfig(config)}
          placeholder="e.g. 차갑고 낮은 톤의 성인 여성, 약간 허스키"
          className="w-full px-3 py-1.5 text-xs rounded border border-border/60 bg-transparent text-text outline-none focus:border-accent"
        />
        <p className="text-[10px] text-text-dim mt-1">Reference audio가 없을 때 사용됩니다</p>
      </div>

      {/* Language & Speed */}
      <div className="flex gap-3">
        <div className="flex-1">
          <label className="text-xs text-text-dim block mb-1">Language</label>
          <select
            value={config.language}
            onChange={(e) => saveConfig({ ...config, language: e.target.value })}
            className="w-full px-2 py-1 text-xs rounded border border-border/60 bg-transparent text-text outline-none"
          >
            <option value="ko">Korean</option>
            <option value="en">English</option>
            <option value="ja">Japanese</option>
            <option value="zh">Chinese</option>
          </select>
        </div>
        <div className="flex-1">
          <label className="text-xs text-text-dim block mb-1">Speed</label>
          <input
            type="number"
            min={0.5}
            max={2.0}
            step={0.1}
            value={config.speed}
            onChange={(e) => saveConfig({ ...config, speed: parseFloat(e.target.value) || 1.0 })}
            className="w-full px-2 py-1 text-xs rounded border border-border/60 bg-transparent text-text outline-none"
          />
        </div>
      </div>

      {saving && <p className="text-[10px] text-accent">Saving...</p>}
    </div>
  );
}
```

**Step 3: Integrate VoiceSettings into persona overview/home page**

Find where the persona card or overview is rendered on the home page (`src/app/page.tsx`). Add VoiceSettings as an expandable section per persona, or as a modal/dropdown accessible from the persona card.

**Step 4: Verify build**

Run: `npm run build`
Expected: PASS

**Step 5: Commit**

```bash
git add src/components/VoiceSettings.tsx src/app/page.tsx
git commit -m "feat: add voice settings UI with reference audio upload"
```

---

### Task 11: Serve Reference Audio via Existing Files API

**Files:**
- Check: `src/app/api/personas/[name]/images/route.ts`

The existing images route serves files from `personas/{name}/images/`. For voice reference files stored at the persona root level (`voice-ref.wav`), we need a way to serve them.

**Option A:** Store reference audio in `images/` subdir (reuse existing route).
**Option B:** Add audio MIME types to the persona file serving and create a simple serve route.

**Recommended:** Store `voice-ref.wav` in the persona root and add a dedicated serve endpoint, OR use the existing `/api/personas/[name]/file` route with binary support.

**Step 1: Add binary file support to voice upload route**

Add a GET handler to `src/app/api/personas/[name]/voice/upload/route.ts` to serve the reference audio:

```typescript
export async function GET(
  req: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const { sessions } = getServices();
  const dir = sessions.getPersonaDir(name);
  const config = sessions.readVoiceConfig(dir);

  if (!config?.referenceAudio) {
    return new NextResponse(null, { status: 404 });
  }

  const filePath = path.join(dir, config.referenceAudio);
  if (!fs.existsSync(filePath)) {
    return new NextResponse(null, { status: 404 });
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
  };

  const data = fs.readFileSync(filePath);
  return new NextResponse(data, {
    headers: { "Content-Type": mimeTypes[ext] || "application/octet-stream" },
  });
}
```

**Step 2: Update VoiceSettings audio preview src**

```tsx
<audio
  src={`/api/personas/${encodeURIComponent(personaName)}/voice/upload`}
  controls
  className="h-8"
/>
```

**Step 3: Verify build**

Run: `npm run build`
Expected: PASS

**Step 4: Commit**

```bash
git add src/app/api/personas/[name]/voice/upload/route.ts src/components/VoiceSettings.tsx
git commit -m "feat: serve reference audio via voice upload API"
```

---

### Task 12: Update CLAUDE.md and Environment Docs

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Add TTS-related entries**

Add to the Architecture table in CLAUDE.md:
```
| `gpu-queue.ts` | GPU mutex queue — ensures ComfyUI and TTS never run simultaneously on the same GPU. FIFO ordering. |
| `tts-client.ts` | HTTP client for Qwen3-TTS Python server. Sends text + voice config, receives audio file path. |
```

Add to Environment Variables section:
```
- `TTS_URL` — TTS server URL (default: `http://127.0.0.1:8800`)
- `TTS_ENABLED` — Enable/disable TTS globally (default: `true`)
```

Add to Key Conventions:
```
- **Voice config**: `voice.json` in persona/session dir configures per-character TTS. `referenceAudio` (clone from sample) takes priority over `design` (text prompt). Copied to session on creation.
- **GPU queue**: ComfyUI and TTS share one GPU via `gpu-queue.ts` mutex. All GPU-bound calls must go through `getGpuQueue().enqueue()`. Gemini (external API) bypasses the queue.
- **Audio files**: TTS output saved to `audio/` subdir in session. Served via existing `/api/sessions/[id]/files` route. `audio:ready` WebSocket event notifies frontend.
```

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add TTS system documentation to CLAUDE.md"
```

---

## Execution Order Summary

| Task | Description | Dependencies |
|------|-------------|-------------|
| 1 | GPU Queue Manager | None |
| 2 | Wrap ComfyUI in GPU Queue | Task 1 |
| 3 | TTS Python Server | None (independent) |
| 4 | TTS Client | None |
| 5 | Voice Config in SessionManager | None |
| 6 | Voice Config API Routes | Task 5 |
| 7 | TTS Trigger in Services | Tasks 1, 4, 5 |
| 8 | Frontend: Auto-play Toggle | None |
| 9 | Frontend: Speaker Button | Task 8 |
| 10 | Frontend: Voice Upload UI | Task 6 |
| 11 | Serve Reference Audio | Task 6, 10 |
| 12 | Documentation | All |

**Parallelizable groups:**
- Group A (backend core): Tasks 1 → 2, 4, 5 → 6, 7
- Group B (Python server): Task 3 (independent)
- Group C (frontend): Tasks 8 → 9, 10 → 11
- Final: Task 12
