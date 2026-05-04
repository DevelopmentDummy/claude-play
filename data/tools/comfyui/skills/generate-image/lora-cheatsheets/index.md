# LoRA 치트시트 인덱스

이 디렉토리는 **베이스 모델별 LoRA 운용 규칙**을 분리해서 관리한다.

## 기본 원칙

- 치트시트는 **모델별로 분리**한다.
- 하나의 LoRA가 여러 베이스에서 보이더라도 **권장 강도, 트리거, 부작용 메모는 베이스별로 따로 기록**한다.
- 이미지 생성 시에는 현재 워크플로우/체크포인트/텍스트 인코더 조합에 맞는 치트시트를 먼저 고른다.
- 새 LoRA를 추가하면 공통 문서 하나에 몰아넣지 말고 **해당 베이스 문서에만 기록**한다.

## 어떤 파일을 먼저 볼까 (Manifest + Full 2-stage)

LoRA 룩업은 **2단계**다. 매번 풀 마크다운(35KB)을 통째로 읽지 마라.

**1차 (매니페스트, 항상 여기부터):**
- `illustrious.manifest.txt` — Illustrious/SDXL anime 워크플로우 (`portrait`/`scene`/`scene-real`/`scene-couple`/`profile`)
- `anima.manifest.txt` — Anima 계열 워크플로우 (`anima-mixed-scene`)
- `qwen-image.manifest.txt` — Qwen-Image 워크플로우

활성 워크플로의 매니페스트 **한 개만** 로드한다. 모델 간 LoRA 비호환.

매니페스트 한 줄 포맷: `파일명 [카테고리,플래그(,auto-trig)] 짧은 용도 │ 강도 [│ trig?: 후보 태그]`

- `auto-trig` 플래그 — `lora-triggers.json`의 `auto` 토큰이 등록되어 서버가 자동 주입. 토큰 값은 매니페스트에 안 적힘 (중복 제거).
- `trig?:` — `lora-triggers.json`의 `options` 필드 후보 토큰. **자동 주입 안 됨**, 매번 사용자가 골라 직접 박을 것.
- 둘 다 있으면 — auto는 자동, options는 선택. 가장 일반적인 분리 패턴.
- 둘 다 없으면 — 트리거 미등록.

분류는 `lora-triggers.json`의 명시적 객체 스키마(`{auto, options}`)가 결정한다. 휴리스틱 없음.

**2차 (풀 노트, 디테일 필요 시 핀포인트 grep):**
- `anima.md` — 혼합형 프롬프트 (자연어 + 핵심 태그). baseLoras 정책, 운영 노트 포함
- `illustrious.md` — Danbooru 태그 우선. [BASE]/[NSFW-BASE] 체인 포함
- `qwen-image.md` — 문장형 지시 우선
- `anima.compat-log.md` — Anima 호환성 시점 기록 (참조 빈도 낮음)

**갱신:** `.md` 수정 후 `node build-manifest.mjs` 실행. 모든 매니페스트 자동 재생성.

## 공통 기록 형식

각 항목은 가능하면 아래 필드를 유지한다.

- 이름
- 파일명
- 카테고리
- 권장 강도 범위
- 트리거 / 추천 프롬프트 방식
- 잘 맞는 워크플로우
- 부작용 / 주의점
- 테스트 메모

## 운영 규칙

- 기본 워크플로우 체인에 고정되는 LoRA와, 요청마다 동적으로 얹는 LoRA를 구분한다.
- 스타일 LoRA는 한 번에 1개를 우선한다.
- 품질 / 디테일 LoRA도 2개를 넘기기 전에 먼저 단일 효과를 확인한다.
- 포즈 / 구도 LoRA는 장면 요구가 명확할 때만 추가한다.
- 특정 신체 부위 / 특수 컨셉 LoRA는 범용 프리셋에 고정하지 않는다.

