# 임베딩·의미 검색 코어 (EmbeddingGemma 2) — 설계

2026-10-07. 브랜치 `feat/embedding-core`.

## 목표

여러 페르소나가 공통으로 쓸 수 있는 **로컬 임베딩 + 벡터 검색 인프라**를 코어에 둔다. 이번 범위는 인프라와 사용 지침까지다.
- 대표 활용처는 생성 이미지 재사용 검색, 긴 세션의 기억 회상(RAG), 참조 문서 조회다.
- 활용처별 자동화(이미지를 생성할 때마다 인덱싱하는 훅, 기억을 턴마다 자동 주입하는 기능)는 **범위 밖**이다. 지침 스킬에 패턴으로만 적는다.

모델은 Google `google/embeddinggemma-2`다(2026-10-06 공개, Apache 2.0, 740M, Gemma 4 기반).
- 텍스트, 이미지, 오디오, 영상을 한 768차원 공간에 넣는다.
- Matryoshka 방식으로 128, 256, 512 차원까지 잘라 쓸 수 있다.
- 컨텍스트는 8192 토큰이다.
- 이번에는 **텍스트와 이미지만** 연다.

## 실측 (RTX 5070 Ti 16GB, 2026-10-07)

| 항목 | 값 |
|---|---|
| 로드 | 10.5~12.8초 (HF 캐시가 있을 때) |
| VRAM | bf16 기준 상주 약 1.4GB, 피크 약 1.5GB (fp16은 모델이 지원하지 않음) |
| 쿼리 1건 | 약 0.05~0.1초 |
| 이미지 1장 | 약 0.1~0.2초 (6장 배치 0.45초) |
| 한글 쿼리→한글 문서 | 관련 0.88 / 무관 0.62 |
| 영어 쿼리→한글 문서 | 0.69로 정답 1위 |
| 텍스트→이미지 | 0.6대에 몰림 (순위만 유효) |
| 이미지→이미지 (같은 캐릭터) | 약 0.91 |

**의존성**
- transformers 5.19 이상이 필요하다. 5.8은 `embedding_gemma2`를 인식하지 못한다.
- torchvision이 필요하다. 없으면 프로세서 import가 실패한다.
- sentence-transformers 6.1에서 `encode([{ "image": path }])` 경로가 동작한다.
- 체크포인트의 `max_seq_length`는 쓰레기 값(약 1e30)이라 서버에서 2048로 고정한다.

## 원칙

- **별도 프로세스, 전용 venv.** GPU Manager 환경은 qwen-tts/qwen-asr 때문에 `transformers==4.57.x`로 정확히 핀돼 있다(playbook §5.10). EmbeddingGemma 2는 5.19 이상이 필요해서 한 인터프리터에 공존할 수 없다(playbook §5.19). 그래서 `gpu-manager/venv-embed`에서 `embed_server.py`를 띄우고, server.ts가 TTS나 GPU Manager처럼 자식 프로세스로 관리한다.
- **선택 기능.** venv-embed가 없으면 spawn을 건너뛰고, 모든 호출은 503을 받는다. 서비스 기동은 막지 않는다.
- **VRAM 예의.** 모델은 첫 요청 때 로드하고, `EMBED_IDLE_TIMEOUT`(기본 300초) 동안 쓰지 않으면 내린다. GPU 직렬 큐는 거치지 않는다. ASR과 같은 이유로, 짧고 사용자가 기다리는 작업이기 때문이다. ComfyUI와는 ASR처럼 공존한다.
- **공간 혼합 금지.** 컬렉션 헤더에 `model`과 `dim`을 기록하고, 다르면 추가와 검색을 모두 409로 거부한다.
- **경로 샌드박스.** 이미지와 파일 경로는 스코프 폴더 기준 상대 경로로 받고, `data/` 밖으로 나가면 400을 돌려준다. 임베딩 서버에는 Node가 검증한 절대 경로만 넘긴다.

## 구성요소

### 1. `gpu-manager/embed_server.py` (FastAPI, 포트 PORT+3 = 3343)
- `GET /health`
- `POST /embed {inputs: [{text}|{image: 절대경로}], task?, dim?}` → `{model, dim, vectors}`
  - 벡터는 L2 정규화돼 있다.
  - 요청당 최대 64개다.
  - task 프롬프트는 텍스트에만 붙는다.
  - 차원을 자른 뒤 다시 정규화한다.
- `POST /warmup`: 기다리지 않고 로드만 시작한다.
- `POST /unload`
- 의존성은 `requirements-embed.txt`에 있다.

### 2. `server.ts`
- `spawnEmbedServer()`를 추가했다. `EMBED_ENABLED`, `EMBED_PORT`, `EMBED_PYTHON`을 읽는다.
- venv-embed가 없으면 건너뛴다. 헬스 대기는 하지 않는다(기동을 막지 않음).
- hot-reload 시 kill과 포트 정리를 한다. `dev:lite`는 `EMBED_ENABLED=false`다.

### 3. `src/lib/embedding-client.ts`
- `embed(inputs, {task, dim})`: 64개 넘으면 나눠 보내고 순서를 유지한다.
- 오류는 `EmbedError(status)`로 낸다. 서버가 없으면 503, 시간 초과는 504, 형식 오류는 400·502다.
- `warmupEmbedder()`

### 4. `src/lib/vector-store.ts`
- 파일 기반 컬렉션 `{baseDir}/vectors/{name}.json`이다. 벡터는 float32 base64로 저장한다.
- 쓰기는 원자적이다(tmp→rename). 같은 파일에 대한 작업은 프로세스 안에서 직렬화한다(`withCollectionLock`).
- 검색은 내적 기반이다(정규화된 벡터라 코사인과 같다). topK, minScore, meta 일치 filter, modality, dedupeBySource를 지원한다.
- `chunkText()`: 제목(#)과 문단 경계로 자르고 `[제목]`을 접두로 붙인다.

### 5. `src/lib/vector-index.ts`: `runVectorAction(ctx, action, params)`
- 액션은 `warmup`, `embed`, `upsert`, `search`, `delete`, `list`, `info`, `drop`, `index_dir`, `index_file`이다.
- 스코프:
  - `session`: 세션 폴더
  - `persona`: 페르소나 폴더
  - `global`: `data/`
  - 컬렉션 파일은 각 스코프의 `vectors/` 아래에 둔다. 전역은 `data/vectors/`이고 gitignore에 넣었다.
- `index_dir`
  - 이미지를 증분 인덱싱한다. mtime이 같으면 건너뛰고, 사라진 파일은 prune한다.
  - 한 번에 `limit`(기본 200)장까지 처리하고 `remaining`을 돌려준다.
  - `_`로 시작하는 파일은 건너뛴다.
- `index_file`
  - 파일을 청킹해서 그 source의 조각을 통째로 교체한다. mtime이 같으면 건너뛴다.

### 6. 소비 경로 네 가지
- HTTP `POST /api/sessions/[id]/vectors {action, ...}`. 본문 최대 2MB.
- MCP: `vector_search`, `vector_upsert`, `vector_manage`. 세션 전용이고, 빌더 모드에서는 오류를 낸다.
- 페르소나 도구: `context.vectors(action, params)`. lib를 직접 호출한다.
- 패널: `__panelBridge.vectors(action, params)`

### 7. 지침: 공용 스킬 `data/skills/embedding/SKILL.md`
- 언제 쓰는지, 호출 경로 네 가지, 스코프, 활용 패턴 네 가지(이미지 재사용, 기억 RAG, 참조 문서, 도구·패널)를 다룬다.
- 컬렉션 설계 규칙, 점수 읽는 법(모달 간 척도 차이), task 프롬프트, 실패 처리도 담았다.
- 세션 Open 시 `refreshToolSkills`가 모든 세션에 전파한다.

## 설치

- `setup.js`에 Step 6b(선택, 기본 N)를 추가했다. 이 단계는 다음 순서로 진행한다.
  1. venv-embed를 만든다.
  2. CUDA 인덱스에서 torch와 torchvision을 설치한다.
  3. `requirements-embed.txt`를 설치한다.
- 이 머신에서는 수동으로 설치했다. torch 2.7.0+cu128, torchvision 0.22.0+cu128, transformers 5.19.0, sentence-transformers 6.1.0이다.

## 테스트

- `src/lib/vector-store.test.ts` (9건)
- `src/lib/embedding-client.test.ts` (5건)
- 라이브 검증은 `scripts/smoke-embedding.ts`로 했다(`EMBED_PORT`로 대상 서버 지정). 임시 DATA_DIR에서 실제 서버로 index_file, 검색(한↔영), 필터, dim 충돌, index_dir 증분과 prune(같은 source의 캡션까지), 텍스트→이미지, 이미지→이미지, 경로 탈출 거부, list, drop을 확인했다.

## 범위 밖

- 오디오·영상 임베딩. 모델은 지원하지만 디코딩 의존성 검증이 끝나지 않았다.
- 이미지를 생성할 때 자동으로 인덱싱하는 훅, 기억을 턴마다 자동 주입하는 기능.
- ANN 인덱스. 선형 스캔으로 수만 건까지는 충분하다.
- 멀티 스코프 동시 검색.
- 외부 MCP(`/mcp/external`)에 노출하는 일.
