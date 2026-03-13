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
        """Synchronous model loading (runs in thread pool).

        NOTE: The exact model class and loading method will need to be
        adapted to the actual Qwen3-TTS API. This is a structural skeleton.
        """
        from transformers import AutoTokenizer, AutoModelForCausalLM

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
        """Synthesize multiple text chunks. Returns list of {chunk_index, total, audio_base64}."""
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
        """Synchronous TTS inference (runs in thread pool).

        NOTE: The exact model inference API will need to be adapted to
        the actual Qwen3-TTS model interface. This is a structural skeleton.
        """
        # Load voice embedding
        voice = torch.load(voice_file, map_location="cuda", weights_only=True)

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
            if audio.dtype in (np.float32, np.float64):
                audio = (audio * 32767).clip(-32768, 32767).astype(np.int16)

            mp3_data = encoder.encode(audio.tobytes())
            mp3_data += encoder.flush()
            return mp3_data
        except ImportError:
            # Fallback to WAV if lameenc not available
            logger.warning("lameenc not installed, falling back to WAV output")
            buf = io.BytesIO()
            sf.write(buf, audio, sample_rate, format="WAV")
            return buf.getvalue()

    def force_unload(self) -> None:
        """Synchronously force unload (for image generation priority)."""
        if self._model is None:
            return
        self._cancel_idle_timer()
        logger.info("Force unloading TTS model for GPU priority...")
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
            logger.info("Idle timeout (%.0fs) reached, unloading model...", IDLE_TIMEOUT)
            self.force_unload()
