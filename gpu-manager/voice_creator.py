"""Voice embedding (.pt) generator — reference audio voice cloning."""

import asyncio
import base64
import logging
import time
from pathlib import Path

import numpy as np

logger = logging.getLogger("gpu-manager.voice")


class VoiceCreator:
    def __init__(self, tts_engine) -> None:
        self._engine = tts_engine

    async def create_voice(self, payload: dict) -> dict:
        """Create .pt voice clone prompt from reference audio or design prompt."""
        mode = payload["mode"]  # "reference" or "design"
        output_path = payload["output_path"]
        model_size = payload.get("model_size", "1.7B")
        language = payload.get("language", "ko")

        async with self._engine._lock:
            loop = asyncio.get_event_loop()

            if mode == "reference":
                await self._engine.load_model(model_size)
                result = await loop.run_in_executor(
                    None,
                    self._create_from_reference,
                    payload["reference_audio"],
                    payload.get("reference_text", ""),
                    language,
                    output_path,
                )
            elif mode == "design":
                # Design mode loads VoiceDesign model itself,
                # so unload any existing Base model first to free VRAM
                await self._engine.unload_model()
                result = await loop.run_in_executor(
                    None,
                    self._create_from_design,
                    payload["design_prompt"],
                    language,
                    output_path,
                )
            else:
                raise ValueError(f"Unknown mode: {mode}")

            # Unload after voice creation (one-off operation)
            await self._engine.unload_model()

        return result

    def _create_from_reference(
        self, reference_audio: str, reference_text: str,
        language: str, output_path: str,
    ) -> dict:
        """Create voice clone prompt from reference audio file."""
        import torch

        t0 = time.monotonic()
        logger.info("Creating voice from reference: %s", reference_audio)

        # Create reusable voice clone prompt
        prompt_items = self._engine.create_voice_clone_prompt(
            ref_audio=reference_audio,
            ref_text=reference_text,
        )

        # Save .pt file
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        torch.save(prompt_items, output_path)

        # Generate sample audio for preview
        sample_audio = self._generate_sample(prompt_items, language)

        elapsed = time.monotonic() - t0
        logger.info("Voice created in %.1fs: %s", elapsed, output_path)

        return {
            "success": True,
            "voice_file": output_path,
            "sample_audio": base64.b64encode(sample_audio).decode("ascii"),
        }

    def _create_from_design(
        self, design_prompt: str, language: str, output_path: str,
    ) -> dict:
        """Create voice via design prompt using the VoiceDesign model.

        Loads the dedicated VoiceDesign model, generates a reference clip,
        then extracts a voice clone prompt from it for reuse with the Base model.
        """
        import torch
        import soundfile as sf
        import tempfile
        import os

        t0 = time.monotonic()
        logger.info("Creating voice from design: %s...", design_prompt[:60])

        from tts_engine import _LANGUAGE_MAP, VOICE_DESIGN_MODEL
        lang = _LANGUAGE_MAP.get(language, "Korean")

        sample_texts = {
            "ko": "안녕하세요, 만나서 반갑습니다. 오늘 날씨가 정말 좋네요.",
            "en": "Hello, nice to meet you. The weather is really nice today.",
            "ja": "こんにちは、はじめまして。今日はいい天気ですね。",
            "zh": "你好，很高兴认识你。今天天气真好。",
        }
        sample_text = sample_texts.get(language, sample_texts["ko"])

        # Load VoiceDesign model temporarily (different from Base model)
        logger.info("Loading VoiceDesign model for voice creation...")
        design_model = self._load_voice_design_model(VOICE_DESIGN_MODEL)

        # Generate a reference clip using voice design with instruct prompt
        wavs, sr = design_model.generate_voice_design(
            text=sample_text,
            instruct=design_prompt,
            language=lang,
        )

        # Unload design model to free VRAM
        del design_model
        torch.cuda.empty_cache()
        logger.info("VoiceDesign model unloaded")

        # Save generated audio to temp file
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp_path = tmp.name
            audio_np = wavs[0] if isinstance(wavs[0], np.ndarray) else wavs[0].cpu().numpy()
            sf.write(tmp_path, audio_np, sr)

        try:
            # Re-load Base model to extract voice clone prompt
            # (we're in executor thread, so call sync load directly)
            self._engine._model = self._engine._load_model_sync("1.7B")
            self._engine._loaded_size = "1.7B"

            prompt_items = self._engine.create_voice_clone_prompt(
                ref_audio=tmp_path,
                ref_text=sample_text,
            )
        finally:
            os.unlink(tmp_path)

        # Save .pt file
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        torch.save(prompt_items, output_path)

        # Generate sample for preview using the saved prompt
        sample_audio = self._generate_sample(prompt_items, language)

        elapsed = time.monotonic() - t0
        logger.info("Voice created in %.1fs: %s", elapsed, output_path)

        return {
            "success": True,
            "voice_file": output_path,
            "sample_audio": base64.b64encode(sample_audio).decode("ascii"),
        }

    @staticmethod
    def _load_voice_design_model(model_name: str):
        """Load the VoiceDesign model variant."""
        import torch
        from qwen_tts import Qwen3TTSModel

        try:
            import flash_attn  # noqa: F401
            attn_impl = "flash_attention_2"
        except ImportError:
            attn_impl = "sdpa"

        return Qwen3TTSModel.from_pretrained(
            model_name,
            device_map="cuda:0",
            dtype=torch.bfloat16,
            attn_implementation=attn_impl,
        )

    def _generate_sample(self, voice_clone_prompt, language: str) -> bytes:
        """Generate a short sample audio to preview the voice."""
        from tts_engine import _LANGUAGE_MAP

        sample_texts = {
            "ko": "안녕하세요, 만나서 반갑습니다.",
            "en": "Hello, nice to meet you.",
            "ja": "こんにちは、はじめまして。",
            "zh": "你好，很高兴认识你。",
        }
        text = sample_texts.get(language, sample_texts["ko"])
        lang = _LANGUAGE_MAP.get(language, "Korean")

        wavs, sr = self._engine._model.generate_voice_clone(
            text=text,
            language=lang,
            voice_clone_prompt=voice_clone_prompt,
        )

        audio_np = wavs[0] if isinstance(wavs[0], np.ndarray) else wavs[0].cpu().numpy()
        return self._engine._encode_mp3(audio_np.astype(np.float32), sample_rate=sr)
