# Anima LoRA 치트시트

기준 날짜: 2026-04-14 (호환성 테스트 완료: seed 42424242, 1024x1024, steps 36, quality_preset standard)

## 프롬프트 운영 원칙

- Anima는 **자연어 본문 + 핵심 태그 보조**가 기본이다.
- 태그만 길게 나열하는 방식보다, 장면/동작/구도/손 위치 같은 **문장형 지시를 먼저** 쓰는 편이 안정적이다.
- 스타일 LoRA와 품질 LoRA를 동시에 많이 얹으면 과장되거나 지저분해질 수 있다.
- `anima-mixed-scene` 워크플로우를 우선 기준으로 삼는다.

## 카테고리별 권장 순서

1. 품질 보정 1개
2. 스타일 LoRA 1개
3. 필요할 때만 디테일러 / 특수 컨셉 LoRA 추가

## 상위 10개 다운로드 기준 정리

### 품질 / 범용 보정

#### Aesthetic Quality Modifiers - Masterpiece
- 파일명: `anima-preview2-masterpieces-e50.safetensors`
- 카테고리: 품질 보정
- 권장 강도: `0.35 ~ 0.8`
- 관찰된 트리거: `masterpiece`, `very aesthetic`
- 추천 시작값: `0.45`
- 파일 크기: 약 `136.7 MB`
- 공개일: `2026-03-20`
- 프롬프트 방식: 자연어 본문 유지, 핵심 품질 태그만 보조
- 잘 맞는 워크플로우: `anima-mixed-scene`
- 주의점: 강도를 올리면 화면이 과하게 다듬어지거나 질감이 인위적으로 보일 수 있음
- 테스트 메모: Anima 기본 결과의 마감 품질을 올리는 1순위 후보
- 상세 메모:
  - 제작자가 권장한 프롬프트 구조는 품질 키워드를 앞에 두고 본문을 이어 붙이는 형태
  - 설명상 `caption_mode = mixed`로 학습된 흔적이 보여서, Anima의 혼합형 프롬프트 전략과 잘 맞을 가능성이 높음
  - Preview 2 기반이라서 Preview 3 / 정식 베이스에서 반응 차이가 있을 수 있으므로 강도는 보수적으로 시작
  - 첫 비교는 단독 사용이 좋고, 다른 스타일 LoRA와 동시 사용은 2차 테스트로 미루기
- 링크: https://civitai.com/models/929497

#### Hentai Studio Quality Anima/illustriousXL/ZImageTurbo
- 파일명: `Hentai_Studio_Quality_Anima-step00001300.safetensors`
- 카테고리: 품질 보정
- 권장 강도: `0.3 ~ 0.65`
- 관찰된 트리거: `hentai_studio_quality`, `shiny skin`
- 추천 시작값: `0.4`
- 파일 크기: 약 `132.3 MB`
- 공개일: `2026-03-29`
- 프롬프트 방식: 장면 설명은 유지하고 디테일 보정용으로 얹기
- 잘 맞는 워크플로우: `anima-mixed-scene`
- 주의점: 다른 스타일 LoRA와 겹치면 톤이 과장될 수 있음
- 테스트 메모: 범용 품질 부스터로 비교 가치 높음
- 상세 메모:
  - 이름상 품질 부스터 성격이지만 실제로는 광택감과 표면 질감 쪽 개입도 있을 가능성이 큼
  - `shiny skin` 계열 흔적이 있어 피부 질감이 과하게 미끄러워질 수 있으니 인물 클로즈업에서 먼저 확인
  - 스타일 LoRA와 합쳤을 때 색감보다 질감이 먼저 무너지는지 체크할 것
- 링크: https://civitai.com/models/1459030

#### [Anima] R Tweaker Lora
- 파일명: `hinaAnima2_R_Tweaker_v3.safetensors`
- 카테고리: 렌더 성향 조정 / 품질 보정
- 권장 강도: `0.25 ~ 0.6`
- 관찰된 트리거: `young woman`, `asian woman`
- 추천 시작값: `0.35`
- 파일 크기: 약 `273.8 MB`
- 공개일: `2026-03-18`
- 프롬프트 방식: 기본 프롬프트 유지, 미세 보정용
- 잘 맞는 워크플로우: `anima-mixed-scene`
- 주의점: 강도를 높이면 전체 톤이 예상보다 많이 바뀔 수 있음
- 테스트 메모: 다른 품질 LoRA와 단독 비교 필요
- 상세 메모:
  - 파일이 꽤 큰 편이라 단순 미세 보정보다 표현 영역이 넓을 수 있음
  - 트리거가 인물 속성 쪽이라 범용 품질 LoRA보다는 인물 편향 조정에 가까울 수 있음
  - 캐릭터 고정성이 중요한 테스트에서는 베이스 인물 태그를 먼저 고정한 뒤 비교해야 함
- 링크: https://civitai.com/models/2399952

#### Anima Highres/Aesthetic Boost
- 파일명: `anima-highres-aesthetic-boost.safetensors`
- 카테고리: 품질 보정 / 고해상도
- 권장 강도: `0.3 ~ 0.7`
- 관찰된 트리거: 없음 (무트리거)
- 추천 시작값: `0.5`
- 파일 크기: 약 `132 MB`
- 공개일: 최근
- 프롬프트 방식: 기본 프롬프트 유지, 강도만 조절
- 잘 맞는 워크플로우: `anima-mixed-scene`
- 주의점: 1536px 이상 고해상도에서 효과 극대화. 1024px에서도 미학 향상 효과 있음. Danbooru 10K 고평점 이미지로 mixed-resolution 학습됨
- 테스트 메모: 기존 masterpieces와 역할 겹침 가능성 있으므로 단독/비교 테스트 필요
- 링크: https://civitai.com/models/2540444

#### Anima Colorfix
- 카테고리: 색 보정
- 권장 강도: `0.2 ~ 0.5`
- 프롬프트 방식: 색 충돌이 날 때만 보조적으로 사용
- 잘 맞는 워크플로우: `anima-mixed-scene`
- 주의점: 색을 안정시키는 대신 원래 의도한 채도를 깎을 수 있음
- 테스트 메모: 이번 상위 10 다운로드 묶음에는 포함되지 않았지만 운영상 중요

### 스타일

#### AI styles dump (Anima/Illustrious/RouWei/Noob)
- 파일명: `mixed_styles_anima_preview2_v3.5.safetensors`
- 카테고리: 멀티 스타일
- 권장 강도: `0.4 ~ 0.8`
- 관찰된 트리거: `@style_name`
- 추천 시작값: `0.55`
- 파일 크기: 약 `177.7 MB`
- 공개일: `2026-03-30`
- 프롬프트 방식: 스타일 키워드를 짧게 넣고, 장면 설명은 자연어로 유지
- 잘 맞는 워크플로우: `anima-mixed-scene`
- 주의점: 다른 스타일 LoRA와 중복 사용 시 개성이 충돌할 수 있음
- 테스트 메모: 스타일 실험용 허브 성격
- 상세 메모:
  - 설명상 여러 스타일을 묶은 덤프 형태라서, 구체적인 스타일 이름이 없으면 반응이 애매할 수 있음
  - 단독 사용으로 스타일 편향만 확인한 뒤, 품질 LoRA와의 조합은 2차로 테스트
  - 스타일 토큰 체계를 먼저 파악해야 하므로 실사용 전 샘플 프롬프트를 별도 정리하는 편이 좋음
- 링크: https://civitai.com/models/723360

#### cham22 - Style Collection - Anima P
- 파일명: `cham22old_AnimaP_v03-000021.safetensors`
- 카테고리: 스타일
- 권장 강도: `0.45 ~ 0.8`
- 관찰된 트리거: `@chamold`
- 추천 시작값: `0.55`
- 파일 크기: 약 `22.0 MB`
- 공개일: `2026-04-11`
- 프롬프트 방식: 스타일 묘사 짧게, 구도/행동은 자연어 중심
- 잘 맞는 워크플로우: `anima-mixed-scene`
- 주의점: 강도가 높으면 구도보다 표면 스타일이 우선될 수 있음
- 테스트 메모: 시각 톤 확인용
- 상세 메모:
  - 파일 크기가 가벼운 편이라 실험 회전이 빠름
  - Preview 3 Base 학습이라 현재 Anima 체인과 호환성이 비교적 좋을 가능성
  - 기본 품질 보정 1개와 조합해도 부담이 적을 후보
- 링크: https://civitai.com/models/2406707

#### nihiruma | Style
- 파일명: `nihirumaanima_preview2_2.safetensors`
- 카테고리: 스타일
- 권장 강도: `0.45 ~ 0.8`
- 관찰된 트리거: `@nihirumastyle`
- 추천 시작값: `0.55`
- 파일 크기: 약 `126.2 MB`
- 공개일: `2026-03-20`
- 프롬프트 방식: 조명/분위기 키워드와 함께 쓰기 좋음
- 잘 맞는 워크플로우: `anima-mixed-scene`
- 주의점: 스타일 주도권이 강할 수 있음
- 테스트 메모: 얼굴 결, 색감, 선 정리 정도 확인 필요
- 상세 메모:
  - Preview 2 기반이라 Preview 3 체인에서 과개입 여부 확인 필요
  - 얼굴과 채색 분위기 쪽에 개성이 강하게 실릴 가능성이 높음
  - 실사용 전에는 반신 인물 / 실내 / 단색 배경 같은 단순 비교 샷으로 먼저 보는 편이 좋음
- 링크: https://civitai.com/models/2479233

#### BlueArchive CG Style (Anima v1)
- 파일명: `anima-bluearchive_cg_style.safetensors`
- 카테고리: 스타일
- 권장 강도: `0.45 ~ 0.8`
- 관찰된 트리거: `blue_archive, game_cg`, `halo`
- 추천 시작값: `0.55`
- 파일 크기: 약 `137 MB`
- 호환: ✅ Anima 전용
- 링크: https://civitai.com/models/2412781
- 프롬프트 방식: 블루아카 CG 특유의 채색/라이팅 톤. `halo` 트리거로 머리 위 헤일로 추가 가능
- 주의점: 블루아카 특유의 밝고 선명한 CG 톤으로 전환됨. 다른 스타일 LoRA와 병용 주의

#### E20 Styles (Anima)
- 파일명: `anima-e20_styles.safetensors`
- 카테고리: 스타일
- 권장 강도: `0.4 ~ 0.8`
- 관찰된 트리거: 없음 (무트리거)
- 추천 시작값: `0.5`
- 파일 크기: 약 `132 MB`
- 호환: ✅ Anima 전용
- 링크: https://civitai.com/models/2467785
- 주의점: e20 기반 화풍 LoRA. 무트리거이므로 강도로 스타일 개입 조절. 프리셋 전환용으로 활용

#### Juustagram Chibi Style (Anima v2.0)
- 파일명: `anima-juustagram_chibi.safetensors`
- 카테고리: 스타일
- 권장 강도: `0.5 ~ 0.9`
- 관찰된 트리거: `juustagram style`, `Chibi`
- 추천 시작값: `0.7`
- 파일 크기: 약 `5 MB`
- 호환: ✅ Anima 전용 (v2.0)
- 링크: https://civitai.com/models/494535
- 주의점: 블루아카 쥬스타그램 감성 치비체. 초경량(5MB)이라 부담 없이 실험 가능

#### Shexyo’s Recent Style - Anima P
- 파일명: `shexyo_AnimaP_v03.safetensors`
- 카테고리: 스타일
- 권장 강도: `0.45 ~ 0.8`
- 관찰된 트리거: `sh3xy0 style`
- 추천 시작값: `0.55`
- 파일 크기: 약 `22.0 MB`
- 공개일: `2026-04-10`
- 프롬프트 방식: 짧은 스타일 태그 + 자세한 자연어 장면 설명
- 잘 맞는 워크플로우: `anima-mixed-scene`
- 주의점: 특정 미감 편향이 강할 수 있음
- 테스트 메모: 인물 단독 / 반신 컷에서 먼저 비교 권장
- 상세 메모:
  - Preview 3 Base 학습이라 현재 Anima 실험과 연결성이 좋음
  - 경량 스타일 LoRA로 빠른 A/B 테스트에 적합
  - 품질 LoRA 1개와 조합한 뒤 선 정리, 피부 질감, 손 표현이 무너지지 않는지 확인할 것
- 링크: https://civitai.com/models/2396594

### 디테일러 / 특수 용도

#### [Anima] Nipple LoRa for Detailer [preview]
- 파일명: `AnimaP3-NP43iV2.safetensors`
- 카테고리: 디테일러 특화
- 권장 강도: `0.25 ~ 0.5`
- 관찰된 트리거: `nipples`
- 추천 시작값: `0.3`
- 파일 크기: 약 `43.8 MB`
- 공개일: `2026-04-11`
- 프롬프트 방식: 필요 부위가 명확한 상황에서만
- 잘 맞는 워크플로우: 별도 디테일러 체인 또는 인페인트 후처리
- 주의점: 범용 기본 체인에 상시 탑재 금지
- 테스트 메모: 메인 생성용이 아니라 후처리용으로 취급
- 상세 메모:
  - 이름 그대로 메인 장면 생성보다 디테일러 / 후처리용 성격이 강함
  - Preview 3 기반이라 Anima 후처리 체인 호환성은 비교적 기대 가능
  - 범용 초안 생성 단계에서는 빼고, 필요한 경우만 국소 보정에 사용
- 링크: https://civitai.com/models/2385403

#### RDBT - Anima
- 파일명: `anima_preview3_rdbt_finetuned_v0.24_dmd2.safetensors`
- 카테고리: 특수 렌더 / 튜닝 계열
- 권장 강도: `0.3 ~ 0.7`
- 관찰된 트리거: 명시 없음
- 추천 시작값: `0.4`
- 파일 크기: 약 `68.8 MB`
- 공개일: `2026-04-10`
- 프롬프트 방식: 기본 장면 설명을 먼저 쓰고 영향만 관찰
- 잘 맞는 워크플로우: `anima-mixed-scene`
- 주의점: 품질 LoRA인지 스타일 LoRA인지 역할이 애매할 수 있어 단독 테스트 우선
- 테스트 메모: 비교 샘플 확보 필요
- 상세 메모:
  - 메타데이터상 trained words가 비어 있어서 동작 원리를 결과로 역추적해야 함
  - `dmd2` 명칭상 샘플링 성향과 결과 수렴 방식에 영향을 줄 가능성 있음
  - 가장 먼저 해야 할 건 무로라 / 이 로라 단독 / 품질 LoRA 조합의 3분 비교
- 링크: https://civitai.com/models/2364703

#### Sagging Breasts
- 파일명: `sagging-anima-v3.1b.safetensors`
- 카테고리: 특수 컨셉
- 권장 강도: `0.5 ~ 0.9`
- 관찰된 트리거: `breasts apart`, `sagging breasts`
- 추천 시작값: `0.65`
- 파일 크기: 약 `11.1 MB`
- 공개일: `2026-04-11`
- 프롬프트 방식: 필요한 상황에서만 명시적으로 사용
- 잘 맞는 워크플로우: 전용 컨셉 씬
- 주의점: 범용 인물 프리셋과 분리
- 테스트 메모: 기본 치트시트에는 남기되 범용 추천 목록에서는 제외 가능
- 상세 메모:
  - 파일이 매우 가벼워서 국소 개념 주입형일 가능성이 높음
  - 업스케일 친화성을 언급하고 있어서 고해상도 후속 체인과 결합 가능성 있음
  - 범용 초상 / 일반 장면용 추천 목록에는 넣지 않는 편이 안전
- 링크: https://civitai.com/models/139131

## 호환성 테스트 결과 (2026-04-14)

전체 13종을 동일 조건(seed 42424242, 1024x1024, steps 36, Preview3 base, 강도 0.6)으로 테스트 완료.

### ✅ 호환 확인 (9종)
- `anima-preview2-masterpieces-e50.safetensors` — 품질 향상 뚜렷, 깔끔한 마감
- `Hentai_Studio_Quality_Anima-step00001300.safetensors` — 볼드 라인아트, 체형 과장 경향
- `cham22old_AnimaP_v03-000021.safetensors` — 0.6에서 효과 미미, 강도 올려야 드러남
- `shexyo_AnimaP_v03.safetensors` — 피부톤 변화, 뚜렷한 렌더링 스타일
- `mixed_styles_anima_preview2_v3.5.safetensors` — 어두운 톤, P2 기반이지만 P3 호환
- `nihirumaanima_preview2_2.safetensors` — 베이스라인에 가까운 부드러운 변화
- `Chunipose_LocalTrainer_ANIMA.safetensors` — 포즈 프롬프트에서만 효과 (0.7 권장)
- `LoRA2FSpreadAnusAnimaYume.safetensors` — 해당 프롬프트에서만 효과
- `LoRALickingNippleAnimaYume.safetensors` — 해당 프롬프트에서만 효과

### ⚠️ 조건부 (3종)
- `anima_preview3_rdbt_finetuned_v0.24_dmd2.safetensors` — **포토리얼로 완전 전환**됨. 순수 애니메 부적합, 실사/속도 벤치용
- `hinaAnima2_R_Tweaker_v3.safetensors` — **세미리얼 방향 전환**. 반실사 의도 시에만
- `sagging-anima-v3.1b.safetensors` — **세미리얼 전환 경향**. 애니메 순수 용도 부적합

### ❌ 사용 불가 (1종)
- `AnimaP3-NP43iV2.safetensors` — 0.6에서 출력 백지. **디테일러/인페인트 전용**으로 저강도(0.25~0.3) 사용 필요

## 포즈/컨셉 LoRA (추가분)

#### Chunipose LocalTrainer ANIMA
- 파일명: `Chunipose_LocalTrainer_ANIMA.safetensors`
- 카테고리: 포즈
- 권장 강도: `0.6 ~ 0.8`
- 프롬프트 방식: 포즈 태그와 함께 사용
- 호환: ✅ Preview3 테스트 통과
- 주의점: 포즈 프롬프트 없으면 효과 없음

#### AnimaYume Spread
- 파일명: `LoRA2FSpreadAnusAnimaYume.safetensors`
- 카테고리: 포즈/NSFW
- 권장 강도: `0.5 ~ 0.7`
- 프롬프트 방식: 해당 포즈 태그 필수
- 호환: ✅ Preview3 테스트 통과

#### AnimaYume Licking Nipple
- 파일명: `LoRALickingNippleAnimaYume.safetensors`
- 카테고리: 포즈/NSFW
- 권장 강도: `0.5 ~ 0.7`
- 프롬프트 방식: 해당 포즈 태그 필수
- 호환: ✅ Preview3 테스트 통과

#### Prone Bone POV (by RandomNoises)
- 파일명: `anima-prone_bone_pov.safetensors`
- 카테고리: 체위/NSFW
- 권장 강도: `0.5 ~ 0.7`
- 관찰된 트리거: `male pov, pov, prone bone`
- 바리에이션 태그: `vaginal`, `anal`, `looking back`, `looking ahead`, `shoulders grab`, `wrist grab`, `ass grab`, `thumb in ass`, `spreading own ass`
- 추천 시작값: `0.6`
- 파일 크기: 약 `44 MB`
- 호환: ✅ Anima 전용 (AnimaV0.3)
- 링크: https://civitai.com/models/2032711

#### Suspended Congress POV (by RandomNoises)
- 파일명: `anima-suspended_congress_pov.safetensors`
- 카테고리: 체위/NSFW
- 권장 강도: `0.5 ~ 0.7`
- 관찰된 트리거: `suspended congress, standing-sex, pov, male pov, standing male, grab under ass`
- 추천 시작값: `0.6`
- 파일 크기: 약 `44 MB`
- 호환: ✅ Anima 전용
- 링크: https://civitai.com/models/2516777
- 주의점: 서서 들어올린 삽입 체위. 체형/체중 차이가 큰 캐릭터에서 불안정할 수 있음

#### Spooning POV (by RandomNoises)
- 파일명: `anima-spooning_pov.safetensors`
- 카테고리: 체위/NSFW
- 권장 강도: `0.5 ~ 0.7`
- 관찰된 트리거: `spooning, male pov, pov, lying on side`
- 바리에이션 태그: `anal`, `vaginal`, `looking ahead`, `looking back`
- 추천 시작값: `0.6`
- 파일 크기: 약 `44 MB`
- 호환: ✅ Anima 전용
- 링크: https://civitai.com/models/2495918
- 주의점: 옆으로 누운 삽입 체위. 이불/침대 배경과 궁합 좋음

#### Better Pussy and Anus (Anima v2)
- 파일명: `better_pussy_and_anus_anima_v2.safetensors`
- 카테고리: 해부학 디테일/NSFW
- 권장 강도: `0.3 ~ 0.6`
- 관찰된 트리거: 없음 (무트리거)
- 추천 시작값: `0.4`
- 파일 크기: 약 `132 MB`
- 호환: ✅ Anima 전용 (v2.0)
- 링크: https://civitai.com/models/2441235
- 주의점: 트리거 없이 강도만으로 작동. 해부학 디테일 강화용이므로 NSFW 장면에서만 사용

#### Nursing Handjob (Anima)
- 파일명: `anima-nursing_handjob.safetensors`
- 카테고리: 체위/NSFW
- 권장 강도: `0.5 ~ 0.7`
- 관찰된 트리거: 없음 (무트리거)
- 추천 시작값: `0.6`
- 파일 크기: 약 `88 MB`
- 호환: ✅ Anima 전용
- 링크: https://civitai.com/models/2406543
- 주의점: 수유 핸드잡 컨셉. 무트리거이므로 프롬프트에 handjob, nursing 등 직접 서술 권장

#### Ball Licking Concept (Anima v1)
- 파일명: `anima-balllicking_v1.safetensors`
- 카테고리: 오럴/NSFW
- 권장 강도: `0.5 ~ 0.7`
- 관찰된 트리거: `balllicking`, `pov balllicking`, `cooperative balllicking`
- 추천 시작값: `0.6`
- 파일 크기: 약 `252 MB`
- 호환: ✅ Anima 전용
- 링크: https://civitai.com/models/2440417
- 주의점: cooperative 트리거로 2인 동시 씬도 가능. 파일 크기 큰 편(252MB)

#### POV FootWorship (Anima v0.5)
- 파일명: `anima-footworship_pov.safetensors`
- 카테고리: 포즈/페티시
- 권장 강도: `0.5 ~ 0.7`
- 관찰된 트리거: `footworship`
- 추천 시작값: `0.6`
- 파일 크기: 약 `132 MB`
- 호환: ✅ Anima Preview
- 링크: https://civitai.com/models/946498
- 주의점: 발 페티시 POV 전용. 발바닥/발가락 디테일 강화

#### Clothes Lift and Presenting
- 파일명: `anima-clothes_lift_presenting.safetensors`
- 카테고리: 포즈/NSFW
- 권장 강도: `0.5 ~ 0.7`
- 관찰된 트리거: 없음 (무트리거)
- 추천 시작값: `0.6`
- 파일 크기: 약 `92 MB`
- 호환: ✅ Anima 전용
- 링크: https://civitai.com/models/2391296
- 주의점: 옷 들어올려 보여주기 포즈. 스커트 리프트, 셔츠 리프트 등과 조합. 무트리거라 강도로 제어

#### Do You Want to Pet My Cat (Meme Concept)
- 파일명: `anima-pet_my_cat_meme.safetensors`
- 카테고리: 특수 컨셉/밈/NSFW
- 권장 강도: `0.8 ~ 0.9` (제작자 권장)
- 관찰된 트리거: `crotch rub, cat writing on crotch, body writing, table humping`
- 추천 시작값: `0.85`
- 파일 크기: 약 `132 MB`
- 호환: ✅ Anima 전용
- 링크: https://civitai.com/models/2447374
- 주의점: 음부의 세로선을 고양이 입으로 활용하여 주변에 고양이 얼굴(수염/귀 등)을 그리는 밈 컨셉. **강도를 0.8 이상으로 올리고 트리거 태그를 전부 포함해야 밈 본래의 스타일이 나옴**. 낮은 강도(0.5~0.7)에서는 body writing이 불명확하거나 아예 안 나올 수 있음. 포즈 태그를 최소화하고 LoRA가 구도를 주도하도록 맡기는 편이 결과가 좋음. **⚠️ baseLoras(masterpieces, Hentai Studio Quality) 간섭 확인됨 — 이 LoRA 사용 시 baseLoras를 0.01로 오버라이드하여 사실상 무력화해야 밈 컨셉이 제대로 나옴**

#### Dildo Under Clothes (Anima Preview)
- 파일명: `anima-dildo_under_clothes.safetensors`
- 카테고리: 특수 컨셉/NSFW
- 권장 강도: `0.5 ~ 0.8`
- 관찰된 트리거: `dildo under clothes`, `dildo under panties`
- 추천 시작값: `0.6`
- 파일 크기: 약 `71 MB`
- 호환: ✅ Anima Preview (Preview 버전 학습)
- 링크: https://civitai.com/models/375340
- 주의점: Anima 자연어 프롬프트와 궁합 좋음. 제작자 코멘트 — "anima can take natural language very well, use your creativity"

#### Photo Background 写真背景・二次元合成 v3
- 파일명: `anima3-photo-background-v3.safetensors`
- 카테고리: 배경 / 합성
- 권장 강도: `0.5 ~ 0.8`
- 관찰된 트리거: `photo background`, `real world location`
- 추천 시작값: `0.6`
- 파일 크기: 약 `132 MB`
- 호환: ✅ Anima Preview 3 Base 전용 (v3.0)
- 링크: https://civitai.com/models/1252497
- 주의점: 2D 캐릭터 + 실사 배경 합성 컨셉. 배경만 실사화하고 캐릭터는 2D 유지

#### Inside Creature 捕食・消化中 (Anima v1)
- 파일명: `inside_creature_anima_v1.safetensors`
- 카테고리: 특수 컨셉
- 권장 강도: `0.5 ~ 0.8`
- 관찰된 트리거: `inside creature`
- 추천 시작값: `0.6`
- 파일 크기: 약 `66 MB`
- 호환: ✅ Anima 전용 (anima_v1.0)
- 링크: https://civitai.com/models/2346544
- 주의점: 크리처 내부/포식/소화 컨셉. 판타지 특수 연출용

#### Petrification 石化 (Anima v1)
- 파일명: `petrification_anima_v1.safetensors`
- 카테고리: 특수 컨셉
- 권장 강도: `0.5 ~ 0.8`
- 관찰된 트리거: `petrification`
- 추천 시작값: `0.6`
- 파일 크기: 약 `66 MB`
- 호환: ✅ Anima 전용 (anima_v1.0)
- 링크: https://civitai.com/models/353703
- 주의점: 석화 컨셉. 특수 연출용

#### Anima Colorfix v04
- 파일명: `Anima_colorfix_v04.safetensors`
- 카테고리: 색 보정
- 권장 강도: `0.2 ~ 0.5`
- 관찰된 트리거: 없음
- 추천 시작값: `0.3`
- 파일 크기: 약 `74 MB`
- 호환: ✅ Anima 전용 (v04 최신)
- 링크: https://civitai.com/models/2435207
- 주의점: 색 안정용. 채도를 깎을 수 있으므로 필요할 때만 보조적 사용

## baseLoras 정책 (확정)

`comfyui-config.json`의 `anima` 프리셋에 등록. 런타임 `lora_injection`이 자동 주입한다.

| LoRA | 강도 | 역할 |
|---|---|---|
| `anima-preview2-masterpieces-e50.safetensors` | 0.5 | **[ANIMA-BASE]** 퀄리티 부스터 |
| `Hentai_Studio_Quality_Anima-step00001300.safetensors` | 0.5 | **[ANIMA-BASE]** 라인아트/톤 강화 |

- baseLoras 오버라이드: `loras` 파라미터에 같은 이름으로 다른 strength → 강도 변경, strength 0 → 제거
- Illustrious `[BASE]`와 혼용 금지 — 파이프라인이 다름

## 현재 운영 추천

### 기본 프리셋 (baseLoras로 상시 적용)
- `anima-preview2-masterpieces-e50.safetensors` (0.5)
- `Hentai_Studio_Quality_Anima-step00001300.safetensors` (0.5)

### 아티스트 스타일 (한 번에 1개, 동적 추가)
- `cham22old_AnimaP_v03-000021.safetensors` — 경량, P3 기반
- `shexyo_AnimaP_v03.safetensors` — 경량, P3 기반, 렌더링감
- `nihirumaanima_preview2_2.safetensors` — 부드러운 톤
- `mixed_styles_anima_preview2_v3.5.safetensors` — 멀티 스타일 허브

### 비교 실험용 (단독 테스트 권장)
- `hinaAnima2_R_Tweaker_v3.safetensors` — 세미리얼 전환
- `anima_preview3_rdbt_finetuned_v0.24_dmd2.safetensors` — 포토리얼/속도

### 전용 상황에서만
- `AnimaP3-NP43iV2.safetensors` — 디테일러 전용, 저강도
- `sagging-anima-v3.1b.safetensors` — 특수 컨셉, 세미리얼 경향
- `Chunipose_LocalTrainer_ANIMA.safetensors` — 포즈 전용
- `LoRA2FSpreadAnusAnimaYume.safetensors` — NSFW 포즈 전용
- `LoRALickingNippleAnimaYume.safetensors` — NSFW 포즈 전용
- `anima-prone_bone_pov.safetensors` — 체위/NSFW, prone bone POV (by RandomNoises)
- `anima-suspended_congress_pov.safetensors` — 체위/NSFW, 서서 들어올린 삽입 POV (by RandomNoises)
- `anima-spooning_pov.safetensors` — 체위/NSFW, 옆으로 누운 삽입 POV (by RandomNoises)
- `better_pussy_and_anus_anima_v2.safetensors` — 해부학 디테일 강화 (무트리거)
- `Anima_colorfix_v04.safetensors` — 색 보정 (v04)
- `petrification_anima_v1.safetensors` — 특수 컨셉, 석화
- `inside_creature_anima_v1.safetensors` — 특수 컨셉, 크리처 내부/포식
- `anima-highres-aesthetic-boost.safetensors` — 품질/고해상도 부스트 (masterpieces 대체 후보)
- `anima3-photo-background-v3.safetensors` — 실사 배경 합성 (P3 전용)
- `anima-dildo_under_clothes.safetensors` — 딜도/옷 안 삽입 컨셉
- `anima-footworship_pov.safetensors` — 발 페티시 POV
- `anima-balllicking_v1.safetensors` — 볼 리킹/오럴 컨셉
- `anima-nursing_handjob.safetensors` — 수유 핸드잡 (무트리거)
- `anima-bluearchive_cg_style.safetensors` — 블루아카 CG 스타일
- `anima-pet_my_cat_meme.safetensors` — 밈 컨셉 (고양이 가랑이 비비기)
- `anima-clothes_lift_presenting.safetensors` — 옷 들어올려 보여주기 포즈 (무트리거)
- `anima-juustagram_chibi.safetensors` — 블루아카 쥬스타그램 치비 스타일 (5MB)
- `anima-e20_styles.safetensors` — e20 화풍 스타일 프리셋 (무트리거)
