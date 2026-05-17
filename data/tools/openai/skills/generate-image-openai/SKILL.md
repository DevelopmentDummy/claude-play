---
name: generate-image-openai
description: OpenAI gpt-image-2 모델로 이미지를 생성한다. 프롬프트 충실도가 높고 텍스트 렌더링이 강한 모델이므로, 텍스트가 포함된 UI 리소스, 정밀한 구도가 필요한 장면 삽화, 컨셉 아트 제작에 우선 사용한다. 기존 이미지를 레퍼런스로 받아 편집/변형하는 모드도 지원한다.
allowed-tools: Bash, Read, Write
---

# 이미지 생성 (OpenAI gpt-image-2)

OpenAI의 `gpt-image-2` 모델로 이미지를 생성한다. 자연어 영어 프롬프트를 사용하며, 텍스트 렌더링·지시 충실도가 강점이다. 레퍼런스 이미지를 함께 보내면 `/v1/images/edits` 엔드포인트로 변형/편집이 가능하다.

## ComfyUI vs Gemini vs OpenAI 사용 구분

| 용도 | ComfyUI | Gemini | OpenAI |
|---|---|---|---|
| 캐릭터 일러스트 (LoRA 일관성) | **우선** | 대안 | 대안 |
| 패널 배경/텍스처/패턴 | - | **우선** | 가능 |
| UI 아이콘/뱃지/장식 | - | **우선** | 가능 |
| 텍스트가 포함된 리소스 (간판, 포스터, UI 라벨) | 어려움 | 보통 | **우선** |
| 정밀한 구도/지시 충실도가 중요한 장면 | 가능 | 보통 | **우선** |
| 기존 이미지 편집/변형 (referenceImage) | - | 제한적 | **전용 지원** |
| 컨셉 아트/분위기 참고 | - | 우선 | 우선 |

ComfyUI가 있으면 캐릭터 일러스트는 ComfyUI를 우선 쓴다 (LoRA/체크포인트로 스타일 락). Gemini는 범용 디자인 리소스에 강하다. OpenAI는 **프롬프트를 그대로 따르는 정밀도**와 **이미지 편집**이 필요한 경우에 쓴다.

## 절차

### 1단계: 프롬프트 구성

**영어 서술형 프롬프트**를 작성한다. Danbooru 태그 대신 자연어로 묘사한다. gpt-image-2는 긴 지시문을 잘 따른다.

좋은 프롬프트 예시:
```
A vintage wooden tavern sign hanging from a metal bracket. The sign reads "The Drunken Dragon" in gothic gold lettering, with a small painted dragon curling around the letters. Weathered wood texture, warm afternoon lighting, photorealistic.
```

```
A medieval scroll lying on a stone table, with the heading "ROYAL DECREE" written in elegant calligraphy in dark red ink, wax seal at the bottom, parchment texture, dramatic lighting, top-down view.
```

```
A character portrait split into four panels showing the same young woman with silver hair and blue eyes expressing: 1) joy, 2) anger, 3) sadness, 4) determination. Clean anime illustration style, consistent character design, neutral background.
```

### 2단계: API 호출

**저장 위치 결정 — 활성 세션에서는 `persona` 파라미터를 넘기지 마라.**

| 상황 | 권장 | 저장 위치 |
|---|---|---|
| 대화 세션 — 1회용 장면 | 둘 다 생략 | 활성 세션 dir |
| 대화 세션 — 영구 공유 자산 (definitions에서 참조) | `targetScope: "persona"` 단독 | 부모 페르소나 dir |
| 빌더 세션 (활성 세션 없음) | `persona: "<이름>"` 필수 | 명시한 페르소나 dir |

활성 세션에서 `persona`를 넘기면 라우팅이 빌더 모드로 잘못 해석돼 InlineImage가 이미지를 못 찾는다. 페르소나 공유 자산이 필요하면 `targetScope: "persona"`를 쓴다.

**빌더 세션** (persona 파라미터 필수):
```bash
cat > /tmp/openai-req.json << 'REQEOF'
{
  "prompt": "A vintage tavern sign reading 'The Drunken Dragon' in gothic gold lettering, weathered wood, warm lighting, photorealistic",
  "filename": "tavern-sign.png",
  "persona": "캐릭터이름"
}
REQEOF
curl -s -X POST "http://localhost:{{PORT}}/api/tools/openai/generate" \
  -H "Content-Type: application/json" \
  -d @/tmp/openai-req.json
```

**대화 세션** (활성 세션에 자동 저장):
```bash
curl -s -X POST "http://localhost:{{PORT}}/api/tools/openai/generate" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"A handwritten letter on cream paper, ink stains, vintage romantic atmosphere","filename":"love-letter.png"}'
```

**레퍼런스 이미지를 사용한 편집/변형** (`referenceImage` 필드):
```bash
cat > /tmp/openai-edit-req.json << 'REQEOF'
{
  "prompt": "Same character but now wearing a red winter coat and scarf, snowy background",
  "filename": "character-winter.png",
  "referenceImage": "images/character-base.png"
}
REQEOF
curl -s -X POST "http://localhost:{{PORT}}/api/tools/openai/generate" \
  -H "Content-Type: application/json" \
  -d @/tmp/openai-edit-req.json
```
`referenceImage`는 세션/페르소나 디렉토리 기준 상대 경로다. 이 필드가 있으면 자동으로 `/v1/images/edits` 엔드포인트로 라우팅된다.

**크기/품질 조정** (선택):
```json
{
  "prompt": "...",
  "filename": "scene.png",
  "size": "1024x1024",
  "quality": "high"
}
```
`size`: `"1024x1024"`, `"1024x1792"`, `"1792x1024"` 등 OpenAI 지원 값. `quality`: `"low"`, `"medium"`, `"high"` (생략 시 기본값).

### 3단계: 응답에 이미지 삽입

`<dialog_response>` 안에 `$IMAGE:images/파일명.png$` 토큰을 포함한다.
이미지는 비동기로 생성되므로 사용자 화면에서 로딩 스피너 → 완성 후 자동 교체된다.

---

## 활용 예시

### 텍스트가 포함된 UI 리소스
```json
{"prompt": "A wooden game UI button with the text 'START' carved into it, fantasy game style, glowing edges", "filename": "btn-start.png"}
```

### 정밀한 다중 패널 일러스트
```json
{"prompt": "A 3-panel comic strip: panel 1 shows a knight drawing his sword, panel 2 shows him charging at a dragon, panel 3 shows him standing victorious. Manga style, consistent character.", "filename": "battle-comic.png"}
```

### 기존 캐릭터 의상 변경 (편집)
```json
{"prompt": "Same character with the same face and hair, but now wearing formal ballroom attire", "filename": "character-ballroom.png", "referenceImage": "images/profile.png"}
```

### 텍스트가 포함된 장면 (편지, 메모, 간판 등)
```json
{"prompt": "A torn handwritten note on a wooden desk. The note reads 'Meet me at the old oak tree at midnight - L' in slanted blue ink. Soft natural light from a window.", "filename": "mystery-note.png"}
```

---

## 규칙

- **⚠ OpenAI 이미지 생성은 유료 API다. 호출을 최소화하라.**
  - 한번 생성한 이미지는 반드시 재사용한다 (`$IMAGE:images/filename.png$`)
  - 비슷한 이미지를 반복 생성하지 마라
  - 사용자가 명시적으로 요청하거나, 서사적으로 꼭 필요한 경우에만 생성한다
  - 재사용 가능한 리소스(배경, 아이콘, 캐릭터 변형)는 빌더 단계에서 미리 만들어 두라
- prompt는 **반드시 영어**로 작성한다. gpt-image-2는 영어 지시 충실도가 가장 높다
- filename은 영문 kebab-case `.png` (예: `tavern-sign.png`)
- persona 이름에 한글이 포함되면 heredoc + `@파일` 방식을 사용하라 (curl 인코딩 이슈 방지)
- `referenceImage`는 세션/페르소나 디렉토리 기준 **상대 경로**다. 절대 경로나 외부 URL은 거부된다
- OpenAI는 콘텐츠 정책이 있다. 거부당하면 프롬프트를 순화하거나 다른 백엔드(ComfyUI)로 우회하라
- `response_format` 파라미터는 사용하지 마라 (gpt-image-2는 거부한다. 기본 b64_json 반환)
- 환경변수 `OPENAI_IMAGE_MODEL`로 모델을 바꿀 수 있다 (기본: `gpt-image-2`)
