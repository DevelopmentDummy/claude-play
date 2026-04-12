#!/usr/bin/env bash
# Usage: bash ./generate-image.sh <workflow> <prompt> <filename> [seed]
#   workflow: 패키지 이름 (예: portrait, scene, profile, my-workflow)
#   prompt:   캐릭터/장면 태그
#   filename: 출력 파일명 (예: lattice-portrait.png)
#   seed:     시드값 (기본 -1 = 랜덤)

set -euo pipefail

WORKFLOW="${1:-}"
PROMPT="${2:-}"
FILENAME="${3:-}"
SEED="${4:--1}"
PORT="{{PORT}}"

if [[ -z "$WORKFLOW" || -z "$PROMPT" || -z "$FILENAME" ]]; then
  echo "Usage: bash ./generate-image.sh <workflow> <prompt> <filename> [seed]" >&2
  exit 1
fi

TMP_JSON="$(mktemp)"
cleanup() {
  rm -f "$TMP_JSON"
}
trap cleanup EXIT

cat > "$TMP_JSON" <<EOF
{
  "workflow": "$WORKFLOW",
  "params": {
    "prompt": "$PROMPT",
    "seed": $SEED
  },
  "filename": "$FILENAME"
}
EOF

curl -s -X POST "http://localhost:${PORT}/api/tools/comfyui/generate" \
  -H "Content-Type: application/json" \
  -d @"$TMP_JSON"
