# ComfyUI TTS Integration Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the separate TTS Python server with ComfyUI-based TTS, eliminating gpu-queue and tts-client.

**Architecture:** TTS generation goes through ComfyUI's API (same as image generation). The `comfyui-client.ts` is extended to handle audio outputs. The `triggerTts()` function in services.ts builds a raw ComfyUI workflow and submits it via the client.

**Tech Stack:** ComfyUI + AILab_Qwen3TTS custom nodes, existing comfyui-client.ts

---

### Task 1: Extend comfyui-client.ts to support audio outputs

**Files:**
- Modify: `src/lib/comfyui-client.ts`

**Step 1:** Add `extractAudioFilenames()` method mirroring `extractOutputFilenames()` but reading `audio` key instead of `images`:

```typescript
private extractAudioFilenames(
  historyEntry: Record<string, unknown>
): Array<{ filename: string; prefix: string }> {
  const outputs = historyEntry.outputs as Record<string, Record<string, unknown>> | undefined;
  if (!outputs) return [];
  const results: Array<{ filename: string; prefix: string }> = [];
  for (const nodeOutput of Object.values(outputs)) {
    const audios = nodeOutput.audio as Array<{ filename: string; subfolder?: string; type?: string }> | undefined;
    if (audios && audios.length > 0) {
      for (const a of audios) {
        const prefix = a.filename.replace(/_\d+_?\.\w+$/, "");
        results.push({ filename: a.filename, prefix });
      }
    }
  }
  return results;
}
```

**Step 2:** Add public `generateTts()` method that submits raw workflow JSON, polls history, downloads the audio file, and saves it to a specified output path:

```typescript
async generateTts(
  prompt: Record<string, unknown>,
  outputPath: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    await this.reconcileQueueBeforeSubmit();
    const queueRes = await this.fetchWithRetry(`${this.baseUrl}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    }, { attempts: 5, timeoutMs: 30_000, baseDelayMs: 300 });

    if (!queueRes.ok) {
      return { success: false, error: `ComfyUI queue failed: ${await queueRes.text()}` };
    }
    const { prompt_id } = await queueRes.json() as { prompt_id: string };
    const history = await this.pollHistory(prompt_id);
    if (!history) {
      await this.cancelPrompt(prompt_id);
      return { success: false, error: "Timeout waiting for TTS generation" };
    }
    const audioFiles = this.extractAudioFilenames(history);
    if (audioFiles.length === 0) {
      return { success: false, error: "No audio output in ComfyUI result" };
    }
    const buffer = await this.downloadImage(audioFiles[0].filename);
    if (!buffer) {
      return { success: false, error: "Failed to download audio from ComfyUI" };
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, buffer);
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
```

### Task 2: Rewrite triggerTts() in services.ts to use ComfyUI

**Files:**
- Modify: `src/lib/services.ts`

**Step 1:** Remove imports of `getGpuQueue` and `getTtsClient`. Add import of `ComfyUIClient`.

**Step 2:** Rewrite `triggerTts()` to build a ComfyUI workflow based on voice.json config:
- `referenceAudio` exists → AILab_Qwen3TTSVoiceClone
- `design` exists → AILab_Qwen3TTSVoiceDesign
- neither → AILab_Qwen3TTSCustomVoice (default speaker)

Submit via `comfyUIClient.generateTts()`, then broadcast `audio:ready` on success.

### Task 3: Remove gpu-queue from comfyui generate route

**Files:**
- Modify: `src/app/api/tools/comfyui/generate/route.ts`

Remove `getGpuQueue` import and wrapping. Call `client.generate()` / `client.generateRaw()` directly (ComfyUI has its own queue).

### Task 4: Delete obsolete files

**Files:**
- Delete: `src/lib/tts-client.ts`
- Delete: `src/lib/gpu-queue.ts`
- Delete: `tools/tts-server/` (entire directory)

### Task 5: Update start.bat

**Files:**
- Modify: `start.bat`

Remove TTS server startup lines.

### Task 6: Verify build

Run `npm run build` to confirm no broken imports or type errors.
