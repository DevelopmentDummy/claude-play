---
name: generate-image-gemini
description: Google Gemini API 이미지 생성. ⚠️ 사용자가 이 백엔드를 명시적으로 지정했을 때만 사용한다(예 "제미니로 그려줘"). 기본 이미지 생성은 generate-image(ComfyUI)이며, 사용자가 콕 집어 요청하지 않았다면 절대 Gemini를 자동으로 선택하지 마라.
allowed-tools: Bash, Read, Write
---

# 이미지 생성 (Gemini)

Google Gemini의 네이티브 이미지 생성 기능을 사용한다. 자연어 프롬프트로 이미지를 생성하며, Danbooru 태그 대신 서술형 영어 프롬프트를 사용한다.

## ⚠️ 사용 조건 — 명시적 요청 전용

**이 스킬은 사용자가 Gemini 이미지 생성을 콕 집어 지정했을 때만 사용한다.** (예: "제미니로 그려줘", "Gemini로 배경 만들어줘")

- 그 외 모든 이미지 생성(캐릭터, 장면, 패널 배경, 아이콘, 컨셉 아트 등)의 **기본 백엔드는 generate-image(ComfyUI)**다.
- 사용자가 백엔드를 지정하지 않았다면 **절대 Gemini를 자동으로 고르지 마라.** ComfyUI로 생성하라.
- ComfyUI를 쓸 수 없는 환경이더라도 자동 폴백하지 말고, **먼저 "Gemini로 생성할까요?"라고 물어본 뒤** 사용자가 동의하면 사용한다.

아래는 사용자가 명시적으로 Gemini를 요청했을 때를 위한 참고 사항이다. Gemini는 서술형 자연어 프롬프트에 강하고 범용 디자인 리소스(배경/텍스처/아이콘) 생성에 적합하다.

## 절차

### 1단계: 프롬프트 구성

**영어 서술형 프롬프트**를 작성한다. Danbooru 태그가 아닌 자연어로 원하는 이미지를 묘사한다.

좋은 프롬프트 예시:
```
A dark fantasy tavern interior with warm candlelight, wooden tables and barrels, stone walls covered in ivy, atmospheric fog, medieval aesthetic, digital painting style
```

```
A small pixel-art style icon of a golden key with a glowing aura, transparent background, game UI asset
```

```
An elegant watercolor portrait of a young woman with silver hair and blue eyes, wearing a white Victorian dress, soft lighting, dreamy atmosphere
```

### 2단계: API 호출

**빌더 세션** (persona 파라미터 필수):
```bash
cat > /tmp/gemini-req.json << 'REQEOF'
{
  "prompt": "A dark fantasy tavern interior with warm candlelight, wooden tables, stone walls, atmospheric, digital painting",
  "filename": "tavern-bg.png",
  "persona": "캐릭터이름"
}
REQEOF
curl -s -X POST "http://localhost:{{PORT}}/api/tools/gemini/generate" \
  -H "Content-Type: application/json" \
  -d @/tmp/gemini-req.json
```

**대화 세션** (활성 세션에 자동 저장):
```bash
curl -s -X POST "http://localhost:{{PORT}}/api/tools/gemini/generate" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"A moonlit forest path with fireflies, ethereal atmosphere","filename":"forest-night.png"}'
```

### 3단계: 응답에 이미지 삽입

`<dialog_response>` 안에 `$IMAGE:images/파일명.png$` 토큰을 포함한다.
이미지는 비동기 생성되므로 사용자 화면에서 로딩 스피너 → 완성 후 자동 교체.

---

## 활용 예시

### 패널 배경 이미지
```json
{"prompt": "Dark blue gradient texture with subtle starfield pattern, seamless, UI background", "filename": "panel-bg.png"}
```

### 장소 아이콘
```json
{"prompt": "A simple icon of a medieval castle tower, flat design, dark background, game UI style", "filename": "location-castle.png"}
```

### 장면 삽화
```json
{"prompt": "Two people sitting across from each other at a candlelit cafe table, warm atmosphere, anime illustration style, soft lighting", "filename": "cafe-scene.png"}
```

### 아이템 이미지
```json
{"prompt": "A glowing magical sword with blue runes on the blade, dark background, fantasy game item illustration", "filename": "magic-sword.png"}
```

---

## 규칙

- **⚠ Gemini 이미지 생성은 유료 API다. 호출을 최소화하라.**
  - 한번 생성한 이미지는 반드시 재사용한다 (`$IMAGE:images/filename.png$`)
  - 비슷한 이미지를 반복 생성하지 마라
  - 사용자가 명시적으로 요청하거나, 서사적으로 꼭 필요한 경우에만 생성한다
  - 재사용 가능한 리소스(배경, 아이콘 등)는 빌더 단계에서 미리 만들어 두라
- prompt는 **반드시 영어**로 작성한다
- filename은 영문 kebab-case `.png` (예: `tavern-bg.png`)
- persona 이름에 한글이 포함되면 heredoc + `@파일` 방식을 사용하라 (curl 인코딩 이슈 방지)
- Gemini는 콘텐츠 필터가 있을 수 있다. 거부당하면 프롬프트를 조정하라
