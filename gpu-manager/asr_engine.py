"""Qwen3-ASR speech-to-text engine with context biasing and on-demand model loading.

Unlike the TTS engines, ASR bypasses the serial GPU queue: a transcription is
~1-2s and the user is waiting on it, so it must not sit behind a ComfyUI job
(which has no timeout). It serializes only against itself via its own lock.
"""

import asyncio
import base64
import io
import logging
import os
import time

import numpy as np

logger = logging.getLogger("gpu-manager.asr")

# STT cold load right after the user stops speaking is felt directly, so keep the
# model resident much longer than TTS (120s). Override with ASR_IDLE_TIMEOUT.
IDLE_TIMEOUT = float(os.environ.get("ASR_IDLE_TIMEOUT", "600"))

SAMPLE_RATE = 16000

MODEL_NAMES = {
    "0.6B": "Qwen/Qwen3-ASR-0.6B",
    "1.7B": "Qwen/Qwen3-ASR-1.7B",
}

# Language code → Qwen3-ASR canonical name. None = auto-detect.
_LANGUAGE_MAP = {
    "ko": "Korean", "en": "English", "ja": "Japanese", "zh": "Chinese",
    "de": "German", "fr": "French", "ru": "Russian", "pt": "Portuguese",
    "es": "Spanish", "it": "Italian",
}

# Context is a soft bias; very long context dilutes it and slows prefill.
MAX_CONTEXT_CHARS = 4000


def _decode_audio(data: bytes) -> np.ndarray:
    """Decode any container (webm/opus from MediaRecorder, m4a from Safari, wav) to 16k mono float32."""
    import av

    container = av.open(io.BytesIO(data))
    try:
        resampler = av.AudioResampler(format="flt", layout="mono", rate=SAMPLE_RATE)
        parts: list[np.ndarray] = []
        for frame in container.decode(audio=0):
            for out in resampler.resample(frame):
                parts.append(out.to_ndarray().reshape(-1))
        for out in resampler.resample(None):
            parts.append(out.to_ndarray().reshape(-1))
    finally:
        container.close()
    if not parts:
        return np.zeros(0, dtype=np.float32)
    return np.concatenate(parts).astype(np.float32)


class ASREngine:
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

    async def load_model(self, model_size: str = "1.7B") -> None:
        if self._model is not None and self._loaded_size == model_size:
            self._reset_idle_timer()
            return
        if self._model is not None:
            await self.unload_model()

        logger.info("Loading Qwen3-ASR %s...", model_size)
        t0 = time.monotonic()
        loop = asyncio.get_event_loop()
        self._model = await loop.run_in_executor(None, self._load_model_sync, model_size)
        self._loaded_size = model_size
        logger.info("Qwen3-ASR %s loaded in %.1fs", model_size, time.monotonic() - t0)
        self._reset_idle_timer()

    def _load_model_sync(self, model_size: str):
        import torch
        from qwen_asr import Qwen3ASRModel

        model_name = self._model_path or MODEL_NAMES.get(model_size, MODEL_NAMES["1.7B"])
        return Qwen3ASRModel.from_pretrained(
            model_name,
            dtype=torch.bfloat16,
            device_map="cuda:0",
            max_inference_batch_size=4,
            max_new_tokens=256,
        )

    async def unload_model(self) -> None:
        if self._model is None:
            return
        self._cancel_idle_timer()
        self.force_unload()

    def force_unload(self) -> None:
        if self._model is None:
            return
        import torch

        logger.info("Unloading Qwen3-ASR %s...", self._loaded_size)
        del self._model
        self._model = None
        self._loaded_size = None
        torch.cuda.empty_cache()
        logger.info("Qwen3-ASR unloaded, VRAM freed")

    async def warmup(self, model_size: str = "1.7B") -> None:
        async with self._lock:
            await self.load_model(model_size)

    async def transcribe(self, payload: dict) -> dict:
        audio_b64 = payload["audio"]
        context = (payload.get("context") or "")[-MAX_CONTEXT_CHARS:]
        lang_code = payload.get("language") or ""
        language = _LANGUAGE_MAP.get(lang_code, lang_code or None)
        model_size = payload.get("model_size", "1.7B")

        wav = _decode_audio(base64.b64decode(audio_b64))
        if wav.size < SAMPLE_RATE // 10:
            return {"text": "", "language": ""}

        async with self._lock:
            self._cancel_idle_timer()
            await self.load_model(model_size)
            self._cancel_idle_timer()
            try:
                t0 = time.monotonic()
                loop = asyncio.get_event_loop()
                result = await loop.run_in_executor(
                    None,
                    lambda: self._model.transcribe(
                        audio=(wav, SAMPLE_RATE), context=context, language=language
                    )[0],
                )
                logger.info(
                    "ASR %.1fs audio → %.2fs (ctx %d chars): %s",
                    wav.size / SAMPLE_RATE, time.monotonic() - t0, len(context), result.text[:60],
                )
                return {"text": result.text, "language": result.language}
            finally:
                self._reset_idle_timer()

    def _reset_idle_timer(self) -> None:
        self._cancel_idle_timer()
        loop = asyncio.get_event_loop()
        self._idle_timer = loop.call_later(IDLE_TIMEOUT, self._idle_unload)

    def _cancel_idle_timer(self) -> None:
        if self._idle_timer is not None:
            self._idle_timer.cancel()
            self._idle_timer = None

    def _idle_unload(self) -> None:
        if self._model is not None and not self._lock.locked():
            logger.info("Idle timeout (%.0fs) reached, unloading ASR model...", IDLE_TIMEOUT)
            self.force_unload()
