#!/usr/bin/env bash
# SeedVR2 영상 복원 업스케일 + 원본 오디오 복원 (2026-10-01)
# 사용법: video_seedvr2_upscale.sh <in.mp4> <out.mp4> [resolution=1080] [model=seedvr2_ema_7b_fp8_e4m3fn_mixed_block35_fp16.safetensors]
# - ComfyUI 모델 캐시를 먼저 내려 VRAM 확보.
# - VAE 디코드 타일 512: 1024 타일은 16GB에서 VRAM이 넘쳐 배치당 5분(실측). 512로 페이징 회피.
set -euo pipefail
IN="$1"; OUT="$2"; RES="${3:-1080}"; MODEL="${4:-seedvr2_ema_7b_fp8_e4m3fn_mixed_block35_fp16.safetensors}"
COMFY="F:/repositories/comfyui"
TMP="$COMFY/output/_svr_tmp_$$.mp4"
curl -s -X POST http://127.0.0.1:8188/free -H "Content-Type: application/json" -d '{"unload_models":true,"free_memory":true}' -o /dev/null || true
cd "$COMFY/custom_nodes/ComfyUI-SeedVR2_VideoUpscaler"
../../venv/Scripts/python.exe inference_cli.py "$IN" --output "$TMP" --model_dir "$COMFY/models/SEEDVR2" \
  --dit_model "$MODEL" --resolution "$RES" --batch_size 21 --uniform_batch_size --temporal_overlap 3 \
  --color_correction lab --blocks_to_swap 20 --dit_offload_device cpu --vae_offload_device cpu \
  --vae_encode_tiled --vae_decode_tiled --vae_decode_tile_size 512 --vae_decode_tile_overlap 32 --video_backend ffmpeg
ffmpeg -v error -i "$TMP" -i "$IN" -map 0:v -map 1:a? -c:v copy -c:a copy -shortest -movflags +faststart -y "$OUT"
rm -f "$TMP"
echo "OK -> $OUT"
