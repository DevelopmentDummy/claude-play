# GPU Resource Manager — Design Spec

**Date**: 2026-03-14
**Status**: Approved

## Overview

Bridge에 내장된 Python child process로, 단일 직렬 큐를 통해 GPU 리소스를 관리한다. ComfyUI 이미지 생성 프록시 + Qwen3-TTS 직접 추론(CUDA Graph 최적화)을 담당한다.

### Goals

1. ComfyUI 이미지 생성과 TTS를 단일 큐로 관리하여 VRAM 충돌 방지
2. Qwen3-TTS를 ComfyUI 노드 대신 직접 추론하여 속도 개선
3. CUDA Graph로 디코딩 루프 최적화
4. `.pt` 음성 임베딩 생성도 직접 처리 (ComfyUI TTS 의존 완전 제거)

### Non-Goals

- Edge TTS 변경 (기존 `tts-server.mjs` 유지)
- ComfyUI 자체 교체 (이미지 생성은 여전히 ComfyUI가 처리)
- 다중 GPU 지원

---

## Architecture

```
Bridge (server.ts)
  ├── spawn("python", ["gpu-manager/server.py"])  ← 자동 시작
  │
  ├── 이미지 생성 요청 ──┐
  │                       ↓
  │           GPU Manager (FastAPI, port 3342)
  │             ├── 직렬 큐 (asyncio.Queue, 한 번에 하나만 실행)
  │             │
  ├── TTS 요청 ─┤   ┌─ 이미지: ComfyUI HTTP API 프록시
  │             │   │  (POST /prompt → poll /history → download /view)
  │             ├───┤
  │             │   └─ TTS: Qwen3-TTS 직접 추론
  │             │      (CUDA Graph, on-demand 모델 로딩/언로딩)
  │             │
  └── Edge TTS  └── .pt 생성: Qwen3-TTS로 직접 처리
      (port 3341, 기존 유지)
```

### Request Flow

1. Bridge가 GPU Manager에 HTTP 요청
2. GPU Manager가 직렬 큐에 등록
3. 큐 worker가 순차 처리:
   - 이미지 → ComfyUI API로 전달, 폴링, 결과 다운로드 후 반환
   - TTS → Qwen3-TTS 모델 로딩(필요 시), CUDA Graph 추론, MP3 인코딩 후 반환
   - voice 생성 → Qwen3-TTS 로딩, 임베딩 추출, `.pt` 저장 후 반환
4. 완료 시 TTS 모델 언로딩 (on-demand)

---

## GPU Manager Server

### Tech Stack

- Python 3.10+
- FastAPI + uvicorn
- PyTorch + transformers (Qwen3-TTS)
- torch.cuda.CUDAGraph
- httpx (ComfyUI 프록시)
- soundfile / pydub (오디오 인코딩)

### Directory Structure

```
gpu-manager/
├── server.py           # FastAPI 앱 + 큐 worker
├── comfyui_proxy.py    # ComfyUI HTTP API 프록시 로직
├── tts_engine.py       # Qwen3-TTS 추론 엔진 (CUDA Graph)
├── voice_creator.py    # .pt 음성 임베딩 생성
├── queue_manager.py    # 직렬 큐 관리
└── requirements.txt    # Python 의존성
```

### API Endpoints

#### `POST /comfyui/generate`

ComfyUI 이미지 생성 프록시. 기존 `comfyui-client.ts`의 요청을 그대로 받아 큐잉 후 ComfyUI에 전달.

**Request:**
```json
{
  "prompt": { ... },
  "timeout": 600000
}
```

**Response:**
```json
{
  "prompt_id": "uuid",
  "filenames": ["filename1.png", "filename2.png"],
  "history": { ... }
}
```

**동작:**
1. 큐에 등록, 순서 대기
2. ComfyUI `POST /prompt`로 전달
3. `GET /history/{prompt_id}` 폴링 (기존 `pollHistory` 로직)
4. 결과 파일명 추출 후 반환 (파일 다운로드는 Bridge가 직접 ComfyUI에서)

> **Note**: 파일 다운로드(`GET /view`)는 GPU를 사용하지 않으므로 큐를 거치지 않고 Bridge가 ComfyUI에 직접 요청해도 무방. GPU Manager는 prompt 제출 + 완료 확인만 담당.

#### `POST /tts/synthesize`

TTS 추론. 여러 청크를 배치로 받아 NDJSON 스트리밍으로 청크별 MP3를 반환.

**Request:**
```json
{
  "chunks": ["첫째 줄 텍스트", "둘째 줄 텍스트", "셋째 줄"],
  "voice_file": "/absolute/path/to/voice.pt",
  "language": "ko",
  "model_size": "1.7B",
  "max_new_tokens": 2048,
  "repetition_penalty": 1.2
}
```

**Response:** NDJSON 스트리밍 (`application/x-ndjson`)
```jsonl
{"chunk_index": 0, "total": 3, "audio_base64": "...base64 mp3..."}
{"chunk_index": 1, "total": 3, "audio_base64": "...base64 mp3..."}
{"chunk_index": 2, "total": 3, "audio_base64": "...base64 mp3..."}
```

**동작:**
1. 큐에 하나의 배치 작업으로 등록, 순서 대기
2. 모델 미로딩 시 Qwen3-TTS 로딩 (+ CUDA Graph 캡처, Phase 2b 시)
3. `.pt` 파일에서 voice embedding 로딩
4. 청크별 순차 추론, 각 청크 완료 시 즉시 NDJSON line 전송
5. 전체 완료 후 30초 idle timeout 시작 (새 요청 없으면 모델 언로딩)

#### `POST /tts/create-voice`

`.pt` 음성 임베딩 생성.

**Request (voice design):**
```json
{
  "mode": "design",
  "design_prompt": "A bright, playful young woman...",
  "language": "ko",
  "model_size": "1.7B",
  "output_path": "/absolute/path/to/voice/name.pt"
}
```

**Request (reference audio):**
```json
{
  "mode": "reference",
  "reference_audio": "/absolute/path/to/voice-ref.mp3",
  "reference_text": "레퍼런스 오디오 대본",
  "language": "ko",
  "model_size": "1.7B",
  "output_path": "/absolute/path/to/voice/name.pt"
}
```

**Response:**
```json
{
  "success": true,
  "voice_file": "/absolute/path/to/voice/name.pt",
  "sample_audio": "<base64 encoded mp3>"
}
```

**동작:**
1. 큐에 등록, 순서 대기
2. Qwen3-TTS 모델 로딩
3. design mode: VoiceDesign으로 음성 생성 → 임베딩 추출 → `.pt` 저장
4. reference mode: 레퍼런스 오디오 분석 → 임베딩 추출 → `.pt` 저장
5. 샘플 오디오 생성하여 함께 반환
6. 모델 언로딩

#### `GET /status`

큐 상태 및 모델 로딩 상태 조회.

**Response:**
```json
{
  "queue_size": 2,
  "current_task": {
    "type": "tts",
    "started_at": "2026-03-14T10:30:00Z"
  },
  "model_loaded": false,
  "comfyui_connected": true
}
```

---

## Serial Queue

### Design

```python
class QueueManager:
    queue: asyncio.Queue[Task]
    current_task: Task | None

    async def submit(task: Task) -> Result:
        """큐에 등록하고 완료까지 대기"""
        future = asyncio.Future()
        await queue.put((task, future))
        return await future

    async def worker():
        """단일 worker — 한 번에 하나씩 처리"""
        while True:
            task, future = await queue.get()
            current_task = task
            try:
                result = await execute(task)
                future.set_result(result)
            except Exception as e:
                future.set_exception(e)
            finally:
                current_task = None
```

### Task Types

```python
@dataclass
class Task:
    type: Literal["comfyui", "tts", "create_voice"]
    payload: dict
    submitted_at: datetime
```

### Queue Behavior

- FIFO 순서
- 한 번에 하나만 실행
- 이미지 생성 중 TTS 요청 → 이미지 완료까지 대기
- 타임아웃: 이미지 10분, TTS 2분, voice 생성 5분
- 취소: 클라이언트 disconnect 시 현재 작업 취소 가능

### TTS Chunk Batching

Bridge의 `tts-handler.ts`는 텍스트를 줄 단위로 분할하여 청크별로 요청한다. 개별 청크를 별도 큐 항목으로 넣으면 중간에 이미지 요청이 끼어들 수 있다.

해결: `/tts/synthesize`가 **여러 청크를 하나의 배치로** 받는다:
```json
{
  "chunks": ["첫째 줄", "둘째 줄", "셋째 줄"],
  "voice_file": "...",
  "language": "ko",
  "model_size": "1.7B"
}
```
큐에는 하나의 TTS 배치 작업으로 등록되고, 청크별 MP3를 순차 생성하여 스트리밍 반환한다.

### Model Unloading Timeout

TTS 모델은 **30초 idle timeout**으로 관리한다:
- TTS 작업 완료 후 30초 동안 새 TTS 요청이 없으면 자동 언로딩
- 30초 내에 새 요청이 오면 타이머 리셋, 모델 재사용
- 이미지 생성 요청이 오면 즉시 TTS 모델 언로딩 후 이미지 작업 시작

---

## CUDA Graph TTS Engine

### Model Loading (On-Demand)

```python
class TTSEngine:
    model: Qwen3TTSModel | None = None
    graph: torch.cuda.CUDAGraph | None = None

    async def load_model(model_size: str = "1.7B"):
        """모델 로딩 + CUDA Graph warmup"""
        model = Qwen3TTS.from_pretrained(model_path)
        model.to("cuda")
        model.eval()

        # CUDA Graph capture
        _warmup_and_capture_graph()

    async def unload_model():
        """VRAM 해제"""
        del model, graph
        torch.cuda.empty_cache()
```

### CUDA Graph Capture

```python
def _warmup_and_capture_graph():
    """고정 크기 입력으로 CUDA Graph 캡처"""
    # Warmup runs (GPU 커널 초기화)
    for _ in range(3):
        with torch.no_grad():
            model.decode(warmup_input)

    # Graph capture
    graph = torch.cuda.CUDAGraph()
    with torch.cuda.graph(graph):
        static_output = model.decode(static_input)

    # 이후 추론은 static_input에 데이터 복사 후 graph.replay()
```

### Inference Flow

```python
async def synthesize(text: str, voice_pt: str, language: str) -> bytes:
    """텍스트 → MP3 바이너리"""
    # 1. Voice embedding 로딩
    voice = torch.load(voice_pt)

    # 2. 텍스트 토큰화
    tokens = tokenizer.encode(text, language=language)

    # 3. CUDA Graph replay로 디코딩
    # (고정 크기 버퍼에 입력 복사 → replay → 출력 추출)
    audio_tensor = decode_with_graph(tokens, voice)

    # 4. MP3 인코딩
    mp3_bytes = encode_mp3(audio_tensor, sample_rate=24000)

    return mp3_bytes
```

### CUDA Graph Strategy

CUDA Graph는 autoregressive 모델에서 제약이 있다 (가변 길이 디코딩, 동적 control flow). 따라서 **2단계 접근**:

1. **Phase 2a (기본 추론)**: `torch.no_grad()` + `torch.inference_mode()`로 직접 추론. ComfyUI 오버헤드 제거만으로도 상당한 개선 예상
2. **Phase 2b (CUDA Graph 최적화)**: Qwen3-TTS 모델 구조 분석 후 캡처 가능한 부분 식별. 전체 디코딩 루프가 불가능하면 개별 transformer block 단위로 캡처

Phase 2a가 기본 동작이고, CUDA Graph는 검증 후 적용하는 선택적 최적화로 취급한다.

### Model Size Switching

`model_size`는 요청마다 다를 수 있다 (`"0.6B"` / `"1.7B"`). 동시에 두 모델을 로딩할 VRAM 여유는 없으므로:

- 현재 로딩된 모델과 요청된 `model_size`가 다르면 → 언로딩 후 재로딩
- 같으면 → 재사용
- 모델 전환 시 CUDA Graph 재캡처 필요 (Phase 2b 적용 시)
- 전환 오버헤드: ~10-30초 (모델 크기에 따라)

---

## ComfyUI Proxy

### Proxy Logic

```python
class ComfyUIProxy:
    comfyui_url: str  # from COMFYUI_URL env

    async def generate(prompt: dict, timeout: int) -> dict:
        """ComfyUI에 프롬프트 제출 → 폴링 → 결과 반환"""
        # 1. Submit
        resp = await httpx.post(f"{comfyui_url}/prompt", json={"prompt": prompt})
        prompt_id = resp.json()["prompt_id"]

        # 2. Poll history
        result = await poll_history(prompt_id, timeout)

        # 3. Extract filenames
        filenames = extract_filenames(result)

        return {"prompt_id": prompt_id, "filenames": filenames, "history": result}

    async def poll_history(prompt_id: str, timeout: int) -> dict:
        """폴링 with exponential backoff"""
        deadline = time.time() + timeout / 1000
        delay = 0.5
        while time.time() < deadline:
            resp = await httpx.get(f"{comfyui_url}/history/{prompt_id}")
            data = resp.json()
            if prompt_id in data:
                return data[prompt_id]
            await asyncio.sleep(delay)
            delay = min(delay * 1.5, 5.0)
        raise TimeoutError(f"ComfyUI prompt {prompt_id} timed out")
```

### File Downloads

파일 다운로드(`GET /view`)는 GPU를 사용하지 않으므로 Bridge의 `comfyui-client.ts`에서 ComfyUI에 직접 요청. GPU Manager를 거치지 않음.

---

## Process Lifecycle

### Startup

```typescript
// server.ts
const gpuManager = spawn("python", [
  path.join(appRoot, "gpu-manager", "server.py"),
  "--port", String(GPU_MANAGER_PORT),
  "--comfyui-url", COMFYUI_URL,
], { stdio: ["ignore", "pipe", "pipe"] });
```

- `server.ts`에서 `app.prepare()` 후 spawn
- stdout/stderr 로그를 Bridge 콘솔에 파이프
- `GET /health` 폴링으로 준비 완료 감지 (최대 30초, 1초 간격)
- 실패 시 경고 로그 + GPU 기능 비활성화 (Bridge 자체는 정상 동작)

### Health Check

`GET /health` → `200 { "ready": true }` (서버 초기화 완료, 요청 수락 가능)

`GET /status`는 상세 정보용 (큐 상태, 모델 로딩 상태, ComfyUI 연결 상태)

### Shutdown

- Bridge 종료 시 GPU Manager 프로세스에 SIGTERM 전송
- Windows: `taskkill /T /F /PID` (기존 TTS 서버와 동일 패턴)
- GPU Manager는 SIGTERM 수신 시 현재 작업 완료 후 graceful shutdown (5초 타임아웃)

### Crash Recovery

- `gpuManager.on("exit")` 감지
- 자동 재시작 (최대 3회, 10초 backoff)
- 재시작 실패 시 GPU 기능 비활성화 + Bridge 로그 경고

### Python Environment

- GPU Manager는 시스템 Python 또는 venv 사용
- `GPU_MANAGER_PYTHON` 환경변수로 Python 경로 지정 가능 (기본: `python`)
- 서버 시작 시 필수 패키지 import 검증, 실패 시 즉시 exit + 에러 메시지
- `requirements.txt`는 수동 설치 (`pip install -r gpu-manager/requirements.txt`)

---

## Bridge Integration Changes

### comfyui-client.ts 변경

기존: Bridge → ComfyUI (`POST /prompt`, `GET /history`, `GET /view`)
변경: Bridge → GPU Manager (`POST /comfyui/generate`) → ComfyUI

- `generate()` 메서드: prompt 구성은 기존대로, 제출만 GPU Manager 경유
- `downloadImage()`: ComfyUI 직접 호출 유지 (GPU 불필요)
- `reconcileQueueBeforeSubmit()`: GPU Manager가 관리하므로 제거 가능

### tts-handler.ts 변경

기존 ComfyUI TTS 경로:
```
handleTtsRequest → buildComfyUIPrompt → ComfyUI POST /prompt → poll → download
```

변경:
```
handleTtsRequest → GPU Manager POST /tts/synthesize → MP3 바이너리 수신 → 파일 저장
```

- ComfyUI TTS 워크플로 빌드 로직 제거
- GPU Manager `/tts/synthesize` 호출로 대체
- `.pt` 생성: GPU Manager `/tts/create-voice` 호출로 대체

### voice.json `ttsProvider` 변경

기존 `"comfyui"` → `"local"` 로 변경. `"comfyui"`는 하위 호환으로 `"local"`과 동일 취급.

```json
{
  "ttsProvider": "local"
}
```

- `"edge"`: Edge TTS (기존 유지)
- `"local"`: GPU Manager 직접 추론 (기존 `"comfyui"` 대체)
- `"comfyui"`: `"local"` 별칭 (하위 호환)

### 환경변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `GPU_MANAGER_PORT` | 3342 | GPU Manager 서버 포트 |
| `GPU_MANAGER_PYTHON` | `python` | Python 실행 경로 |
| `COMFYUI_HOST` | `127.0.0.1` | ComfyUI 호스트 (기존 유지) |
| `COMFYUI_PORT` | `8188` | ComfyUI 포트 (기존 유지) |
| `TTS_MODEL_PATH` | (auto-detect) | Qwen3-TTS 모델 경로 |
| `TTS_PORT` | 3341 | Edge TTS 서버 (기존 유지) |
| `TTS_ENABLED` | `true` | TTS 전역 활성화 |

---

## Error Handling

| 에러 | 처리 |
|------|------|
| GPU Manager 시작 실패 | Bridge 로그에 경고, TTS/이미지 요청 시 503 반환 |
| ComfyUI 연결 불가 | 이미지 요청 시 503, TTS는 정상 동작 |
| TTS 모델 로딩 실패 | 500 + 에러 메시지 반환, 큐 다음 작업으로 진행 |
| CUDA Graph 캡처 실패 | fallback으로 일반 추론 사용 |
| 큐 타임아웃 | 현재 작업 취소, 클라이언트에 408 반환 |
| OOM | 모델 언로딩 + `torch.cuda.empty_cache()` 후 재시도 |

---

## Migration Plan

### Phase 1: GPU Manager 서버 구현
- Python FastAPI 서버 기본 구조
- 직렬 큐 매니저
- ComfyUI 프록시 (이미지 생성)

### Phase 2a: TTS 엔진 기본 추론
- Qwen3-TTS 직접 로딩/추론 (`torch.no_grad()`)
- on-demand 로딩/언로딩 (30초 idle timeout)
- model size switching
- `.pt` 음성 임베딩 생성
- 청크 배치 NDJSON 스트리밍

### Phase 2b: CUDA Graph 최적화 (선택)
- Qwen3-TTS 모델 구조 분석
- 캡처 가능한 부분 식별 및 적용
- 불가 시 Phase 2a 기본 추론으로 유지

### Phase 3: Bridge 통합
- `server.ts` — GPU Manager spawn 로직
- `comfyui-client.ts` — 이미지 생성 프록시 경유
- `tts-handler.ts` — ComfyUI TTS → GPU Manager 전환

### Phase 4: 정리
- ComfyUI TTS 관련 코드 제거 (워크플로 빌드, AILab 노드 참조)
- `comfyui-client.ts`의 큐 관리 로직 단순화
