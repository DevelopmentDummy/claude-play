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
        "model_loaded": False,  # TTS engine added in Task 7
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
