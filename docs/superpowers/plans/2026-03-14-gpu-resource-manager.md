# GPU Resource Manager Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bridge에 내장된 Python child process로 GPU 리소스를 관리하는 서버를 구현하여, ComfyUI 이미지 생성과 Qwen3-TTS 직접 추론을 단일 직렬 큐로 통합한다.

**Architecture:** Python FastAPI 서버가 Bridge의 child process로 spawn된다. 직렬 asyncio 큐가 모든 GPU 작업을 순차 처리한다. 이미지 생성은 ComfyUI에 프록시하고, TTS는 Qwen3-TTS를 직접 로딩하여 추론한다.

**Tech Stack:** Python 3.10+, FastAPI, uvicorn, PyTorch, transformers (Qwen3-TTS), httpx, soundfile, lameenc

**Spec:** `docs/superpowers/specs/2026-03-14-gpu-resource-manager-design.md`

---

## File Structure

### New Files (Python — `gpu-manager/`)

| File | Responsibility |
|------|---------------|
| `gpu-manager/server.py` | FastAPI 앱, CLI args, uvicorn 실행, 큐 worker 시작 |
| `gpu-manager/queue_manager.py` | 직렬 asyncio 큐, Task dataclass, submit/worker 로직 |
| `gpu-manager/comfyui_proxy.py` | ComfyUI HTTP 프록시 (prompt 제출, history 폴링, 파일명 추출) |
| `gpu-manager/tts_engine.py` | Qwen3-TTS 모델 로딩/언로딩, 추론, MP3 인코딩, idle timeout |
| `gpu-manager/voice_creator.py` | `.pt` 음성 임베딩 생성 (design prompt / reference audio) |
| `gpu-manager/requirements.txt` | Python 의존성 |

### Modified Files (TypeScript — Bridge)

| File | Changes |
|------|---------|
| `server.ts` | GPU Manager spawn/kill/restart 로직 추가 |
| `src/lib/tts-handler.ts` | ComfyUI TTS 경로 → GPU Manager 호출로 교체 |
| `src/lib/comfyui-client.ts` | `generate()` → GPU Manager 프록시 경유, 큐 관리 로직 제거 |

---

## Chunk 1: Python 서버 기반 + 직렬 큐 + ComfyUI 프록시

### Task 1: Python 프로젝트 초기화 + requirements.txt

**Files:**
- Create: `gpu-manager/requirements.txt`

- [ ] **Step 1: Create requirements.txt**

```
fastapi>=0.115.0
uvicorn>=0.30.0
httpx>=0.27.0
torch>=2.0.0
transformers>=4.40.0
soundfile>=0.12.0
lameenc>=1.7.0
numpy>=1.24.0
```

- [ ] **Step 2: Commit**

```bash
git add gpu-manager/requirements.txt
git commit -m "feat: add gpu-manager Python dependencies"
```

---

### Task 2: 직렬 큐 매니저

**Files:**
- Create: `gpu-manager/queue_manager.py`

- [ ] **Step 1: Implement QueueManager**

```python
"""Serial GPU task queue — one task at a time."""

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Callable, Awaitable

logger = logging.getLogger("gpu-manager.queue")


class TaskType(str, Enum):
    COMFYUI = "comfyui"
    TTS = "tts"
    CREATE_VOICE = "create_voice"


TASK_TIMEOUTS: dict[TaskType, float] = {
    TaskType.COMFYUI: 600.0,      # 10 minutes
    TaskType.TTS: 120.0,          # 2 minutes
    TaskType.CREATE_VOICE: 300.0, # 5 minutes
}


@dataclass
class Task:
    type: TaskType
    payload: dict
    submitted_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


@dataclass
class QueueStatus:
    queue_size: int
    current_task: dict | None


class QueueManager:
    def __init__(self) -> None:
        self._queue: asyncio.Queue[tuple[Task, asyncio.Future]] = asyncio.Queue()
        self._current_task: Task | None = None
        self._handlers: dict[TaskType, Callable[[dict], Awaitable[Any]]] = {}

    def register_handler(
        self, task_type: TaskType, handler: Callable[[dict], Awaitable[Any]]
    ) -> None:
        self._handlers[task_type] = handler

    async def submit(self, task: Task) -> Any:
        """Submit a task and wait for completion."""
        future: asyncio.Future[Any] = asyncio.get_event_loop().create_future()
        await self._queue.put((task, future))
        return await future

    async def worker(self) -> None:
        """Process tasks one at a time, forever."""
        logger.info("Queue worker started")
        while True:
            task, future = await self._queue.get()
            self._current_task = task
            handler = self._handlers.get(task.type)
            if not handler:
                future.set_exception(ValueError(f"No handler for {task.type}"))
                self._current_task = None
                continue

            timeout = TASK_TIMEOUTS.get(task.type, 120.0)
            try:
                result = await asyncio.wait_for(handler(task.payload), timeout=timeout)
                future.set_result(result)
            except asyncio.TimeoutError:
                logger.error("Task %s timed out after %.0fs", task.type, timeout)
                future.set_exception(TimeoutError(f"Task timed out after {timeout}s"))
            except Exception as e:
                logger.error("Task %s failed: %s", task.type, e)
                future.set_exception(e)
            finally:
                self._current_task = None
                self._queue.task_done()

    def status(self) -> QueueStatus:
        current = None
        if self._current_task:
            current = {
                "type": self._current_task.type.value,
                "started_at": self._current_task.submitted_at.isoformat(),
            }
        return QueueStatus(queue_size=self._queue.qsize(), current_task=current)
```

- [ ] **Step 2: Commit**

```bash
git add gpu-manager/queue_manager.py
git commit -m "feat: add serial GPU queue manager"
```

---

### Task 3: ComfyUI 프록시

**Files:**
- Create: `gpu-manager/comfyui_proxy.py`

- [ ] **Step 1: Implement ComfyUIProxy**

```python
"""ComfyUI HTTP API proxy — submit prompts, poll history, extract filenames."""

import asyncio
import logging
import time

import httpx

logger = logging.getLogger("gpu-manager.comfyui")

# Timeout for individual HTTP requests to ComfyUI
REQUEST_TIMEOUT = 30.0


class ComfyUIProxy:
    def __init__(self, comfyui_url: str) -> None:
        self.comfyui_url = comfyui_url.rstrip("/")
        self._client = httpx.AsyncClient(timeout=REQUEST_TIMEOUT)

    async def check_connection(self) -> bool:
        """Check if ComfyUI is reachable."""
        try:
            resp = await self._client.get(f"{self.comfyui_url}/system_stats")
            return resp.status_code == 200
        except httpx.HTTPError:
            return False

    async def generate(self, payload: dict) -> dict:
        """Submit prompt to ComfyUI, poll until complete, return filenames."""
        prompt = payload["prompt"]
        timeout_ms = payload.get("timeout", 600_000)

        # Submit prompt
        resp = await self._client.post(
            f"{self.comfyui_url}/prompt",
            json={"prompt": prompt},
        )
        resp.raise_for_status()
        prompt_id = resp.json()["prompt_id"]
        logger.info("Submitted prompt %s to ComfyUI", prompt_id)

        # Poll history
        history = await self._poll_history(prompt_id, timeout_ms / 1000)

        # Extract filenames
        filenames = self._extract_filenames(history)
        logger.info("Prompt %s complete: %s", prompt_id, filenames)

        return {
            "prompt_id": prompt_id,
            "filenames": filenames,
            "history": history,
        }

    async def _poll_history(
        self, prompt_id: str, timeout_s: float
    ) -> dict:
        """Poll GET /history/{prompt_id} with exponential backoff."""
        deadline = time.monotonic() + timeout_s
        delay = 0.5

        while time.monotonic() < deadline:
            try:
                resp = await self._client.get(
                    f"{self.comfyui_url}/history/{prompt_id}"
                )
                data = resp.json()
                if prompt_id in data:
                    return data[prompt_id]
            except httpx.HTTPError as e:
                logger.warning("Poll error: %s", e)

            await asyncio.sleep(delay)
            delay = min(delay * 1.5, 5.0)

        # Timeout — try to cancel
        try:
            await self._client.post(
                f"{self.comfyui_url}/queue",
                json={"delete": [prompt_id]},
            )
        except httpx.HTTPError:
            pass
        raise TimeoutError(f"ComfyUI prompt {prompt_id} timed out")

    @staticmethod
    def _extract_filenames(history_entry: dict) -> list[str]:
        """Extract image/audio filenames from ComfyUI history output."""
        filenames: list[str] = []
        outputs = history_entry.get("outputs", {})
        for _node_id, node_out in outputs.items():
            for key in ("images", "audio"):
                items = node_out.get(key, [])
                if isinstance(items, list):
                    for item in items:
                        if isinstance(item, dict) and "filename" in item:
                            filenames.append(item["filename"])
        return filenames

    async def close(self) -> None:
        await self._client.aclose()
```

- [ ] **Step 2: Commit**

```bash
git add gpu-manager/comfyui_proxy.py
git commit -m "feat: add ComfyUI HTTP proxy for gpu-manager"
```

---

### Task 4: FastAPI 서버 엔트리포인트

**Files:**
- Create: `gpu-manager/server.py`

- [ ] **Step 1: Implement server.py with health, status, and comfyui endpoints**

```python
"""GPU Resource Manager — FastAPI server with serial queue."""

import argparse
import asyncio
import logging
import signal
import sys

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
import uvicorn

from queue_manager import QueueManager, Task, TaskType
from comfyui_proxy import ComfyUIProxy

# ── Logging ──────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="[gpu-manager] %(asctime)s %(levelname)s %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("gpu-manager")

# ── Parse CLI args ───────────────────────────────────────
parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, default=3342)
parser.add_argument("--comfyui-url", type=str, default="http://127.0.0.1:8188")
args, _ = parser.parse_known_args()

# ── Globals ──────────────────────────────────────────────
app = FastAPI(title="GPU Resource Manager")
queue = QueueManager()
comfyui = ComfyUIProxy(args.comfyui_url)


# ── Startup / Shutdown ───────────────────────────────────
@app.on_event("startup")
async def startup() -> None:
    # Start queue worker
    asyncio.create_task(queue.worker())

    # Register ComfyUI handler
    queue.register_handler(TaskType.COMFYUI, comfyui.generate)

    # Check ComfyUI connection
    connected = await comfyui.check_connection()
    logger.info("ComfyUI connected: %s", connected)

    logger.info("GPU Manager ready on port %d", args.port)


@app.on_event("shutdown")
async def shutdown() -> None:
    await comfyui.close()
    logger.info("GPU Manager shut down")


# ── Health / Status ──────────────────────────────────────
@app.get("/health")
async def health() -> dict:
    return {"ready": True}


@app.get("/status")
async def status() -> dict:
    q = queue.status()
    connected = await comfyui.check_connection()
    return {
        "queue_size": q.queue_size,
        "current_task": q.current_task,
        "model_loaded": False,  # TTS engine added in Phase 2
        "comfyui_connected": connected,
    }


# ── ComfyUI Proxy ───────────────────────────────────────
@app.post("/comfyui/generate")
async def comfyui_generate(request: Request) -> JSONResponse:
    body = await request.json()
    task = Task(type=TaskType.COMFYUI, payload=body)
    try:
        result = await queue.submit(task)
        return JSONResponse(result)
    except TimeoutError as e:
        return JSONResponse({"error": str(e)}, status_code=408)
    except Exception as e:
        logger.error("ComfyUI generate error: %s", e)
        return JSONResponse({"error": str(e)}, status_code=500)


# ── Graceful shutdown on signals ─────────────────────────
def _handle_signal(sig: int, _frame: object) -> None:
    logger.info("Received signal %d, shutting down...", sig)
    sys.exit(0)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)

    uvicorn.run(
        app,
        host="127.0.0.1",
        port=args.port,
        log_level="warning",  # FastAPI access logs are noisy
    )
```

- [ ] **Step 2: Test manually — start server and hit health endpoint**

```bash
cd gpu-manager
pip install fastapi uvicorn httpx
python server.py --port 3342
# In another terminal:
curl http://127.0.0.1:3342/health
# Expected: {"ready":true}
curl http://127.0.0.1:3342/status
# Expected: {"queue_size":0,"current_task":null,"model_loaded":false,"comfyui_connected":...}
```

- [ ] **Step 3: Commit**

```bash
git add gpu-manager/server.py
git commit -m "feat: add GPU Manager FastAPI server with queue and ComfyUI proxy"
```

---

## Chunk 2: TTS 엔진 + 음성 임베딩 생성

### Task 5: TTS 엔진 — Qwen3-TTS 직접 추론

**Files:**
- Create: `gpu-manager/tts_engine.py`

- [ ] **Step 1: Implement TTSEngine**

Qwen3-TTS 모델을 직접 로딩하여 추론하는 엔진. on-demand 로딩/언로딩, model size switching, idle timeout 지원.

```python
"""Qwen3-TTS direct inference engine with on-demand model loading."""

import asyncio
import base64
import io
import logging
import time
from pathlib import Path

import numpy as np
import torch
import soundfile as sf

logger = logging.getLogger("gpu-manager.tts")

# Idle timeout before unloading model (seconds)
IDLE_TIMEOUT = 30.0


class TTSEngine:
    def __init__(self, model_path: str | None = None) -> None:
        self._model_path = model_path
        self._model = None
        self._processor = None
        self._loaded_size: str | None = None
        self._idle_timer: asyncio.TimerHandle | None = None
        self._lock = asyncio.Lock()

    @property
    def is_loaded(self) -> bool:
        return self._model is not None

    @property
    def loaded_size(self) -> str | None:
        return self._loaded_size

    async def load_model(self, model_size: str = "1.7B") -> None:
        """Load Qwen3-TTS model into GPU VRAM."""
        if self._model is not None and self._loaded_size == model_size:
            self._reset_idle_timer()
            return
        if self._model is not None:
            await self.unload_model()

        logger.info("Loading Qwen3-TTS %s...", model_size)
        t0 = time.monotonic()

        # Run blocking model load in executor
        loop = asyncio.get_event_loop()
        self._model, self._processor = await loop.run_in_executor(
            None, self._load_model_sync, model_size
        )
        self._loaded_size = model_size

        elapsed = time.monotonic() - t0
        logger.info("Qwen3-TTS %s loaded in %.1fs", model_size, elapsed)
        self._reset_idle_timer()

    def _load_model_sync(self, model_size: str):
        """Synchronous model loading (runs in thread pool)."""
        from transformers import AutoTokenizer, AutoModelForCausalLM

        # Determine model name based on size
        # This will need to be adjusted based on actual Qwen3-TTS model naming
        model_name = self._model_path or f"Qwen/Qwen3-TTS-{model_size}"

        processor = AutoTokenizer.from_pretrained(model_name, trust_remote_code=True)
        model = AutoModelForCausalLM.from_pretrained(
            model_name,
            torch_dtype=torch.bfloat16,
            device_map="cuda",
            trust_remote_code=True,
        )
        model.eval()
        return model, processor

    async def unload_model(self) -> None:
        """Unload model and free VRAM."""
        if self._model is None:
            return
        self._cancel_idle_timer()

        logger.info("Unloading Qwen3-TTS %s...", self._loaded_size)
        del self._model
        del self._processor
        self._model = None
        self._processor = None
        self._loaded_size = None
        torch.cuda.empty_cache()
        logger.info("Qwen3-TTS unloaded, VRAM freed")

    async def synthesize_batch(self, payload: dict) -> list[dict]:
        """Synthesize multiple text chunks. Returns list of {chunk_index, audio_base64}."""
        chunks = payload["chunks"]
        voice_file = payload["voice_file"]
        language = payload.get("language", "ko")
        model_size = payload.get("model_size", "1.7B")
        max_new_tokens = payload.get("max_new_tokens", 2048)

        async with self._lock:
            await self.load_model(model_size)

            results = []
            for i, text in enumerate(chunks):
                t0 = time.monotonic()
                logger.info("TTS chunk %d/%d: %s...", i + 1, len(chunks), text[:40])

                loop = asyncio.get_event_loop()
                audio_bytes = await loop.run_in_executor(
                    None,
                    self._synthesize_sync,
                    text, voice_file, language, max_new_tokens,
                )

                elapsed = time.monotonic() - t0
                logger.info("TTS chunk %d done in %.1fs", i + 1, elapsed)

                audio_b64 = base64.b64encode(audio_bytes).decode("ascii")
                results.append({
                    "chunk_index": i,
                    "total": len(chunks),
                    "audio_base64": audio_b64,
                })

            self._reset_idle_timer()
            return results

    def _synthesize_sync(
        self, text: str, voice_file: str, language: str, max_new_tokens: int
    ) -> bytes:
        """Synchronous TTS inference (runs in thread pool)."""
        # Load voice embedding
        voice = torch.load(voice_file, map_location="cuda", weights_only=True)

        # Prepare input — exact method depends on Qwen3-TTS API
        # This is a placeholder that will be adapted to the actual model interface
        with torch.inference_mode():
            # Tokenize
            inputs = self._processor(
                text,
                return_tensors="pt",
            ).to("cuda")

            # Generate audio tokens
            output = self._model.generate(
                **inputs,
                voice=voice,
                language=language,
                max_new_tokens=max_new_tokens,
            )

        # Convert to audio waveform
        audio_np = output.cpu().numpy().astype(np.float32)

        # Encode to MP3
        return self._encode_mp3(audio_np, sample_rate=24000)

    @staticmethod
    def _encode_mp3(audio: np.ndarray, sample_rate: int = 24000) -> bytes:
        """Encode numpy audio array to MP3 bytes."""
        try:
            import lameenc
            encoder = lameenc.Encoder()
            encoder.set_bit_rate(128)
            encoder.set_in_sample_rate(sample_rate)
            encoder.set_channels(1)
            encoder.set_quality(2)

            # Normalize to int16
            if audio.dtype == np.float32 or audio.dtype == np.float64:
                audio = (audio * 32767).clip(-32768, 32767).astype(np.int16)

            mp3_data = encoder.encode(audio.tobytes())
            mp3_data += encoder.flush()
            return mp3_data
        except ImportError:
            # Fallback to WAV if lameenc not available
            buf = io.BytesIO()
            sf.write(buf, audio, sample_rate, format="WAV")
            return buf.getvalue()

    def force_unload(self) -> None:
        """Synchronously force unload (for image generation priority)."""
        if self._model is None:
            return
        self._cancel_idle_timer()
        del self._model
        del self._processor
        self._model = None
        self._processor = None
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
            logger.info("Idle timeout reached, unloading model...")
            self.force_unload()
```

> **Note**: `_synthesize_sync`의 모델 호출 부분은 실제 Qwen3-TTS API에 맞춰 구현 시 조정 필요. 위는 구조적 스켈레톤이다.

- [ ] **Step 2: Commit**

```bash
git add gpu-manager/tts_engine.py
git commit -m "feat: add Qwen3-TTS direct inference engine"
```

---

### Task 6: 음성 임베딩 생성기

**Files:**
- Create: `gpu-manager/voice_creator.py`

- [ ] **Step 1: Implement VoiceCreator**

```python
"""Voice embedding (.pt) generator — design prompt or reference audio."""

import asyncio
import base64
import logging
import time
from pathlib import Path

import torch
import numpy as np

logger = logging.getLogger("gpu-manager.voice")


class VoiceCreator:
    def __init__(self, tts_engine) -> None:
        self._engine = tts_engine

    async def create_voice(self, payload: dict) -> dict:
        """Create .pt voice embedding from design prompt or reference audio."""
        mode = payload["mode"]  # "design" or "reference"
        output_path = payload["output_path"]
        model_size = payload.get("model_size", "1.7B")
        language = payload.get("language", "ko")

        await self._engine.load_model(model_size)

        loop = asyncio.get_event_loop()

        if mode == "design":
            result = await loop.run_in_executor(
                None,
                self._create_from_design,
                payload["design_prompt"],
                language,
                output_path,
            )
        elif mode == "reference":
            result = await loop.run_in_executor(
                None,
                self._create_from_reference,
                payload["reference_audio"],
                payload.get("reference_text", ""),
                language,
                output_path,
            )
        else:
            raise ValueError(f"Unknown mode: {mode}")

        # Unload after voice creation (one-off operation)
        await self._engine.unload_model()

        return result

    def _create_from_design(
        self, design_prompt: str, language: str, output_path: str,
    ) -> dict:
        """Create voice embedding from text design prompt."""
        t0 = time.monotonic()
        logger.info("Creating voice from design: %s...", design_prompt[:60])

        # Generate sample audio with voice design
        # Exact API depends on Qwen3-TTS model interface
        with torch.inference_mode():
            # This is a placeholder — adapt to actual Qwen3-TTS voice design API
            voice_embedding = self._engine._model.create_voice_from_design(
                design_prompt=design_prompt,
                language=language,
            )

        # Save .pt file
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        torch.save(voice_embedding, output_path)

        # Generate sample audio for preview
        sample_audio = self._generate_sample(voice_embedding, language)

        elapsed = time.monotonic() - t0
        logger.info("Voice created in %.1fs: %s", elapsed, output_path)

        return {
            "success": True,
            "voice_file": output_path,
            "sample_audio": base64.b64encode(sample_audio).decode("ascii"),
        }

    def _create_from_reference(
        self, reference_audio: str, reference_text: str,
        language: str, output_path: str,
    ) -> dict:
        """Create voice embedding from reference audio file."""
        t0 = time.monotonic()
        logger.info("Creating voice from reference: %s", reference_audio)

        import soundfile as sf
        audio_data, sample_rate = sf.read(reference_audio)

        with torch.inference_mode():
            # Placeholder — adapt to actual Qwen3-TTS voice extraction API
            voice_embedding = self._engine._model.extract_voice(
                audio=torch.tensor(audio_data).to("cuda"),
                sample_rate=sample_rate,
                reference_text=reference_text if reference_text else None,
            )

        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        torch.save(voice_embedding, output_path)

        sample_audio = self._generate_sample(voice_embedding, language)

        elapsed = time.monotonic() - t0
        logger.info("Voice created in %.1fs: %s", elapsed, output_path)

        return {
            "success": True,
            "voice_file": output_path,
            "sample_audio": base64.b64encode(sample_audio).decode("ascii"),
        }

    def _generate_sample(self, voice_embedding, language: str) -> bytes:
        """Generate a short sample audio to preview the voice."""
        sample_texts = {
            "ko": "안녕하세요, 만나서 반갑습니다.",
            "en": "Hello, nice to meet you.",
            "ja": "こんにちは、はじめまして。",
            "zh": "你好，很高兴认识你。",
        }
        text = sample_texts.get(language, sample_texts["ko"])

        with torch.inference_mode():
            output = self._engine._model.generate(
                self._engine._processor(text, return_tensors="pt").to("cuda"),
                voice=voice_embedding,
                language=language,
                max_new_tokens=512,
            )

        audio_np = output.cpu().numpy().astype(np.float32)
        return self._engine._encode_mp3(audio_np, sample_rate=24000)
```

> **Note**: `_create_from_design`, `_create_from_reference`, `_generate_sample`의 모델 호출은 실제 Qwen3-TTS API에 맞춰 조정 필요.

- [ ] **Step 2: Commit**

```bash
git add gpu-manager/voice_creator.py
git commit -m "feat: add voice embedding creator for gpu-manager"
```

---

### Task 7: 서버에 TTS + voice 엔드포인트 추가

**Files:**
- Modify: `gpu-manager/server.py`

- [ ] **Step 1: Add TTS and voice endpoints to server.py**

`server.py`에 다음을 추가:

```python
# ── 상단 import 추가 ──
from fastapi.responses import StreamingResponse
from tts_engine import TTSEngine
from voice_creator import VoiceCreator
import json
import os

# ── Globals 섹션에 추가 ──
tts_engine = TTSEngine(model_path=os.environ.get("TTS_MODEL_PATH"))
voice_creator = VoiceCreator(tts_engine)
```

startup 이벤트에 TTS/voice 핸들러 등록:

```python
@app.on_event("startup")
async def startup() -> None:
    asyncio.create_task(queue.worker())
    queue.register_handler(TaskType.COMFYUI, _handle_comfyui)
    queue.register_handler(TaskType.TTS, tts_engine.synthesize_batch)
    queue.register_handler(TaskType.CREATE_VOICE, voice_creator.create_voice)
    connected = await comfyui.check_connection()
    logger.info("ComfyUI connected: %s", connected)
    logger.info("GPU Manager ready on port %d", args.port)

async def _handle_comfyui(payload: dict) -> dict:
    """Force-unload TTS model before ComfyUI work, then proxy."""
    tts_engine.force_unload()
    return await comfyui.generate(payload)
```

status 엔드포인트에 model_loaded 반영:

```python
@app.get("/status")
async def status() -> dict:
    q = queue.status()
    connected = await comfyui.check_connection()
    return {
        "queue_size": q.queue_size,
        "current_task": q.current_task,
        "model_loaded": tts_engine.is_loaded,
        "model_size": tts_engine.loaded_size,
        "comfyui_connected": connected,
    }
```

TTS synthesize 엔드포인트 (NDJSON 스트리밍):

```python
@app.post("/tts/synthesize")
async def tts_synthesize(request: Request) -> StreamingResponse:
    body = await request.json()
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

Voice creation 엔드포인트:

```python
@app.post("/tts/create-voice")
async def tts_create_voice(request: Request) -> JSONResponse:
    body = await request.json()
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

- [ ] **Step 2: Commit**

```bash
git add gpu-manager/server.py
git commit -m "feat: add TTS and voice creation endpoints to gpu-manager"
```

---

## Chunk 3: Bridge 통합

### Task 8: server.ts — GPU Manager spawn/lifecycle

**Files:**
- Modify: `server.ts`

- [ ] **Step 1: Add GPU Manager spawn logic**

기존 `spawnTtsServer()` 패턴을 따라 GPU Manager spawn 함수를 추가한다. `server.ts` 상단(TTS 서버 spawn 근처)에 추가:

```typescript
// ── GPU Manager spawn ───────────────────────────────────
const GPU_MANAGER_PORT = parseInt(process.env.GPU_MANAGER_PORT || "3342", 10);
const GPU_MANAGER_PYTHON = process.env.GPU_MANAGER_PYTHON || "python";
let gpuManagerRestarts = 0;
const GPU_MANAGER_MAX_RESTARTS = 3;

function spawnGpuManager(): ChildProcess | null {
  const serverScript = path.join(process.cwd(), "gpu-manager", "server.py");
  if (!fs.existsSync(serverScript)) {
    console.log("[gpu-manager] server.py not found, skipping");
    return null;
  }

  const comfyuiHost = process.env.COMFYUI_HOST || "127.0.0.1";
  const comfyuiPort = process.env.COMFYUI_PORT || "8188";
  const comfyuiUrl = `http://${comfyuiHost}:${comfyuiPort}`;

  const child = spawn(GPU_MANAGER_PYTHON, [
    serverScript,
    "--port", String(GPU_MANAGER_PORT),
    "--comfyui-url", comfyuiUrl,
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
    windowsHide: true,
  });

  child.stdout?.on("data", (d: Buffer) => process.stdout.write(d));
  child.stderr?.on("data", (d: Buffer) => process.stderr.write(d));

  child.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[gpu-manager] exited with code ${code}`);
      if (gpuManagerRestarts < GPU_MANAGER_MAX_RESTARTS) {
        gpuManagerRestarts++;
        console.log(`[gpu-manager] restarting (${gpuManagerRestarts}/${GPU_MANAGER_MAX_RESTARTS})...`);
        setTimeout(() => {
          gpuManagerProcess = spawnGpuManager();
        }, 10_000);
      } else {
        console.error("[gpu-manager] max restarts reached, GPU features disabled");
      }
    }
  });

  return child;
}

function killGpuManager(child: ChildProcess | null) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /T /F /PID ${child.pid}`, { stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
    }
  } catch { /* already dead */ }
}

async function waitForGpuManager(maxWaitMs = 30_000): Promise<boolean> {
  const url = `http://127.0.0.1:${GPU_MANAGER_PORT}/health`;
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}
```

기존 TTS 서버 spawn 부분 근처에 GPU Manager spawn 호출 추가:

```typescript
let gpuManagerProcess = spawnGpuManager();

// Cleanup handlers에 GPU Manager 추가
for (const sig of ["exit", "SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    killTtsServer(ttsProcess);
    killGpuManager(gpuManagerProcess);
  });
}
```

`app.prepare()` 이후에 health check 대기 추가:

```typescript
await app.prepare();

// Wait for GPU Manager to be ready
if (gpuManagerProcess) {
  const ready = await waitForGpuManager();
  if (ready) {
    console.log("[gpu-manager] ready");
  } else {
    console.warn("[gpu-manager] failed to start, GPU features may be unavailable");
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add server.ts
git commit -m "feat: spawn GPU Manager as child process in server.ts"
```

---

### Task 9: comfyui-client.ts — GPU Manager 프록시 경유

**Files:**
- Modify: `src/lib/comfyui-client.ts`

- [ ] **Step 1: Add GPU Manager proxy method**

`ComfyUIClient` 클래스에 GPU Manager 경유 메서드 추가. 기존 `generate()` 메서드의 프롬프트 제출 부분만 변경.

현재 `generate()` 흐름:
1. `buildPrompt()` → ComfyUI prompt dict 생성
2. `reconcileQueueBeforeSubmit()` → 큐 정리
3. `POST /prompt` → ComfyUI에 직접 제출
4. `pollHistory()` → 결과 대기
5. `downloadImage()` → 파일 다운로드

변경 후 흐름:
1. `buildPrompt()` → 그대로
2. GPU Manager `POST /comfyui/generate` → prompt + timeout 전달
3. GPU Manager가 큐잉 + ComfyUI 제출 + 폴링 수행
4. `downloadImage()` → ComfyUI에서 직접 (그대로)

`ComfyUIClient` 클래스에 추가:

```typescript
private get gpuManagerUrl(): string | null {
  const port = process.env.GPU_MANAGER_PORT || "3342";
  return `http://127.0.0.1:${port}`;
}

private async gpuManagerAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${this.gpuManagerUrl}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Submit prompt via GPU Manager (queued) instead of directly to ComfyUI.
 * Falls back to direct ComfyUI if GPU Manager is unavailable.
 */
private async submitViaGpuManager(
  prompt: Record<string, unknown>,
  timeoutMs: number = 600_000,
): Promise<{ promptId: string; filenames: string[]; history: Record<string, unknown> }> {
  const res = await this.fetchWithRetry(
    `${this.gpuManagerUrl}/comfyui/generate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, timeout: timeoutMs }),
    },
    { attempts: 2, timeoutMs: timeoutMs + 30_000 },
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GPU Manager error: ${err}`);
  }

  const data = await res.json() as {
    prompt_id: string;
    filenames: string[];
    history: Record<string, unknown>;
  };

  return {
    promptId: data.prompt_id,
    filenames: data.filenames,
    history: data.history,
  };
}
```

- [ ] **Step 2: Modify `generate()` to use GPU Manager**

기존 `generate()` (또는 내부의 `submitAndWait()`) 메서드에서 prompt 제출 경로를 변경:
- GPU Manager 사용 가능 → `submitViaGpuManager()`
- 불가 → 기존 직접 ComfyUI 호출 (fallback)

`reconcileQueueBeforeSubmit()` 호출을 GPU Manager 사용 시 skip하도록 수정.

- [ ] **Step 3: Commit**

```bash
git add src/lib/comfyui-client.ts
git commit -m "feat: route image generation through GPU Manager proxy"
```

---

### Task 10: tts-handler.ts — GPU Manager TTS 호출

**Files:**
- Modify: `src/lib/tts-handler.ts`

- [ ] **Step 1: Add GPU Manager TTS client function**

```typescript
const GPU_MANAGER_URL = `http://127.0.0.1:${process.env.GPU_MANAGER_PORT || "3342"}`;

async function gpuManagerAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${GPU_MANAGER_URL}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Synthesize via GPU Manager — sends all chunks as a batch,
 * receives NDJSON stream of {chunk_index, total, audio_base64}.
 */
async function synthesizeViaGpuManager(
  chunks: string[],
  voiceFile: string,
  language: string,
  modelSize: string,
): Promise<Array<{ chunkIndex: number; audioBuffer: Buffer }>> {
  const res = await fetch(`${GPU_MANAGER_URL}/tts/synthesize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chunks,
      voice_file: voiceFile,
      language,
      model_size: modelSize,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GPU Manager TTS error: ${err}`);
  }

  // Parse NDJSON response
  const text = await res.text();
  const results: Array<{ chunkIndex: number; audioBuffer: Buffer }> = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const item = JSON.parse(line);
    results.push({
      chunkIndex: item.chunk_index,
      audioBuffer: Buffer.from(item.audio_base64, "base64"),
    });
  }
  return results;
}
```

- [ ] **Step 2: Modify handleChatTts ComfyUI path**

기존 ComfyUI TTS 경로 (tts-handler.ts lines 119-169) 를 GPU Manager 호출로 교체:

```typescript
// ttsProvider === "comfyui" 또는 "local" 분기에서:
const provider = voiceConfig.ttsProvider || "comfyui";
if (provider === "comfyui" || provider === "local") {
  // New: GPU Manager batch TTS
  const gpuReady = await gpuManagerAvailable();
  if (!gpuReady) {
    return { status: 503, data: { error: "GPU Manager not available" } };
  }

  // Fire-and-forget async processing
  (async () => {
    try {
      wsBroadcast("audio:status", {
        status: "generating",
        messageId, totalChunks: chunks.length,
      });

      const results = await synthesizeViaGpuManager(
        chunks, voiceFile, language, modelSize,
      );

      for (const { chunkIndex, audioBuffer } of results) {
        const filename = `tts-${Date.now()}-${chunkIndex}.mp3`;
        const outPath = path.join(sessionDir, "audio", filename);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, audioBuffer);

        wsBroadcast("audio:ready", {
          url: `/api/sessions/${sessionId}/files/audio/${filename}`,
          messageId, chunkIndex, totalChunks: chunks.length,
        });
      }
    } catch (err) {
      console.error("[tts] GPU Manager error:", err);
      wsBroadcast("audio:status", {
        status: "error", messageId,
        chunkIndex: 0, totalChunks: chunks.length,
      });
    }
  })();

  return { status: 200, data: { status: "queued", chunks: chunks.length } };
}
```

- [ ] **Step 3: Modify voice generation to use GPU Manager**

`handleVoiceGeneratePost` (lines 175-390)에서 ComfyUI voice creation 경로를 GPU Manager로 교체:

```typescript
// "create-voice" mode:
const gpuReady = await gpuManagerAvailable();
if (!gpuReady) {
  return { status: 503, data: { error: "GPU Manager not available" } };
}

const createRes = await fetch(`${GPU_MANAGER_URL}/tts/create-voice`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    mode: referenceAudio ? "reference" : "design",
    design_prompt: design,
    reference_audio: referenceAudioPath,
    reference_text: referenceText,
    language,
    model_size: modelSize,
    output_path: outputPtPath,
  }),
});
```

- [ ] **Step 4: Update ttsProvider handling**

`"comfyui"` 와 `"local"` 을 동일하게 처리하도록 provider 분기 로직 수정:

```typescript
const provider = voiceConfig.ttsProvider || "comfyui";
const isLocalTts = provider === "local" || provider === "comfyui";
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/tts-handler.ts
git commit -m "feat: route TTS through GPU Manager instead of ComfyUI"
```

---

## Chunk 4: 정리 + 문서

### Task 11: ComfyUI TTS 코드 정리

**Files:**
- Modify: `src/lib/comfyui-client.ts`
- Modify: `src/lib/tts-handler.ts`

- [ ] **Step 1: Remove ComfyUI TTS-specific code from comfyui-client.ts**

`generateTts()` 메서드를 제거하거나 deprecated 표시. `extractAudioFilenames()` 메서드는 ComfyUI 프록시에서 사용할 수 있으므로 유지.

`reconcileQueueBeforeSubmit()` — GPU Manager 사용 시 불필요한 큐 관리 로직을 정리. GPU Manager fallback 시에만 호출되도록 조건 추가.

- [ ] **Step 2: Remove ComfyUI TTS prompt building from tts-handler.ts**

ComfyUI AILab 노드 참조 코드 (`AILab_Qwen3TTSVoiceClone`, `AILab_Qwen3TTSVoiceDesign`, `AILab_Qwen3TTSVoicesLibrary` 등) 를 제거:
- lines 127-153 (TTS prompt building)
- lines 201-259 (voice creation prompts)
- lines 289-387 (test voice prompts)

GPU Manager 호출로 교체된 이후 사용되지 않는 코드.

- [ ] **Step 3: Commit**

```bash
git add src/lib/comfyui-client.ts src/lib/tts-handler.ts
git commit -m "refactor: remove ComfyUI TTS code, now handled by GPU Manager"
```

---

### Task 12: CLAUDE.md + builder-prompt.md 업데이트

**Files:**
- Modify: `CLAUDE.md`
- Modify: `builder-prompt.md`

- [ ] **Step 1: Update CLAUDE.md**

Key Conventions 섹션에 GPU Manager 관련 내용 추가:
- GPU Manager 프로세스 설명 (Python child process, port 3342)
- `ttsProvider: "local"` 설명
- 환경변수 추가 (`GPU_MANAGER_PORT`, `GPU_MANAGER_PYTHON`, `TTS_MODEL_PATH`)

- [ ] **Step 2: Update builder-prompt.md**

음성 설정 섹션에서 ComfyUI TTS 언급을 GPU Manager 직접 추론으로 변경.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md builder-prompt.md
git commit -m "docs: update CLAUDE.md and builder-prompt for GPU Manager"
```
