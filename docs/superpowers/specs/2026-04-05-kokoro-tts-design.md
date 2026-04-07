# Kokoro TTS Integration Design

## Overview

Kokoro 82M TTS를 GPU Manager에 통합하여 기존 Qwen3-TTS 대비 극적으로 빠른 음성 합성을 제공한다. 82M 파라미터로 GPU에서 210x 실시간 속도를 달성하며, 54개 프리셋 voicepack으로 음성을 선택한다. Voice cloning은 지원하지 않는 대신 속도에 집중.

## Architecture

```
VoiceSettings.tsx ── provider: "kokoro" ──→ tts-handler.ts
                                              ↓
                                     GPU Manager /tts/kokoro/synthesize
                                              ↓
                                     KokoroEngine (kokoro_engine.py)
                                              ↓
                                     GPU queue (serial, shared with ComfyUI/Qwen3)
```

Kokoro는 GPU Manager의 기존 serial queue를 통해 실행된다. 82M이라 VRAM 부담은 미미하지만 ComfyUI 이미지 생성과의 VRAM 충돌 방지를 위해 큐를 통과한다.

## Components

### 1. GPU Manager — kokoro_engine.py (NEW)

`KokoroEngine` 클래스. TTSEngine과 동일한 패턴:

- `load_model()`: kokoro 82M 모델 GPU 로드. 이미 로드 상태면 skip.
- `synthesize_batch(payload)`: 텍스트 청크 배치 → audio_base64 리스트 반환.
  - payload: `{ chunks: string[], voice: string, speed?: float }`
  - 반환: `[{ chunk_index, total, audio_base64 }, ...]`
- `force_unload()`: ComfyUI 작업 전 VRAM 해제.
- `unload_model()`: 종료 시 정리.
- Idle timeout (120s): TTSEngine과 동일.

voicepack 이름(예: `"af_heart"`)으로 음성 선택. `.pt` 파일 불필요.

### 2. GPU Manager — queue_manager.py

- `TaskType.KOKORO_TTS = "kokoro_tts"` 추가
- `TASK_TIMEOUTS[TaskType.KOKORO_TTS] = 60.0` (82M이라 훨씬 빠르므로 1분이면 충분)

### 3. GPU Manager — server.py

- `KOKORO_AVAILABLE` 체크: `try: import kokoro`
- Handler 등록: `queue.register_handler(TaskType.KOKORO_TTS, kokoro_engine.synthesize_batch)`
- `POST /tts/kokoro/synthesize` 엔드포인트:
  - body: `{ chunks, voice, speed? }`
  - 응답: NDJSON 스트리밍 (기존 `/tts/synthesize`와 동일 형태)
- `GET /health`에 `kokoro_available` 필드 추가
- `GET /status`에 `kokoro_model_loaded` 필드 추가
- ComfyUI 핸들러(`_handle_comfyui`)에서 kokoro_engine도 force_unload

### 4. Node.js — session-manager.ts

VoiceConfig 타입 확장:
```typescript
ttsProvider?: "comfyui" | "edge" | "local" | "kokoro";
kokoroVoice?: string;   // voicepack name, e.g. "af_heart"
kokoroSpeed?: number;   // speed multiplier, default 1.0
```

### 5. Node.js — tts-handler.ts

`handleChatTts()`에 `provider === "kokoro"` 분기 추가:
- `synthesizeViaKokoro(chunks, voice, speed?)` 함수 신규
- GPU Manager `POST /tts/kokoro/synthesize` 호출
- 응답 파싱 및 오디오 파일 저장은 기존 comfyui 분기와 동일

`handleVoiceGeneratePost()`의 test 모드에도 kokoro 분기 추가.

### 6. Node.js — API route (tts-status)

`/api/setup/tts-status` 응답에 `kokoroAvailable` 필드 추가.

### 7. Frontend — VoiceSettings.tsx

Provider 선택기 2버튼 → 3버튼:
```
[ ⚡ Edge TTS ] [ 🐱 Kokoro ] [ 🎛 ComfyUI ]
```

Kokoro 선택 시 표시:
- **Voice 드롭다운**: 언어별 voicepack 리스트 (kokoro 라이브러리에서 사용 가능한 한국어 voice 목록)
- **Speed 슬라이더**: 0.5 ~ 2.0 (기본 1.0)
- Reference Audio, Voice Design, Model Size, .pt 생성 등은 숨김

`kokoroAvailable` 상태 추가: tts-status API에서 확인, 미설치 시 비활성화.

설명 텍스트: "초고속 로컬 TTS — 프리셋 음성 (GPU 210x 실시간)"

## Data Flow

### Chat TTS
```
1. User message → frontend triggers POST /api/tts/chat
2. tts-handler.ts: provider="kokoro"
   → POST GPU_MANAGER/tts/kokoro/synthesize { chunks, voice: "af_heart" }
3. GPU Manager queue → KokoroEngine.synthesize_batch()
   → load model if needed → batch synthesize → NDJSON response
4. tts-handler.ts: save audio files → WS broadcast "audio:ready"
5. Frontend: auto-play audio chunks
```

### Test TTS
```
1. VoiceSettings: "Play" button → POST /api/personas/:name/voice/generate { mode: "test" }
2. tts-handler.ts: provider="kokoro" → single chunk via GPU Manager
3. Return audio URL → frontend plays
```

## Voice Config Example (voice.json)

```json
{
  "enabled": true,
  "ttsProvider": "kokoro",
  "kokoroVoice": "af_heart",
  "kokoroSpeed": 1.0,
  "language": "ko",
  "chunkDelay": 200
}
```

## Installation

`gpu-manager/requirements-kokoro.txt`:
```
kokoro>=0.9.2
soundfile
```

설치: `gpu-manager/venv/Scripts/pip install -r requirements-kokoro.txt`

## Not In Scope

- Voice cloning/design (Kokoro는 프리셋만 지원)
- Kokoro voicepack 커스텀 학습
- Kokoro와 Qwen3 동시 로드 (serial queue로 하나씩)
