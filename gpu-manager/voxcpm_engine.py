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

# Windows lacks symlink privileges, so HuggingFace Hub cache fails.
# Use local_dir download as fallback.
_LOCAL_CACHE_DIR = Path.home() / ".cache" / "voxcpm"


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

        if self._model_path:
            model_name = self._model_path
        else:
            hf_id = MODEL_NAMES.get(model_size, MODEL_NAMES["2B"])
            # Prefer local cache (avoids Windows symlink issues with HF Hub)
            local_dir = _LOCAL_CACHE_DIR / hf_id.split("/")[-1]
            model_name = str(local_dir) if local_dir.exists() else hf_id

        model = VoxCPM.from_pretrained(
            model_name,
            load_denoiser=False,
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

    # ── Synthesis ───────────────────────────────────────────

    async def synthesize_batch(self, payload: dict) -> list[dict]:
        """Synthesize text chunks using VoxCPM2 with cached prompt (non-streaming)."""
        chunks = payload["chunks"]
        voice_file = payload["voice_file"]
        model_size = payload.get("model_size", "2B")

        async with self._lock:
            self._cancel_idle_timer()
            await self.load_model(model_size)
            self._cancel_idle_timer()

            loop = asyncio.get_event_loop()
            prompt_cache = await loop.run_in_executor(
                None, self._load_prompt_cache, voice_file
            )

            results = []
            for i, text in enumerate(chunks):
                t0 = time.monotonic()
                logger.info("VoxCPM chunk %d/%d: %s...", i + 1, len(chunks), text[:40])

                audio_bytes = await loop.run_in_executor(
                    None, self._synthesize_one, text, prompt_cache,
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

    async def synthesize_streaming(
        self, payload: dict, chunk_queue: asyncio.Queue,
    ) -> None:
        """Synthesize text using VoxCPM2 streaming — push audio chunks as generated.

        Each chunk is pushed to chunk_queue as a dict with chunk_index and audio_base64.
        A None sentinel is pushed when done.
        """
        text = payload["text"]
        voice_file = payload["voice_file"]
        model_size = payload.get("model_size", "2B")

        async with self._lock:
            self._cancel_idle_timer()
            await self.load_model(model_size)
            self._cancel_idle_timer()

            loop = asyncio.get_event_loop()
            prompt_cache = await loop.run_in_executor(
                None, self._load_prompt_cache, voice_file
            )

            logger.info("VoxCPM streaming: %s...", text[:60])
            t0 = time.monotonic()

            await loop.run_in_executor(
                None,
                self._stream_sync,
                text, prompt_cache, chunk_queue, loop,
            )

            elapsed = time.monotonic() - t0
            logger.info("VoxCPM streaming done in %.1fs", elapsed)
            self._reset_idle_timer()

    @staticmethod
    def _is_silence(audio: np.ndarray, threshold: float = 0.01) -> bool:
        """Check if an audio chunk is silence (low RMS energy)."""
        rms = np.sqrt(np.mean(audio ** 2))
        return rms < threshold

    def _stream_sync(
        self, text: str, prompt_cache: dict,
        chunk_queue: asyncio.Queue, loop: asyncio.AbstractEventLoop,
    ) -> None:
        """Run streaming generation in sync thread, push chunks to async queue.

        Splits at silence boundaries for natural-sounding segments:
        - Accumulate raw audio chunks
        - After MIN_CHUNKS, check each new chunk for silence (pause)
        - Flush at silence boundary → clean cut between phrases
        - Force flush at MAX_CHUNKS to cap latency
        """
        MIN_CHUNKS = 6    # minimum chunks before checking for silence
        MAX_CHUNKS = 20   # force flush even without silence
        sr = self._model.tts_model.sample_rate
        segment_idx = 0
        audio_buffer: list[np.ndarray] = []

        for chunk_tuple in self._model.tts_model._generate_with_prompt_cache(
            target_text=text,
            prompt_cache=prompt_cache,
            inference_timesteps=10,
            cfg_value=2.0,
            streaming=True,
            streaming_prefix_len=8,
        ):
            wav = chunk_tuple[0].cpu().numpy().squeeze().astype(np.float32)
            audio_buffer.append(wav)

            should_flush = False
            if len(audio_buffer) >= MAX_CHUNKS:
                should_flush = True
            elif len(audio_buffer) >= MIN_CHUNKS and self._is_silence(wav):
                should_flush = True

            if should_flush:
                merged = np.concatenate(audio_buffer)
                audio_buffer.clear()
                mp3 = self._encode_mp3(merged, sr)
                item = {
                    "chunk_index": segment_idx,
                    "audio_base64": base64.b64encode(mp3).decode("ascii"),
                }
                asyncio.run_coroutine_threadsafe(chunk_queue.put(item), loop).result()
                segment_idx += 1
                dur = len(merged) / sr
                logger.info("VoxCPM segment %d (%.1fs)", segment_idx, dur)

        # Flush remaining buffer
        if audio_buffer:
            merged = np.concatenate(audio_buffer)
            mp3 = self._encode_mp3(merged, sr)
            item = {
                "chunk_index": segment_idx,
                "audio_base64": base64.b64encode(mp3).decode("ascii"),
            }
            asyncio.run_coroutine_threadsafe(chunk_queue.put(item), loop).result()
            segment_idx += 1
            dur = len(merged) / sr
            logger.info("VoxCPM final segment %d (%.1fs)", segment_idx, dur)

        # Sentinel
        asyncio.run_coroutine_threadsafe(chunk_queue.put(None), loop).result()

    @staticmethod
    def _load_prompt_cache(voice_file: str) -> dict:
        """Load .pt prompt cache file.

        Tensors are restored to the device they were saved on (cuda).
        Do NOT use map_location — let torch restore to original device
        to avoid dtype/device mismatches with the model.
        """
        import torch
        return torch.load(voice_file, weights_only=False)

    def _synthesize_one(self, text: str, prompt_cache: dict) -> bytes:
        """Single text -> MP3 bytes using pre-built prompt cache."""
        result = next(self._model.tts_model._generate_with_prompt_cache(
            target_text=text,
            prompt_cache=prompt_cache,
            inference_timesteps=10,
            cfg_value=2.0,
            streaming=False,
        ))

        # result is a tuple; first element is the waveform tensor
        wav_tensor = result[0]
        sr = self._model.tts_model.sample_rate
        audio_np = wav_tensor.cpu().numpy().squeeze()
        return self._encode_mp3(audio_np.astype(np.float32), sample_rate=sr)

    # ── Voice Creation ──────────────────────────────────────

    async def create_voice(self, payload: dict) -> dict:
        """Create .pt prompt cache from reference audio or voice design."""
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

    def _build_and_save_cache(
        self, output_path: str, *,
        reference_wav_path: str | None = None,
        prompt_wav_path: str | None = None,
        prompt_text: str | None = None,
    ) -> dict:
        """Build prompt cache from audio and save as .pt file."""
        import torch

        cache = self._model.tts_model.build_prompt_cache(
            reference_wav_path=reference_wav_path,
            prompt_wav_path=prompt_wav_path,
            prompt_text=prompt_text,
        )

        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        torch.save(cache, output_path)
        logger.info("Saved prompt cache: %s", output_path)
        return cache

    def _generate_sample_from_cache(self, cache: dict, language: str) -> bytes:
        """Generate a short sample audio for preview using prompt cache."""
        sample_texts = {
            "ko": "안녕하세요, 만나서 반갑습니다.",
            "en": "Hello, nice to meet you.",
            "ja": "こんにちは、はじめまして。",
            "zh": "你好，很高兴认识你。",
        }
        text = sample_texts.get(language, sample_texts["ko"])

        result = next(self._model.tts_model._generate_with_prompt_cache(
            target_text=text,
            prompt_cache=cache,
            inference_timesteps=10,
            cfg_value=2.0,
            streaming=False,
        ))

        sr = self._model.tts_model.sample_rate
        audio_np = result[0].cpu().numpy().squeeze()
        return self._encode_mp3(audio_np.astype(np.float32), sample_rate=sr)

    def _create_from_reference(
        self, reference_audio: str, output_path: str, language: str,
    ) -> dict:
        """Controllable cloning — build prompt cache from reference audio."""
        t0 = time.monotonic()
        logger.info("VoxCPM voice from reference: %s", reference_audio)

        cache = self._build_and_save_cache(
            output_path, reference_wav_path=reference_audio,
        )
        sample_audio = self._generate_sample_from_cache(cache, language)

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
        """Ultimate cloning — build prompt cache with audio + transcript."""
        t0 = time.monotonic()
        logger.info("VoxCPM ultimate voice from reference: %s", reference_audio)

        cache = self._build_and_save_cache(
            output_path,
            reference_wav_path=reference_audio,
            prompt_wav_path=reference_audio,
            prompt_text=reference_text,
        )
        sample_audio = self._generate_sample_from_cache(cache, language)

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
        """Voice Design — generate reference audio, then build prompt cache."""
        import tempfile
        import os

        t0 = time.monotonic()
        logger.info("VoxCPM voice design: %s...", design_prompt[:60])

        sample_texts = {
            "ko": "안녕하세요, 만나서 반갑습니다. 오늘 날씨가 정말 좋네요.",
            "en": "Hello, nice to meet you. The weather is really nice today.",
            "ja": "こんにちは、はじめまして。今日はいい天気ですね。",
            "zh": "你好，很高兴认识你。今天天气真好。",
        }
        sample_text = sample_texts.get(language, sample_texts["ko"])

        # Generate reference audio from design prompt
        design_text = f"({design_prompt}){sample_text}"
        wav = self._model.generate(
            text=design_text,
            cfg_value=2.0,
            inference_timesteps=10,
        )

        sr = self._model.tts_model.sample_rate
        audio_np = wav if isinstance(wav, np.ndarray) else wav.cpu().numpy()

        # Save generated audio to temp file, build cache from it
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp_path = tmp.name
            sf.write(tmp_path, audio_np, sr)

        try:
            cache = self._build_and_save_cache(
                output_path, reference_wav_path=tmp_path,
            )
        finally:
            os.unlink(tmp_path)

        # Use the design-generated audio as the sample preview
        sample_audio = self._encode_mp3(audio_np.squeeze().astype(np.float32), sample_rate=sr)

        elapsed = time.monotonic() - t0
        logger.info("VoxCPM voice designed in %.1fs: %s", elapsed, output_path)

        return {
            "success": True,
            "voice_file": output_path,
            "sample_audio": base64.b64encode(sample_audio).decode("ascii"),
        }
