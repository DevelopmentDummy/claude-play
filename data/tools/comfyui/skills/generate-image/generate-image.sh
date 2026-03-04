#!/usr/bin/env bash
# Usage: bash ./generate-image.sh <template> <prompt> <filename> [seed]
#   template: portrait | scene
#   prompt:   캐릭터/장면 태그 (quality/trigger 태그는 자동 삽입)
#   filename: 출력 파일명 (예: diane-smile.png)
#   seed:     시드값 (기본 -1 = 랜덤)

TEMPLATE="$1"
PROMPT="$2"
FILENAME="$3"
SEED="${4:--1}"
PORT="{{PORT}}"

QUALITY="masterpiece, best quality, amazing quality, absurdres"
TRIGGERS="anime screencap, anime coloring, sexydet, s1_dram"
NEGATIVE="bad quality, worst quality, worst detail, sketch, censored, watermark, signature, extra fingers, mutated hands, bad anatomy"

FULL_PROMPT="${QUALITY}, ${TRIGGERS}, ${PROMPT}"

curl -s -X POST "http://localhost:${PORT}/api/tools/comfyui/generate" \
  -H "Content-Type: application/json" \
  -d "$(printf '{"workflow":"%s","params":{"prompt":"%s","negative_prompt":"%s","seed":%s},"filename":"%s"}' \
    "$TEMPLATE" "$FULL_PROMPT" "$NEGATIVE" "$SEED" "$FILENAME")"
