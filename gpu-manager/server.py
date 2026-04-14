"""GPU Resource Manager — FastAPI server with serial queue."""

import argparse
import asyncio
import json
import logging
import os
import signal
import sys

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
import uvicorn

from queue_manager import QueueManager, Task, TaskType
from comfyui_proxy import ComfyUIProxy
from tts_engine import TTSEngine
from voice_creator import VoiceCreator
from voxcpm_engine import VoxCPMEngine

# ── TTS availability check ────────────────────────────────
try:
    import qwen_tts  # noqa: F401
    TTS_AVAILABLE = True
except ImportError:
    TTS_AVAILABLE = False

try:
    import voxcpm as _voxcpm_mod  # noqa: F401
    VOXCPM_AVAILABLE = True
except ImportError:
    VOXCPM_AVAILABLE = False

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
queue = QueueManager()
comfyui = ComfyUIProxy(args.comfyui_url)
tts_engine = TTSEngine(model_path=os.environ.get("TTS_MODEL_PATH"))
voice_creator = VoiceCreator(tts_engine)
voxcpm_engine = VoxCPMEngine(model_path=os.environ.get("VOXCPM_MODEL_PATH"))


# ── ComfyUI handler (force-unloads TTS first) ───────────
async def _handle_comfyui(payload: dict) -> dict:
    """Force-unload TTS models before ComfyUI work, then proxy."""
    tts_engine.force_unload()
    voxcpm_engine.force_unload()
    return await comfyui.generate(payload)


async def _handle_tts(payload: dict) -> list[dict]:
    """Dispatch TTS to correct engine based on provider field."""
    provider = payload.get("provider", "qwen3")
    chunk_queue = payload.pop("_chunk_queue", None)

    if provider == "voxcpm":
        tts_engine.force_unload()
        if chunk_queue:
            await voxcpm_engine.synthesize_streaming(payload, chunk_queue)
            return []
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


# ── Lifespan ─────────────────────────────────────────────
from contextlib import asynccontextmanager


@asynccontextmanager
async def lifespan(app):
    # Startup
    asyncio.create_task(queue.worker())

    queue.register_handler(TaskType.COMFYUI, _handle_comfyui)
    queue.register_handler(TaskType.TTS, _handle_tts)
    queue.register_handler(TaskType.CREATE_VOICE, _handle_create_voice)

    connected = await comfyui.check_connection()
    logger.info("ComfyUI connected: %s", connected)

    logger.info("GPU Manager ready on port %d", args.port)
    yield
    # Shutdown
    await tts_engine.unload_model()
    await voxcpm_engine.unload_model()
    await comfyui.close()
    logger.info("GPU Manager shut down")


app = FastAPI(title="GPU Resource Manager", lifespan=lifespan)


# ── Health / Status ──────────────────────────────────────
@app.get("/health")
async def health() -> dict:
    return {
        "ready": True,
        "tts_available": TTS_AVAILABLE,
        "voxcpm_available": VOXCPM_AVAILABLE,
    }


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


# ── TTS Synthesize ───────────────────────────────────────
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


# ── TTS Streaming (VoxCPM) ──────────────────────────────
@app.post("/tts/synthesize-stream")
async def tts_synthesize_stream(request: Request) -> StreamingResponse:
    """Streaming TTS — audio chunks sent as they're generated (VoxCPM only)."""
    if not VOXCPM_AVAILABLE:
        return JSONResponse(
            status_code=503,
            content={"error": "VoxCPM not installed. Install with: pip install -r requirements-voxcpm.txt"},
        )

    body = await request.json()
    chunk_queue: asyncio.Queue = asyncio.Queue()
    body["_chunk_queue"] = chunk_queue
    body["provider"] = "voxcpm"

    task = Task(type=TaskType.TTS, payload=body)
    submit_future = asyncio.ensure_future(queue.submit(task))

    async def stream():
        try:
            while True:
                item = await chunk_queue.get()
                if item is None:
                    break
                yield json.dumps(item, ensure_ascii=False) + "\n"
        except Exception as e:
            logger.error("TTS stream error: %s", e)
        try:
            await submit_future
        except Exception:
            pass

    return StreamingResponse(stream(), media_type="application/x-ndjson")


# ── Voice Creation ───────────────────────────────────────
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
