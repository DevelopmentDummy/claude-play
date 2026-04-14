# VoxCPM2 TTS Integration Design

## Summary

GPU Manager에 VoxCPM2 TTS 엔진을 추가하여 기존 Qwen3-TTS와 공존시킨다. `voice.json`의 `ttsProvider: "voxcpm"` 선택으로 전환. 보이스 파일은 provider별 별도 관리 (`persona.qwen.pt` / `persona.voxcpm.pt`).

## Motivation

- VoxCPM2는 오픈소스 TTS 최상위 품질 (48kHz, 30개 언어, Apache 2.0)
- 보이스 클로닝 3모드 지원 (Controllable / Ultimate / Voice Design)
- `pip install voxcpm`으로 설치 — ComfyUI 의존 없이 독립 동작
- Qwen3-TTS 대비 품질·다국어·기능 상위호환

## Architecture

```
voice.json (ttsProvider: "voxcpm")
  -> tts-handler.ts (payload에 provider 추가)
    -> GPU Manager /tts/synthesize (provider 필드로 분기)
      -> voxcpm_engine.py (VoxCPM2) 또는 tts_engine.py (Qwen3)
```

- 엔드포인트 변경 없음: `/tts/synthesize`, `/tts/create-voice` 그대로 사용
- GPU Manager 내부에서 payload의 `provider` 필드로 엔진 분기
- TaskType 변경 없음: `TTS`, `CREATE_VOICE` 그대로 사용

## Changed Files

### New Files

| File | Purpose |
|------|---------|
| `gpu-manager/voxcpm_engine.py` | VoxCPM2 모델 로드/추론/보이스 생성 엔진 |
| `gpu-manager/requirements-voxcpm.txt` | VoxCPM2 Python 의존성 |

### Modified Files

| File | Change |
|------|--------|
| `gpu-manager/server.py` | provider별 엔진 분기, VoxCPM availability 체크, 상호 배타 VRAM 관리 |
| `gpu-manager/voice_creator.py` | VoxCPM provider일 때 voxcpm_engine으로 위임 |
| `src/lib/tts-handler.ts` | synthesizeViaGpuManager payload에 `provider` 필드 추가 |

### Unchanged Files

| File | Reason |
|------|--------|
| `gpu-manager/queue_manager.py` | TaskType 그대로 사용 |
| `gpu-manager/tts_engine.py` | Qwen3 엔진 코드 그대로 유지 |
| `gpu-manager/comfyui_proxy.py` | 무관 |

## voxcpm_engine.py

TTSEngine과 동일한 인터페이스를 구현한다:

```python
class VoxCPMEngine:
    # TTSEngine과 동일한 인터페이스
    is_loaded: bool (property)
    loaded_size: str | None (property)
    async load_model(model_size: str = "2B") -> None
    async unload_model() -> None
    async synthesize_batch(payload: dict) -> list[dict]
    force_unload() -> None

    # Voice creation
    create_voice_controllable(ref_audio, language, output_path) -> dict
    create_voice_ultimate(ref_audio, ref_text, language, output_path) -> dict
    create_voice_design(design_prompt, language, output_path) -> dict
```

### Model Loading
- `pip install voxcpm`의 Python API 사용
- 모델 크기: "2B" (VoxCPM2), "0.6B" (VoxCPM1.5)
- on-demand 로드, idle timeout 120s 후 자동 unload
- VRAM ~8GB (2B 기준)

### synthesize_batch
- 입력: `{chunks, voice_file, language, provider: "voxcpm"}`
- voice_file: `.voxcpm.pt` 형식의 보이스 파일 경로
- 출력: `[{chunk_index, total, audio_base64}]` (기존과 동일)
- 48kHz 오디오 -> MP3 인코딩

### Voice Creation (3 modes)
- **Controllable**: ref_audio만 -> 음색 복제
- **Ultimate**: ref_audio + ref_text(정확한 대본) -> 음색/리듬/감정 재현
- **Design**: 자연어 설명 -> 새 목소리 생성 (ref_audio 불필요)
- 모든 모드의 결과를 `.voxcpm.pt`로 저장

## server.py Changes

### Provider Dispatch

```python
# /tts/synthesize handler
async def _handle_tts(payload: dict) -> list[dict]:
    provider = payload.get("provider", "qwen3")
    if provider == "voxcpm":
        # Qwen3 로드되어 있으면 먼저 unload
        tts_engine.force_unload()
        return await voxcpm_engine.synthesize_batch(payload)
    else:
        # VoxCPM 로드되어 있으면 먼저 unload
        voxcpm_engine.force_unload()
        return await tts_engine.synthesize_batch(payload)
```

### ComfyUI Handler Update

```python
async def _handle_comfyui(payload: dict) -> dict:
    tts_engine.force_unload()
    voxcpm_engine.force_unload()  # 추가
    return await comfyui.generate(payload)
```

### Health Endpoint

```python
@app.get("/health")
async def health() -> dict:
    return {
        "ready": True,
        "tts_available": TTS_AVAILABLE,
        "voxcpm_available": VOXCPM_AVAILABLE,
    }
```

## voice_creator.py Changes

VoxCPM provider일 때 voxcpm_engine의 voice creation 메서드로 위임:

```python
async def create_voice(self, payload: dict) -> dict:
    provider = payload.get("provider", "qwen3")
    if provider == "voxcpm":
        return await self._create_voice_voxcpm(payload)
    # ... 기존 Qwen3 로직
```

## tts-handler.ts Changes

### synthesizeViaGpuManager

payload에 `provider` 필드 추가:

```typescript
body: JSON.stringify({
  chunks,
  voice_file: voiceFile,
  language,
  model_size: modelSize,
  provider: provider === "voxcpm" ? "voxcpm" : "qwen3",
})
```

### Provider Detection

```typescript
const provider = voiceConfig.ttsProvider || "comfyui";
const isLocalTts = provider === "local" || provider === "comfyui" || provider === "voxcpm";
```

VoxCPM도 로컬 GPU TTS이므로 기존 로컬 TTS 경로를 타되, payload에 provider를 실어 보낸다.

### Voice File Path

```typescript
// provider별 voice file 경로
const voiceFile = voiceConfig.voiceFile
  ? path.join(sessionDir, voiceConfig.voiceFile)
  : undefined;
```

voice.json의 `voiceFile` 필드가 이미 provider별 파일을 가리키므로 (`voice/persona.voxcpm.pt` vs `voice/persona.qwen.pt`) 추가 로직 불필요.

## Voice File Management

### Naming Convention
- Qwen3: `voice/{name}.pt` (기존 호환)
- VoxCPM: `voice/{name}.voxcpm.pt`

### voice.json Example

```json
{
  "enabled": true,
  "ttsProvider": "voxcpm",
  "voiceFile": "voice/persona_name.voxcpm.pt",
  "language": "ko"
}
```

## VRAM Management

- Qwen3와 VoxCPM은 상호 배타: 한쪽 로드 전 다른 쪽 force_unload
- ComfyUI 이미지 생성 시 둘 다 force_unload
- Idle timeout 120s 동일 적용
- synthesis 진행 중 force_unload 스킵 (기존 lock 패턴)

## Requirements

### System
- CUDA >= 12.0
- Python >= 3.10, < 3.13
- VRAM >= 8GB (2B model)

### Python Package
```
# requirements-voxcpm.txt
voxcpm
```
