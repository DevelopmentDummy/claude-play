"""Qwen3-TTS direct inference engine with on-demand model loading."""

import asyncio
import base64
import io
import logging
import time
from pathlib import Path

import numpy as np
import soundfile as sf

logger = logging.getLogger("gpu-manager.tts")

# Idle timeout before unloading model (seconds)
IDLE_TIMEOUT = 120.0

# Model name mapping: size → HuggingFace model ID
MODEL_NAMES = {
    "0.6B": "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
    "1.7B": "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
}

# Specialized model variants for voice creation
VOICE_DESIGN_MODEL = "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign"
CUSTOM_VOICE_MODEL = "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice"


class TTSEngine:
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
        """Load Qwen3-TTS model into GPU VRAM."""
        if self._model is not None and self._loaded_size == model_size:
            self._reset_idle_timer()
            return
        if self._model is not None:
            await self.unload_model()

        logger.info("Loading Qwen3-TTS %s...", model_size)
        t0 = time.monotonic()

        loop = asyncio.get_event_loop()
        self._model = await loop.run_in_executor(
            None, self._load_model_sync, model_size
        )
        self._loaded_size = model_size

        elapsed = time.monotonic() - t0
        logger.info("Qwen3-TTS %s loaded in %.1fs", model_size, elapsed)
        self._reset_idle_timer()

    def _load_model_sync(self, model_size: str):
        """Synchronous model loading (runs in thread pool)."""
        import torch
        from qwen_tts import Qwen3TTSModel

        model_name = self._model_path or MODEL_NAMES.get(model_size, MODEL_NAMES["1.7B"])

        # Use flash_attention_2 if available, otherwise sdpa (PyTorch native)
        try:
            import flash_attn  # noqa: F401
            attn_impl = "flash_attention_2"
        except ImportError:
            attn_impl = "sdpa"
        logger.info("Using attention: %s", attn_impl)

        model = Qwen3TTSModel.from_pretrained(
            model_name,
            device_map="cuda:0",
            dtype=torch.bfloat16,
            attn_implementation=attn_impl,
        )

        return model

    async def unload_model(self) -> None:
        """Unload model and free VRAM."""
        if self._model is None:
            return
        self._cancel_idle_timer()

        logger.info("Unloading Qwen3-TTS %s...", self._loaded_size)
        import torch
        del self._model
        self._model = None
        self._loaded_size = None
        torch.cuda.empty_cache()
        logger.info("Qwen3-TTS unloaded, VRAM freed")

    async def synthesize_batch(self, payload: dict) -> list[dict]:
        """Synthesize text chunks with native batch inference.

        Processes up to batch_size chunks in a single forward pass for efficiency.
        """
        chunks = payload["chunks"]
        voice_file = payload["voice_file"]
        language = payload.get("language", "ko")
        model_size = payload.get("model_size", "1.7B")
        batch_size = payload.get("batch_size", 3)

        async with self._lock:
            self._cancel_idle_timer()
            await self.load_model(model_size)
            self._cancel_idle_timer()

            results = []
            # Process chunks in batches
            for batch_start in range(0, len(chunks), batch_size):
                batch = chunks[batch_start:batch_start + batch_size]
                batch_indices = list(range(batch_start, batch_start + len(batch)))

                t0 = time.monotonic()
                logger.info(
                    "TTS batch %d-%d/%d: %s...",
                    batch_start + 1, batch_start + len(batch), len(chunks),
                    batch[0][:40],
                )

                loop = asyncio.get_event_loop()
                audio_list = await loop.run_in_executor(
                    None,
                    self._synthesize_batch_sync,
                    batch, voice_file, language,
                )

                elapsed = time.monotonic() - t0
                logger.info(
                    "TTS batch %d-%d done in %.1fs (%.1fs/chunk)",
                    batch_start + 1, batch_start + len(batch),
                    elapsed, elapsed / len(batch),
                )

                for j, audio_bytes in enumerate(audio_list):
                    idx = batch_indices[j]
                    audio_b64 = base64.b64encode(audio_bytes).decode("ascii")
                    results.append({
                        "chunk_index": idx,
                        "total": len(chunks),
                        "audio_base64": audio_b64,
                    })

            self._reset_idle_timer()
            return results

    def _synthesize_batch_sync(
        self, texts: list[str], voice_file: str, language: str,
    ) -> list[bytes]:
        """Batch TTS inference — multiple texts in one forward pass."""
        import torch

        raw = torch.load(voice_file, map_location="cuda:0", weights_only=False)
        voice_clone_prompt = _to_voice_clone_prompt(raw)
        lang = _LANGUAGE_MAP.get(language, "Korean")

        try:
            wavs, sr = self._model.generate_voice_clone(
                text=texts,
                language=[lang] * len(texts),
                voice_clone_prompt=voice_clone_prompt,
            )
        except torch.cuda.OutOfMemoryError:
            logger.error("CUDA OOM during TTS — clearing cache and retrying one-by-one")
            torch.cuda.empty_cache()
            # Fallback: process one at a time
            wavs = []
            sr = 24000
            for t in texts:
                w, sr = self._model.generate_voice_clone(
                    text=[t],
                    language=[lang],
                    voice_clone_prompt=voice_clone_prompt,
                )
                wavs.extend(w)

        results = []
        for wav in wavs:
            audio_np = wav if isinstance(wav, np.ndarray) else wav.cpu().numpy()
            results.append(self._encode_mp3(audio_np.astype(np.float32), sample_rate=sr))
        return results

    def create_voice_clone_prompt(
        self, ref_audio: str, ref_text: str,
    ) -> object:
        """Create a reusable voice clone prompt from reference audio.

        Returns the prompt object to be saved as .pt file.
        """
        prompt_items = self._model.create_voice_clone_prompt(
            ref_audio=ref_audio,
            ref_text=ref_text if ref_text else None,
            x_vector_only_mode=not bool(ref_text),
        )
        return prompt_items

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
            logger.warning("lameenc not installed, falling back to WAV output")
            buf = io.BytesIO()
            sf.write(buf, audio, sample_rate, format="WAV")
            return buf.getvalue()

    def force_unload(self) -> None:
        """Synchronously force unload (for image generation priority or idle timeout)."""
        if self._model is None:
            return
        # Don't unload while synthesis is in progress
        if self._lock.locked():
            logger.debug("Skipping unload — synthesis in progress")
            return
        self._cancel_idle_timer()
        import torch
        logger.info("Force unloading TTS model for GPU priority...")
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
            logger.info("Idle timeout (%.0fs) reached, unloading model...", IDLE_TIMEOUT)
            self.force_unload()


# Language code → full name mapping for Qwen3-TTS API
_LANGUAGE_MAP = {
    "ko": "Korean", "en": "English", "ja": "Japanese", "zh": "Chinese",
    "de": "German", "fr": "French", "ru": "Russian", "pt": "Portuguese",
    "es": "Spanish", "it": "Italian",
}


def _to_voice_clone_prompt(raw) -> list:
    """Convert saved .pt format to list of VoiceClonePromptItem.

    Supports:
    - ComfyUI format: {"version": 2, "prompt": [{"ref_code": ..., "ref_spk_embedding": ...}, ...]}
    - Native qwen-tts format: list of VoiceClonePromptItem (pass-through)
    """
    from qwen_tts.inference.qwen3_tts_model import VoiceClonePromptItem

    # Already native format
    if isinstance(raw, list) and len(raw) > 0 and isinstance(raw[0], VoiceClonePromptItem):
        return raw

    # ComfyUI format: dict with "prompt" key
    if isinstance(raw, dict) and "prompt" in raw:
        items = []
        for entry in raw["prompt"]:
            ref_code = entry.get("ref_code")
            ref_spk = entry.get("ref_spk_embedding")
            has_icl = ref_code is not None
            items.append(VoiceClonePromptItem(
                ref_code=ref_code,
                ref_spk_embedding=ref_spk,
                x_vector_only_mode=not has_icl,
                icl_mode=has_icl,
                ref_text=entry.get("ref_text"),
            ))
        return items

    raise ValueError(f"Unknown voice prompt format: {type(raw)}")
