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

    async def synthesize_batch(self, payload: dict) -> list[dict]:
        """Synthesize text chunks using VoxCPM2."""
        chunks = payload["chunks"]
        voice_file = payload["voice_file"]
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
        """Single text -> MP3 bytes via VoxCPM2.

        Automatically detects ultimate mode by checking for a sidecar .txt
        transcript file next to the voice .wav file.
        """
        # Check for sidecar transcript (ultimate mode)
        transcript_path = Path(voice_file).with_suffix(".txt")
        if transcript_path.exists():
            transcript = transcript_path.read_text(encoding="utf-8").strip()
            wav = self._model.generate(
                text=text,
                prompt_wav_path=voice_file,
                prompt_text=transcript,
                reference_wav_path=voice_file,
                cfg_value=2.0,
                inference_timesteps=10,
            )
        else:
            wav = self._model.generate(
                text=text,
                reference_wav_path=voice_file,
                cfg_value=2.0,
                inference_timesteps=10,
            )

        sr = self._model.tts_model.sample_rate
        audio_np = wav if isinstance(wav, np.ndarray) else wav.cpu().numpy()
        return self._encode_mp3(audio_np.astype(np.float32), sample_rate=sr)

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

        design_text = f"({design_prompt}){sample_text}"
        wav = self._model.generate(
            text=design_text,
            cfg_value=2.0,
            inference_timesteps=10,
        )

        sr = self._model.tts_model.sample_rate
        audio_np = wav if isinstance(wav, np.ndarray) else wav.cpu().numpy()

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
