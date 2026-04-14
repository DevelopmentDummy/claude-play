# VoxCPM2 TTS Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GPU Manager에 VoxCPM2 TTS 엔진을 추가하여 Qwen3-TTS와 공존시킨다.

**Architecture:** 기존 `/tts/synthesize`, `/tts/create-voice` 엔드포인트에 `provider` 필드를 추가하여 Qwen3/VoxCPM 분기. VoxCPM은 레퍼런스 오디오 wav 파일을 직접 전달하는 방식 (Qwen3의 .pt embedding과 다름). 상호 배타적 VRAM 관리.

**Tech Stack:** Python (voxcpm, FastAPI), TypeScript (Next.js)

**Spec:** `docs/superpowers/specs/2026-04-14-voxcpm2-tts-integration-design.md`

**Note:** 이 프로젝트에는 테스트 프레임워크가 설정되어 있지 않음. 수동 테스트로 검증.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `gpu-manager/voxcpm_engine.py` | Create | VoxCPM2 모델 로드/추론/unload, synthesize_batch |
| `gpu-manager/requirements-voxcpm.txt` | Create | VoxCPM2 Python 의존성 |
| `gpu-manager/server.py` | Modify | provider 분기, VoxCPM availability, VRAM 상호 배타 |
| `gpu-manager/voice_creator.py` | Modify | VoxCPM provider 위임 |
| `src/lib/tts-handler.ts` | Modify | payload에 provider 필드, VoxCPM voice file 경로 |

---

### Task 1: VoxCPM2 엔진 모듈 생성

**Files:**
- Create: `gpu-manager/voxcpm_engine.py`
- Create: `gpu-manager/requirements-voxcpm.txt`

- [ ] **Step 1: requirements-voxcpm.txt 생성**

```txt
voxcpm
soundfile>=0.12.0
lameenc>=1.7.0
numpy>=1.24.0
```

- [ ] **Step 2: voxcpm_engine.py 작성 — 클래스 골격 + 모델 로드/언로드**

```python
"""VoxCPM2 TTS inference engine with on-demand model loading."""

import asyncio
import base64
import io
import logging
import time
from pathlib import Path

import numpy as np
import soundfile as sf

logger = logging.getLogger("gpu-manager.voxcpm")

IDLE_TIMEOUT = 120.0

MODEL_NAMES = {
    "2B": "openbmb/VoxCPM2",
    "0.6B": "openbmb/VoxCPM1.5",
}


class VoxCPMEngine:
    def __init__(self, model_path: str | None = None) -> None:
        self._model_path = model_path
        self._model = None
        self._loaded_size: str | None = None
        self._idle_timer: asyncio.TimerHandle | None = None
        self._lock = asyncio.Lock()

    @property
    def is_loaded(self) -> bool:
        return self._model is not None

    @property
    def loaded_size(self) -> str | None:
        return self._loaded_size

    async def load_model(self, model_size: str = "2B") -> None:
        if self._model is not None and self._loaded_size == model_size:
            self._reset_idle_timer()
            return
        if self._model is not None:
            await self.unload_model()

        logger.info("Loading VoxCPM %s...", model_size)
        t0 = time.monotonic()

        loop = asyncio.get_event_loop()
        self._model = await loop.run_in_executor(
            None, self._load_model_sync, model_size
        )
        self._loaded_size = model_size

        elapsed = time.monotonic() - t0
        logger.info("VoxCPM %s loaded in %.1fs", model_size, elapsed)
        self._reset_idle_timer()

    def _load_model_sync(self, model_size: str):
        from voxcpm import VoxCPM

        model_name = self._model_path or MODEL_NAMES.get(model_size, MODEL_NAMES["2B"])
        model = VoxCPM.from_pretrained(
            model_name,
            load_denoiser=False,
            device="cuda:0",
            optimize=False,
        )
        return model

    async def unload_model(self) -> None:
        if self._model is None:
            return
        self._cancel_idle_timer()

        logger.info("Unloading VoxCPM %s...", self._loaded_size)
        import torch
        del self._model
        self._model = None
        self._loaded_size = None
        torch.cuda.empty_cache()
        logger.info("VoxCPM unloaded, VRAM freed")

    def force_unload(self) -> None:
        if self._model is None:
            return
        if self._lock.locked():
            logger.debug("Skipping unload — synthesis in progress")
            return
        self._cancel_idle_timer()
        import torch
        logger.info("Force unloading VoxCPM model for GPU priority...")
        del self._model
        self._model = None
        self._loaded_size = None
        torch.cuda.empty_cache()

    def _reset_idle_timer(self) -> None:
        self._cancel_idle_timer()
        loop = asyncio.get_event_loop()
        self._idle_timer = loop.call_later(IDLE_TIMEOUT, self._idle_unload)

    def _cancel_idle_timer(self) -> None:
        if self._idle_timer is not None:
            self._idle_timer.cancel()
            self._idle_timer = None

    def _idle_unload(self) -> None:
        if self._model is not None:
            logger.info("Idle timeout (%.0fs) reached, unloading VoxCPM...", IDLE_TIMEOUT)
            self.force_unload()

    @staticmethod
    def _encode_mp3(audio: np.ndarray, sample_rate: int = 48000) -> bytes:
        try:
            import lameenc
            encoder = lameenc.Encoder()
            encoder.set_bit_rate(128)
            encoder.set_in_sample_rate(sample_rate)
            encoder.set_channels(1)
            encoder.set_quality(2)

            if audio.dtype in (np.float32, np.float64):
                audio = (audio * 32767).clip(-32768, 32767).astype(np.int16)

            mp3_data = encoder.encode(audio.tobytes())
            mp3_data += encoder.flush()
            return mp3_data
        except ImportError:
            logger.warning("lameenc not installed, falling back to WAV output")
            buf = io.BytesIO()
            sf.write(buf, audio, sample_rate, format="WAV")
            return buf.getvalue()
```

- [ ] **Step 3: synthesize_batch 메서드 추가**

`voxcpm_engine.py`의 `VoxCPMEngine` 클래스에 추가:

```python
    async def synthesize_batch(self, payload: dict) -> list[dict]:
        """Synthesize text chunks using VoxCPM2."""
        chunks = payload["chunks"]
        voice_file = payload["voice_file"]  # path to .wav reference audio
        model_size = payload.get("model_size", "2B")

        async with self._lock:
            self._cancel_idle_timer()
            await self.load_model(model_size)
            self._cancel_idle_timer()

            results = []
            for i, text in enumerate(chunks):
                t0 = time.monotonic()
                logger.info("VoxCPM chunk %d/%d: %s...", i + 1, len(chunks), text[:40])

                loop = asyncio.get_event_loop()
                audio_bytes = await loop.run_in_executor(
                    None,
                    self._synthesize_one,
                    text, voice_file,
                )

                elapsed = time.monotonic() - t0
                logger.info("VoxCPM chunk %d/%d done in %.1fs", i + 1, len(chunks), elapsed)

                audio_b64 = base64.b64encode(audio_bytes).decode("ascii")
                results.append({
                    "chunk_index": i,
                    "total": len(chunks),
                    "audio_base64": audio_b64,
                })

            self._reset_idle_timer()
            return results

    def _synthesize_one(self, text: str, voice_file: str) -> bytes:
        """Single text → MP3 bytes via VoxCPM2."""
        import torch

        wav = self._model.generate(
            text=text,
            reference_wav_path=voice_file,
            cfg_value=2.0,
            inference_timesteps=10,
        )

        sr = self._model.tts_model.sample_rate
        audio_np = wav if isinstance(wav, np.ndarray) else wav.cpu().numpy()
        return self._encode_mp3(audio_np.astype(np.float32), sample_rate=sr)
```

- [ ] **Step 4: voice creation 메서드 3개 추가**

`voxcpm_engine.py`의 `VoxCPMEngine` 클래스에 추가:

```python
    async def create_voice(self, payload: dict) -> dict:
        """Create voice for VoxCPM — saves reference audio as the voice file."""
        mode = payload["mode"]  # "reference", "ultimate", "design"
        output_path = payload["output_path"]
        model_size = payload.get("model_size", "2B")
        language = payload.get("language", "ko")

        async with self._lock:
            self._cancel_idle_timer()
            await self.load_model(model_size)
            self._cancel_idle_timer()

            loop = asyncio.get_event_loop()

            if mode == "reference":
                result = await loop.run_in_executor(
                    None,
                    self._create_from_reference,
                    payload["reference_audio"],
                    output_path,
                    language,
                )
            elif mode == "ultimate":
                result = await loop.run_in_executor(
                    None,
                    self._create_from_ultimate,
                    payload["reference_audio"],
                    payload.get("reference_text", ""),
                    output_path,
                    language,
                )
            elif mode == "design":
                result = await loop.run_in_executor(
                    None,
                    self._create_from_design,
                    payload["design_prompt"],
                    output_path,
                    language,
                )
            else:
                raise ValueError(f"Unknown mode: {mode}")

            self._reset_idle_timer()
            return result

    def _create_from_reference(
        self, reference_audio: str, output_path: str, language: str,
    ) -> dict:
        """Controllable cloning — copy reference audio as the voice file."""
        import shutil

        t0 = time.monotonic()
        logger.info("VoxCPM voice from reference: %s", reference_audio)

        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(reference_audio, output_path)

        sample_audio = self._generate_sample(output_path, language)

        elapsed = time.monotonic() - t0
        logger.info("VoxCPM voice created in %.1fs: %s", elapsed, output_path)

        return {
            "success": True,
            "voice_file": output_path,
            "sample_audio": base64.b64encode(sample_audio).decode("ascii"),
        }

    def _create_from_ultimate(
        self, reference_audio: str, reference_text: str,
        output_path: str, language: str,
    ) -> dict:
        """Ultimate cloning — copy reference audio + save transcript as sidecar."""
        import shutil

        t0 = time.monotonic()
        logger.info("VoxCPM ultimate voice from reference: %s", reference_audio)

        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(reference_audio, output_path)

        # Save transcript as sidecar file for ultimate mode
        transcript_path = str(Path(output_path).with_suffix(".txt"))
        Path(transcript_path).write_text(reference_text, encoding="utf-8")

        sample_audio = self._generate_sample_ultimate(
            output_path, reference_text, language,
        )

        elapsed = time.monotonic() - t0
        logger.info("VoxCPM ultimate voice created in %.1fs: %s", elapsed, output_path)

        return {
            "success": True,
            "voice_file": output_path,
            "sample_audio": base64.b64encode(sample_audio).decode("ascii"),
        }

    def _create_from_design(
        self, design_prompt: str, output_path: str, language: str,
    ) -> dict:
        """Voice Design — generate reference audio from text description."""
        t0 = time.monotonic()
        logger.info("VoxCPM voice design: %s...", design_prompt[:60])

        sample_texts = {
            "ko": "안녕하세요, 만나서 반갑습니다. 오늘 날씨가 정말 좋네요.",
            "en": "Hello, nice to meet you. The weather is really nice today.",
            "ja": "こんにちは、はじめまして。今日はいい天気ですね。",
            "zh": "你好，很高兴认识你。今天天气真好。",
        }
        sample_text = sample_texts.get(language, sample_texts["ko"])

        # Voice Design: put description in parentheses prefix
        design_text = f"({design_prompt}){sample_text}"
        wav = self._model.generate(
            text=design_text,
            cfg_value=2.0,
            inference_timesteps=10,
        )

        sr = self._model.tts_model.sample_rate
        audio_np = wav if isinstance(wav, np.ndarray) else wav.cpu().numpy()

        # Save generated audio as the reference wav for future use
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        sf.write(output_path, audio_np, sr)

        sample_audio = self._encode_mp3(audio_np.astype(np.float32), sample_rate=sr)

        elapsed = time.monotonic() - t0
        logger.info("VoxCPM voice designed in %.1fs: %s", elapsed, output_path)

        return {
            "success": True,
            "voice_file": output_path,
            "sample_audio": base64.b64encode(sample_audio).decode("ascii"),
        }

    def _generate_sample(self, voice_file: str, language: str) -> bytes:
        """Generate a short sample audio for preview (controllable mode)."""
        sample_texts = {
            "ko": "안녕하세요, 만나서 반갑습니다.",
            "en": "Hello, nice to meet you.",
            "ja": "こんにちは、はじめまして。",
            "zh": "你好，很高兴认识你。",
        }
        text = sample_texts.get(language, sample_texts["ko"])

        wav = self._model.generate(
            text=text,
            reference_wav_path=voice_file,
            cfg_value=2.0,
            inference_timesteps=10,
        )

        sr = self._model.tts_model.sample_rate
        audio_np = wav if isinstance(wav, np.ndarray) else wav.cpu().numpy()
        return self._encode_mp3(audio_np.astype(np.float32), sample_rate=sr)

    def _generate_sample_ultimate(
        self, voice_file: str, transcript: str, language: str,
    ) -> bytes:
        """Generate a short sample audio for preview (ultimate mode)."""
        sample_texts = {
            "ko": "안녕하세요, 만나서 반갑습니다.",
            "en": "Hello, nice to meet you.",
            "ja": "こんにちは、はじめまして。",
            "zh": "你好，很高兴认识你。",
        }
        text = sample_texts.get(language, sample_texts["ko"])

        wav = self._model.generate(
            text=text,
            prompt_wav_path=voice_file,
            prompt_text=transcript,
            reference_wav_path=voice_file,
            cfg_value=2.0,
            inference_timesteps=10,
        )

        sr = self._model.tts_model.sample_rate
        audio_np = wav if isinstance(wav, np.ndarray) else wav.cpu().numpy()
        return self._encode_mp3(audio_np.astype(np.float32), sample_rate=sr)
```

- [ ] **Step 5: 커밋**

```bash
git add gpu-manager/voxcpm_engine.py gpu-manager/requirements-voxcpm.txt
git commit -m "feat: VoxCPM2 TTS 엔진 모듈 추가"
```

---

### Task 2: server.py — provider 분기 + VRAM 상호 배타

**Files:**
- Modify: `gpu-manager/server.py`

- [ ] **Step 1: VoxCPM import 및 availability 체크 추가**

`server.py` 상단, 기존 Qwen3 TTS availability 체크 아래에 추가:

```python
# 기존 코드 아래에 추가
try:
    import voxcpm as _voxcpm_mod  # noqa: F401
    VOXCPM_AVAILABLE = True
except ImportError:
    VOXCPM_AVAILABLE = False
```

VoxCPMEngine import 및 인스턴스 생성 — 기존 `tts_engine` 선언 아래:

```python
from voxcpm_engine import VoxCPMEngine

# 기존 globals 영역에 추가
voxcpm_engine = VoxCPMEngine(model_path=os.environ.get("VOXCPM_MODEL_PATH"))
```

- [ ] **Step 2: TTS handler를 provider 분기로 교체**

기존 `_handle_comfyui`를 수정하여 양쪽 엔진 모두 unload:

```python
async def _handle_comfyui(payload: dict) -> dict:
    """Force-unload TTS models before ComfyUI work, then proxy."""
    tts_engine.force_unload()
    voxcpm_engine.force_unload()
    return await comfyui.generate(payload)
```

TTS handler를 provider 분기 래퍼로 교체:

```python
async def _handle_tts(payload: dict) -> list[dict]:
    """Dispatch TTS to correct engine based on provider field."""
    provider = payload.get("provider", "qwen3")
    if provider == "voxcpm":
        tts_engine.force_unload()
        return await voxcpm_engine.synthesize_batch(payload)
    else:
        voxcpm_engine.force_unload()
        return await tts_engine.synthesize_batch(payload)


async def _handle_create_voice(payload: dict) -> dict:
    """Dispatch voice creation to correct engine based on provider field."""
    provider = payload.get("provider", "qwen3")
    if provider == "voxcpm":
        tts_engine.force_unload()
        return await voxcpm_engine.create_voice(payload)
    else:
        voxcpm_engine.force_unload()
        return await voice_creator.create_voice(payload)
```

- [ ] **Step 3: lifespan에서 핸들러 등록 변경**

```python
@asynccontextmanager
async def lifespan(app):
    asyncio.create_task(queue.worker())

    queue.register_handler(TaskType.COMFYUI, _handle_comfyui)
    queue.register_handler(TaskType.TTS, _handle_tts)
    queue.register_handler(TaskType.CREATE_VOICE, _handle_create_voice)

    connected = await comfyui.check_connection()
    logger.info("ComfyUI connected: %s", connected)

    logger.info("GPU Manager ready on port %d", args.port)
    yield
    await tts_engine.unload_model()
    await voxcpm_engine.unload_model()
    await comfyui.close()
    logger.info("GPU Manager shut down")
```

- [ ] **Step 4: health endpoint에 voxcpm_available 추가**

```python
@app.get("/health")
async def health() -> dict:
    return {
        "ready": True,
        "tts_available": TTS_AVAILABLE,
        "voxcpm_available": VOXCPM_AVAILABLE,
    }
```

- [ ] **Step 5: status endpoint에 voxcpm 상태 추가**

```python
@app.get("/status")
async def status() -> dict:
    q = queue.status()
    connected = await comfyui.check_connection()
    return {
        "queue_size": q.queue_size,
        "current_task": q.current_task,
        "qwen3_loaded": tts_engine.is_loaded,
        "qwen3_size": tts_engine.loaded_size,
        "voxcpm_loaded": voxcpm_engine.is_loaded,
        "voxcpm_size": voxcpm_engine.loaded_size,
        "comfyui_connected": connected,
    }
```

- [ ] **Step 6: TTS synthesize endpoint — 503 분기 수정**

```python
@app.post("/tts/synthesize")
async def tts_synthesize(request: Request) -> StreamingResponse:
    body = await request.json()
    provider = body.get("provider", "qwen3")

    if provider == "voxcpm" and not VOXCPM_AVAILABLE:
        return JSONResponse(
            status_code=503,
            content={"error": "VoxCPM not installed. Install with: pip install -r requirements-voxcpm.txt"},
        )
    if provider != "voxcpm" and not TTS_AVAILABLE:
        return JSONResponse(
            status_code=503,
            content={"error": "Local TTS not installed. Install with: pip install -r requirements-tts.txt"},
        )

    task = Task(type=TaskType.TTS, payload=body)
    try:
        results = await queue.submit(task)

        async def stream():
            for item in results:
                yield json.dumps(item, ensure_ascii=False) + "\n"

        return StreamingResponse(stream(), media_type="application/x-ndjson")
    except TimeoutError as e:
        return JSONResponse({"error": str(e)}, status_code=408)
    except Exception as e:
        logger.error("TTS synthesize error: %s", e)
        return JSONResponse({"error": str(e)}, status_code=500)
```

- [ ] **Step 7: Voice creation endpoint — provider 분기 수정**

```python
@app.post("/tts/create-voice")
async def tts_create_voice(request: Request) -> JSONResponse:
    body = await request.json()
    provider = body.get("provider", "qwen3")

    if provider == "voxcpm" and not VOXCPM_AVAILABLE:
        return JSONResponse(
            status_code=503,
            content={"error": "VoxCPM not installed. Install with: pip install -r requirements-voxcpm.txt"},
        )
    if provider != "voxcpm" and not TTS_AVAILABLE:
        return JSONResponse(
            status_code=503,
            content={"error": "Local TTS not installed. Install with: pip install -r requirements-tts.txt"},
        )

    task = Task(type=TaskType.CREATE_VOICE, payload=body)
    try:
        result = await queue.submit(task)
        return JSONResponse(result)
    except TimeoutError as e:
        return JSONResponse({"error": str(e)}, status_code=408)
    except Exception as e:
        logger.error("Voice creation error: %s", e)
        return JSONResponse({"error": str(e)}, status_code=500)
```

- [ ] **Step 8: 커밋**

```bash
git add gpu-manager/server.py
git commit -m "feat: GPU Manager server에 VoxCPM2 provider 분기 추가"
```

---

### Task 3: tts-handler.ts — provider 필드 전달

**Files:**
- Modify: `src/lib/tts-handler.ts`

- [ ] **Step 1: synthesizeViaGpuManager에 provider 파라미터 추가**

함수 시그니처 변경:

```typescript
async function synthesizeViaGpuManager(
  chunks: string[],
  voiceFile: string,
  language: string,
  modelSize: string,
  provider: string,
): Promise<Array<{ chunkIndex: number; audioBuffer: Buffer }>> {
  const res = await fetch(`${GPU_MANAGER_URL}/tts/synthesize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chunks,
      voice_file: voiceFile,
      language,
      model_size: modelSize,
      provider,
    }),
  });
  // ... rest unchanged
```

- [ ] **Step 2: handleChatTts — VoxCPM provider 분기**

`isLocalTts` 판별에 `"voxcpm"` 추가:

```typescript
const provider = voiceConfig.ttsProvider || "comfyui";
const isLocalTts = provider === "local" || provider === "comfyui" || provider === "voxcpm";
```

synthesizeViaGpuManager 호출부에 provider 전달:

```typescript
const gpuProvider = provider === "voxcpm" ? "voxcpm" : "qwen3";
// ...
const results = await synthesizeViaGpuManager(batch, voiceFile, lang, modelSize, gpuProvider);
```

- [ ] **Step 3: handleVoiceGeneratePost — VoxCPM 보이스 생성 분기**

`isLocalProvider` 판별에 `"voxcpm"` 추가:

```typescript
const isLocalProvider = voiceProvider === "local" || voiceProvider === "comfyui" || voiceProvider === "voxcpm";
```

`create-voice` 모드의 payload에 provider 추가:

```typescript
const gpuProvider = voiceProvider === "voxcpm" ? "voxcpm" : "qwen3";

const payload: Record<string, unknown> = {
  output_path: outputPath,
  model_size: voiceConfig?.modelSize || (gpuProvider === "voxcpm" ? "2B" : "1.7B"),
  language: voiceConfig?.language || "ko",
  provider: gpuProvider,
};
```

VoxCPM voice file 확장자를 `.wav`로:

```typescript
const voiceExt = gpuProvider === "voxcpm" ? "wav" : "pt";
const voiceName = personaName.replace(/[^a-zA-Z0-9_-]/g, "_");
const outputPath = path.join(personaDir, "voice", `${voiceName}.voxcpm.${voiceExt}`);
```

`test` 모드의 synthesizeViaGpuManager 호출에도 provider 추가:

```typescript
const results = await synthesizeViaGpuManager(
  [body.text as string],
  voiceFile,
  voiceConfig?.language || "ko",
  voiceConfig?.modelSize || (gpuProvider === "voxcpm" ? "2B" : "1.7B"),
  gpuProvider,
);
```

- [ ] **Step 4: 커밋**

```bash
git add src/lib/tts-handler.ts
git commit -m "feat: tts-handler에 VoxCPM2 provider 지원 추가"
```

---

### Task 4: 수동 테스트 및 최종 커밋

- [ ] **Step 1: VoxCPM 패키지 설치**

```bash
cd gpu-manager
pip install -r requirements-voxcpm.txt
```

- [ ] **Step 2: GPU Manager 시작 후 health 확인**

```bash
python server.py
# 다른 터미널에서:
curl http://127.0.0.1:3342/health
# 기대: {"ready":true,"tts_available":...,"voxcpm_available":true}
```

- [ ] **Step 3: VoxCPM voice design 테스트**

```bash
curl -X POST http://127.0.0.1:3342/tts/create-voice \
  -H "Content-Type: application/json" \
  -d '{"mode":"design","design_prompt":"A young woman, gentle and sweet voice","output_path":"/tmp/test_voice.wav","language":"ko","provider":"voxcpm"}'
```

- [ ] **Step 4: VoxCPM synthesize 테스트**

```bash
curl -X POST http://127.0.0.1:3342/tts/synthesize \
  -H "Content-Type: application/json" \
  -d '{"chunks":["안녕하세요, 테스트입니다."],"voice_file":"/tmp/test_voice.wav","language":"ko","provider":"voxcpm"}'
```

- [ ] **Step 5: TypeScript 빌드 체크**

```bash
npm run build
```

- [ ] **Step 6: 최종 커밋 (필요 시)**

```bash
git add -A
git commit -m "fix: VoxCPM2 통합 최종 수정"
```
