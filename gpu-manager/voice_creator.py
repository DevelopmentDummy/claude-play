"""Voice embedding (.pt) generator — design prompt or reference audio."""

import asyncio
import base64
import logging
import time
from pathlib import Path

import numpy as np
import torch

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

        async with self._engine._lock:
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
        """Create voice embedding from text design prompt.

        NOTE: The exact model API for voice design will need to be adapted
        to the actual Qwen3-TTS interface. This is a structural skeleton.
        """
        t0 = time.monotonic()
        logger.info("Creating voice from design: %s...", design_prompt[:60])

        with torch.inference_mode():
            # Placeholder — adapt to actual Qwen3-TTS voice design API
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
        """Create voice embedding from reference audio file.

        NOTE: The exact model API for voice extraction will need to be adapted
        to the actual Qwen3-TTS interface. This is a structural skeleton.
        """
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
            inputs = self._engine._processor(text, return_tensors="pt").to("cuda")
            output = self._engine._model.generate(
                **inputs,
                voice=voice_embedding,
                language=language,
                max_new_tokens=512,
            )

        audio_np = output.cpu().numpy().astype(np.float32)
        return self._engine._encode_mp3(audio_np, sample_rate=24000)
