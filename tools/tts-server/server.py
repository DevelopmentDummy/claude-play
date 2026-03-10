"""Qwen3-TTS FastAPI server for Claude Bridge."""

import os
import torch
import torchaudio
import soundfile as sf
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Optional

app = FastAPI(title="Qwen3-TTS Server")

# Global model reference
model = None
processor = None


class GenerateRequest(BaseModel):
    text: str
    reference_audio: Optional[str] = None
    design: Optional[str] = None
    language: Optional[str] = "ko"
    speed: Optional[float] = 1.0
    output_path: str


@app.on_event("startup")
async def load_model():
    global model, processor
    from transformers import AutoTokenizer, AutoModelForCausalLM

    model_name = os.getenv("TTS_MODEL", "Qwen/Qwen3-TTS-1.7B")
    print(f"[tts] Loading model: {model_name}")

    processor = AutoTokenizer.from_pretrained(model_name, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        model_name,
        torch_dtype=torch.float16,
        device_map="cuda",
        trust_remote_code=True,
    )
    print("[tts] Model loaded successfully")


@app.get("/tts/health")
async def health():
    return {
        "status": "ok" if model is not None else "loading",
        "model": os.getenv("TTS_MODEL", "Qwen/Qwen3-TTS-1.7B"),
    }


@app.post("/tts/generate")
async def generate(req: GenerateRequest):
    if model is None:
        raise HTTPException(status_code=503, detail="Model not loaded yet")

    try:
        if req.reference_audio and os.path.exists(req.reference_audio):
            audio, sr = torchaudio.load(req.reference_audio)
            if sr != 24000:
                audio = torchaudio.functional.resample(audio, sr, 24000)
            response = model.generate(
                text=req.text,
                reference_audio=audio,
                language=req.language,
                speed=req.speed,
            )
        elif req.design:
            response = model.generate(
                text=req.text,
                voice_design=req.design,
                language=req.language,
                speed=req.speed,
            )
        else:
            response = model.generate(
                text=req.text,
                language=req.language,
                speed=req.speed,
            )

        os.makedirs(os.path.dirname(req.output_path), exist_ok=True)
        sf.write(req.output_path, response.cpu().numpy(), 24000)

        return {"success": True, "filepath": req.output_path}

    except Exception as e:
        print(f"[tts] Generation error: {e}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)},
        )


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("TTS_PORT", "8800"))
    uvicorn.run(app, host="0.0.0.0", port=port)
