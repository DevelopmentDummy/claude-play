"""EmbeddingGemma 2 embedding server — standalone process in its own venv.

Why not inside GPU Manager: EmbeddingGemma 2 needs transformers>=5.19, while the
GPU Manager environment pins transformers==4.57.x for qwen-tts / qwen-asr
(maintenance-playbook §5.10). The two cannot share one interpreter, so this
server runs from gpu-manager/venv-embed and is spawned by server.ts.

Like ASR it does not go through the GPU serial queue: a query is ~0.1s.
The model is loaded on first use and unloaded after EMBED_IDLE_TIMEOUT so it
does not keep ~1.5GB VRAM away from ComfyUI.
"""

import argparse
import asyncio
import logging
import os
import time

import numpy as np
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
import uvicorn

logging.basicConfig(
    level=logging.INFO,
    format="[embed] %(asctime)s %(levelname)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("embed")
# huggingface_hub logs every HEAD/GET on model load at INFO — keep the server log readable.
for _noisy in ("httpx", "httpcore", "huggingface_hub", "sentence_transformers"):
    logging.getLogger(_noisy).setLevel(logging.WARNING)

MODEL_ID = os.environ.get("EMBED_MODEL_PATH") or "google/embeddinggemma-2"
IDLE_TIMEOUT = float(os.environ.get("EMBED_IDLE_TIMEOUT", "300"))
# The checkpoint reports a sentinel max_seq_length (~1e30); cap it so one long
# chunk cannot eat VRAM/time. Model context is 8192.
MAX_SEQ = int(os.environ.get("EMBED_MAX_SEQ", "2048"))
MAX_INPUTS = 64
NATIVE_DIM = 768
ALLOWED_DIMS = {128, 256, 512, 768}


class EmbedEngine:
    def __init__(self) -> None:
        self._model = None
        self._lock = asyncio.Lock()
        self._idle_timer: asyncio.TimerHandle | None = None
        self.prompts: dict[str, str] = {}

    @property
    def is_loaded(self) -> bool:
        return self._model is not None

    def _load_sync(self):
        import torch
        from sentence_transformers import SentenceTransformer

        model = SentenceTransformer(
            MODEL_ID, device="cuda" if torch.cuda.is_available() else "cpu",
            model_kwargs={"torch_dtype": torch.bfloat16},  # fp16 is unsupported by the model
        )
        model.max_seq_length = MAX_SEQ
        return model

    async def _ensure_loaded(self) -> None:
        if self._model is not None:
            return
        logger.info("Loading %s...", MODEL_ID)
        t0 = time.monotonic()
        self._model = await asyncio.get_event_loop().run_in_executor(None, self._load_sync)
        self.prompts = dict(getattr(self._model, "prompts", {}) or {})
        logger.info("Loaded in %.1fs", time.monotonic() - t0)

    def _unload(self) -> None:
        if self._model is None:
            return
        import torch

        del self._model
        self._model = None
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        logger.info("Model unloaded, VRAM freed")

    async def unload(self) -> None:
        async with self._lock:
            self._cancel_idle()
            self._unload()

    async def embed(self, inputs: list[dict], prompt_name: str | None, dim: int) -> np.ndarray:
        """Text items get the task prompt; media items are encoded without it. Order is preserved."""
        text_idx = [i for i, it in enumerate(inputs) if "text" in it]
        media_idx = [i for i, it in enumerate(inputs) if "text" not in it]
        async with self._lock:
            self._cancel_idle()
            try:
                await self._ensure_loaded()
                if prompt_name and prompt_name not in self.prompts:
                    raise ValueError(f"unknown task '{prompt_name}'. Known: {sorted(self.prompts)}")
                model = self._model
                loop = asyncio.get_event_loop()
                out = np.zeros((len(inputs), NATIVE_DIM), dtype=np.float32)
                t0 = time.monotonic()
                if text_idx:
                    texts = [str(inputs[i]["text"]) for i in text_idx]
                    vecs = await loop.run_in_executor(
                        None, lambda: model.encode(texts, prompt_name=prompt_name, show_progress_bar=False))
                    out[text_idx] = vecs
                if media_idx:
                    media = [inputs[i] for i in media_idx]
                    vecs = await loop.run_in_executor(
                        None, lambda: model.encode(media, show_progress_bar=False))
                    out[media_idx] = vecs
                logger.info("embedded %d text + %d media (%s, d=%d) in %.2fs",
                            len(text_idx), len(media_idx), prompt_name or "-", dim, time.monotonic() - t0)
            finally:
                self._reset_idle()
        # Matryoshka: truncate, then re-normalize so cosine == dot product.
        out = out[:, :dim]
        norms = np.linalg.norm(out, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        return out / norms

    def _reset_idle(self) -> None:
        self._cancel_idle()
        self._idle_timer = asyncio.get_event_loop().call_later(IDLE_TIMEOUT, self._idle_unload)

    def _cancel_idle(self) -> None:
        if self._idle_timer is not None:
            self._idle_timer.cancel()
            self._idle_timer = None

    def _idle_unload(self) -> None:
        if self._model is not None and not self._lock.locked():
            logger.info("Idle %.0fs — unloading", IDLE_TIMEOUT)
            self._unload()


engine = EmbedEngine()
app = FastAPI(title="Embedding server")


def _validate(body: dict) -> tuple[list[dict], str | None, int]:
    inputs = body.get("inputs")
    if not isinstance(inputs, list) or not inputs:
        raise ValueError("inputs must be a non-empty array")
    if len(inputs) > MAX_INPUTS:
        raise ValueError(f"at most {MAX_INPUTS} inputs per request (got {len(inputs)}) — batch on the client")
    clean: list[dict] = []
    for i, it in enumerate(inputs):
        if not isinstance(it, dict):
            raise ValueError(f"inputs[{i}] must be an object")
        if isinstance(it.get("text"), str):
            if not it["text"].strip():
                raise ValueError(f"inputs[{i}].text is empty")
            clean.append({"text": it["text"]})
        elif isinstance(it.get("image"), str):
            if not os.path.isabs(it["image"]) or not os.path.isfile(it["image"]):
                raise ValueError(f"inputs[{i}].image must be an existing absolute file path")
            clean.append({"image": it["image"]})
        else:
            raise ValueError(f"inputs[{i}] must be {{text}} or {{image}}")
    dim = int(body.get("dim") or NATIVE_DIM)
    if dim not in ALLOWED_DIMS:
        raise ValueError(f"dim must be one of {sorted(ALLOWED_DIMS)}")
    task = body.get("task") or None
    return clean, task, dim


@app.get("/health")
async def health() -> dict:
    return {"ready": True, "loaded": engine.is_loaded, "model": MODEL_ID, "native_dim": NATIVE_DIM,
            "max_inputs": MAX_INPUTS, "tasks": sorted(engine.prompts) if engine.prompts else None}


@app.post("/embed")
async def embed(request: Request) -> JSONResponse:
    try:
        inputs, task, dim = _validate(await request.json())
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    try:
        vecs = await asyncio.wait_for(engine.embed(inputs, task, dim), timeout=180.0)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    except asyncio.TimeoutError:
        return JSONResponse({"error": "embedding timed out after 180s"}, status_code=504)
    except Exception as e:
        logger.exception("embed failed")
        return JSONResponse({"error": f"{type(e).__name__}: {e}"}, status_code=500)
    return JSONResponse({"model": MODEL_ID, "dim": dim, "vectors": vecs.round(6).tolist()})


@app.post("/warmup")
async def warmup() -> dict:
    """Fire-and-forget preload — callers with short timeouts (persona tools: 10s) hit this first."""
    async def _go() -> None:
        async with engine._lock:
            engine._cancel_idle()
            try:
                await engine._ensure_loaded()
            finally:
                engine._reset_idle()
    if not engine.is_loaded:
        asyncio.create_task(_go())
    return {"ok": True, "loaded": engine.is_loaded}


@app.post("/unload")
async def unload() -> dict:
    await engine.unload()
    return {"ok": True}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=3343)
    args, _ = parser.parse_known_args()
    logger.info("Embedding server on port %d (model=%s, idle=%ss)", args.port, MODEL_ID, IDLE_TIMEOUT)
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
