# Illustrious LoRA 치트시트

Illustrious / SDXL anime 계열 워크플로우(`portrait`, `scene`, `scene-real`, `scene-couple`, `profile`) 전용.
Danbooru 태그 우선. 기존 portrait / scene / scene-couple 체인을 기준으로 기록한다.
`[BASE]` 표시된 LoRA는 워크플로우에 이미 고정 포함되어 있다.
`loras` 파라미터로 base LoRA를 오버라이드할 수 있다:
- **강도 0** → 해당 base LoRA를 체인에서 **제거**
- **다른 값** → 해당 base LoRA의 강도를 **오버라이드**
- base에 없는 LoRA → 체인 뒤에 **동적 추가**

## 사용 방법

`generate_image` 또는 `comfyui_generate` 도구의 `loras` 파라미터로 전달:

```json
{
  "loras": [
    { "name": "PosingDynamicsILL.safetensors", "strength": 0.6 },
    { "name": "lace_clothing.safetensors", "strength": 0.5 }
  ]
}
```

## LoRA 목록

### 퀄리티/디테일

| LoRA 파일명 | 강도 | 용도 | 트리거 태그 | 비고 |
|---|---|---|---|---|
| `illustrious_masterpieces_v3.safetensors` | 0.4 | 전반적 퀄리티 | 없음 | **[BASE]** |
| `AddMicroDetails_Illustrious_v5.safetensors` | 0.5 | 디테일 강화 | 없음 | **[BASE]** |
| `Smooth_Booster_v4.safetensors` | 0.4 | 부드러운 표면 | 없음 | **[BASE]** |
| `sexy_details_v4.safetensors` | 0.4 | 신체 디테일 보정 | `sexydet` | **[BASE]** |
| `Age_V2.5.safetensors` | -3 | 젊은 외형 보정 | 없음 | **[BASE]** |
| `detailed_hand_focus_style_illustriousXL_v1.1.safetensors` | 0.4~0.7 | 손/손가락 해부학 보정 | 없음 | 강도 높으면 과적합 주의 |

### 스타일/연출

| LoRA 파일명 | 강도 | 용도 | 트리거 태그 | 비고 |
|---|---|---|---|---|
| `anime_screencap-IllustriousV2.safetensors` | 0.5 | 애니메이션 스크린캡 스타일 | `anime screencap, anime coloring` | **[BASE]** |
| `S1 Dramatic Lighting Illustrious_V2.safetensors` | 0.5 | 드라마틱 라이팅 | `s1_dram` | **[BASE]** |
| `QAQv5p2_IL-40.safetensors` | 0.4 | QAQ 스타일 보정 | 없음 | **[BASE]** |
| `CitronFantasy_v2.safetensors` | 0.4~0.6 | 판타지풍 밝은 색감 | 없음 | |
| `IFL_v1.0_IL.safetensors` | 0.4~0.6 | Illustrious 스타일 보정 | 없음 | |
| `Misekai555-ArtStyle.safetensors` | 0.4~0.6 | Misekai555 아티스트 스타일 | 없음 | |
| `ts_art_style.safetensors` | 0.4~0.6 | TS 아트 스타일 | 없음 | |
| `animemix_v3_offset.safetensors` | 0.3~0.5 | 애니메이션 스타일 믹스/오프셋 | 없음 | |
| `Pixel-Art Style v6.3 🔮(illustrious by Skormino).safetensors` | 0.5~0.8 | 픽셀 아트 스타일 변환 | 없음 | |

### 스크린캡 강화

| LoRA 파일명 | 강도 | 용도 | 트리거 태그 | 비고 |
|---|---|---|---|---|
| `Anime_Screencap_Enhancement-v1.safetensors` | 0.3~0.5 | 스크린캡 퀄리티 강화 | 없음 | |
| `animescreencap_xl.safetensors` | 0.3~0.5 | XL 스크린캡 스타일 | 없음 | |

### 포즈/액션

| LoRA 파일명 | 강도 | 용도 | 트리거 태그 | 비고 |
|---|---|---|---|---|
| `PosingDynamicsILL.safetensors` | 0.4~0.7 | 다이나믹 포즈, 액션 포즈 | 없음 (포즈 태그와 함께 사용) | |
| `mangurigaeshi_V3.safetensors` | 0.5~0.7 | 망구리가에시/보지 벌림 (다리 들어올려 보지 노출) | `mangurigaeshi, folded, buttocks lift, head down, spread legs, legs up, legs overhead, spread pussy, pussy focus, close-up, from above, pov` | 105MB |
| `Hunched missionary-IL_NAI_PY.safetensors` | 0.5~0.7 | 정상위 (hunched missionary) | `missionary, boy on top, lying, on back, leg lock, legs up` | |
| `DominantMatingPress_Illu.safetensors` | 0.5~0.7 | 도미넌트 메이팅 프레스 | `dominant mating press, missionary, on back, lying, deep penetration, wide spread legs` | |
| `2koma-matpre-IL_v1.safetensors` | 0.4~0.6 | 2컷 종부 프레스 연출 | `2koma, mating press, missionary` | 2컷 만화 형식 |
| `enjoy_doggy-style.safetensors` | 0.5~0.7 | 후배위 (도기스타일) | 없음 (포즈 태그와 함께 사용) | |
| `Doggystyle_helper.safetensors` | 0.5~0.7 | 후배위 보조 | 없음 (포즈 태그와 함께 사용) | |
| `Close-up_Standing_Doggy.safetensors` | 0.5~0.7 | 클로즈업 스탠딩 도기 | `closeupstandingdoggy, vaginal penetration, standing doggystyle position, close up ass, arched back` | |
| `Motorcycle_doggystyle_Hair_pull.safetensors` | 0.5~0.7 | 오토바이 도기스타일 + 머리잡기 | `motodoggy_style` | |
| `Double_Reverse_Cowgirl.safetensors` | 0.5~0.7 | 더블 리버스 카우걸 (쓰리섬) | `Double Reverse Cowgirl, Threesome` | |
| `Deep Overflow-IL_NAI_PY.safetensors` | 0.5~0.7 | 딥 오버플로우 (정상위/메이팅프레스 2컷) | `mating press, missionary, multiple views, deep penetration` | |
| `Wrong hole-IL_NAI_PY.safetensors` | 0.5~0.7 | 잘못된 구멍 (항문 삽입) | 포즈 태그와 함께 사용 | |
| `Unresponsive_Sex.safetensors` | 0.5~0.7 | 무반응 섹스 포즈 | 포즈 태그와 함께 사용 | |
| `FingerInMouth-Sex.safetensors` | 0.5~0.7 | 입에 손가락 넣기 (섹스 중) | 포즈 태그와 함께 사용 | |
| `FingerInAnothers Mouth-Sex.safetensors` | 0.5~0.7 | 상대방 입에 손가락 (섹스 중) | `famds, finger in another's mouth, pov, missionary` | |
| `Handgag.safetensors` | 0.5~0.7 | 입 막기/거친 섹스 | `HGV1, covering another's mouth, handgag, hand over mouth` | 트렌딩 DL:16K |
| `BreastGrab_UnderClothes_r2.safetensors` | **0.5** | 옷 안으로 손 넣어 가슴 주무르기 | `UnderClothesV1, hand under clothes, clothed breast grab, covered nipples` | 218MB. ⚠️ 0.7은 옷이 벗겨짐 — **0.5 권장**. `breast grab` 대신 `clothed breast grab` 사용 필수. `loose` 태그 제거할 것 |
| `AnkleGrabMissionaryV2.safetensors` | 0.5~0.7 | 발목 잡기 정상위 | `AGMV2, ankle grab, missionary` | 정상위 바리에이션 |
| `finger_sucking.safetensors` | 0.5~0.9 | 손가락 빨기 | `finger_sking, open mouth, two fingers in another's mouth, saliva, drooling` | 권장 0.9 |
| `bridal_carry_position.safetensors` | 0.5~0.7 | 공주안기 체위 | `carrying another, carrying partner, sex, legs together` | |
| `double_cowgirl_position.safetensors` | 0.5~0.7 | 더블 카우걸 (2girls+1boy 쓰리섬) | `double cowgirl position, 2girls, 1boy, ffm threesome, straddling, cowgirl position, yuri kiss` | 21MB, 키스 포함 |
| `ffm_threesome_fellatio.safetensors` | 0.5~0.7 | FFM 쓰리섬 펠라 (올포어 POV) | `ffm_fellatio_variant1, 1boy, 2girls, lick penis` | 동시 펠라 장면에 최적 |
| `penis_between_faces.safetensors` | 0.5~0.7 | 얼굴 사이에 자지 (2girls 쓰리섬) | `pbfaces, 2girls, penis on cheek, threesome` | |
| `bred_sisters.safetensors` | 0.5~0.7 | 자매 동시 삽입/비교 컨셉 | `dark labia, breast press, pink nipples, dark nipples, leg grab` | 164MB, 자매 설정에 최적 |
| `Pet_training.safetensors` | 0.5~0.7 | 펫 트레이닝/목줄 | `leash pull, girl on top, sitting on person` | |
| `Dont_spread_my_ass.safetensors` | 0.5~0.7 | 역카우걸 + 항문 벌림 | `straddling, reverse cowgirl position, spread anus` | |
| `collaborativesuck.safetensors` | 0.5~0.7 | 2인 협동 펠라/볼 빨기 | `collaborativesuck, ball suck, testicle-sucking, oral, fellatio, penis in mouth` | FFM 쓰리섬용 |

### 오럴/페라

| LoRA 파일명 | 강도 | 용도 | 트리거 태그 | 비고 |
|---|---|---|---|---|
| `threesome_all_on_four_fellatio_pov.safetensors` | 0.5~0.7 | FFM 쓰리섬 페라 (POV) | `ffm_fellatio_variant1, ffm_fellatio_variant2, 2girls, 1boy` | |
| `Caged_blowjob.safetensors` | 0.5~0.7 | 케이지 블로우잡 | `cagebj` | |
| `Oral suspension-IL_NAI_PY.safetensors` | 0.5~0.7 | 오럴 ���스펜션 (본디지+이라마치오, 매달린 상태 69) | `irrumatio, shibari, tied up, suspension, 69, deepthroat, oral, fellatio, cunnilingus` | 218MB, DL:786 👍182. 본디지 구속 + 이라마치오/69 특화 |
| ~~`vacuum_face_(concept)_ILXL.safetensors`~~ | ~~0.5~1.0~~ | ~~배큠 페이스 (이라마치오 얼굴 변형, 볼 함몰)~~ | — | **🚫 삭제됨** — 모든 강도에서 얼굴 왜곡 과도. 0.5 어중간, 0.7 과함, 1.0 풀태그도 과함. 실용성 없음 |
| `upright69-10.safetensors` | 0.5~0.9 | 서서 69 (역펠라 + 커닐링구스, 남자가 들어올림) | `1girl, 1boy, standing, 69, lifting person, upside-down, oral, fellatio, deepthroat, cunnilingus` | 193MB, DL:171 👍26. ⚠️ 인물 수 제어 실패 — 3명 이상 생성됨. 0.9에서도 개선 안됨. 체크포인트 궁합 문제 가능성 |
| `licking-penis-v4-illustriousxl.safetensors` | 0.5~0.7 | 자지 핥기/리킹 페니스 컨셉 | `licking penis, open mouth, tongue, tongue out, penis on face, torogao, saliva` | ⚠️ 수동 다운로드 필요 (CivitAI 로그인 필수). DL:2,645 👍368. https://civitai.com/models/2238101 |

### 파이즈리

| LoRA 파일명 | 강도 | 용도 | 트리거 태그 | 비고 |
|---|---|---|---|---|
| `Ternal_InternalPaizuri.safetensors` | 0.5~0.7 | 인터널 파이즈리 (딥 파이즈리 애드온) | `internalpaizuri, paizuri cross-section` | |
| `DeepPaizuri.safetensors` | 0.5~0.7 | 딥 파이즈리 | `BreastRipl, lowripl, medripl, highripl` | |
| `Paizuri_Femdom_Suspension_69.safetensors` | 0.5~0.7 | 파이즈리 펨돔 서스펜션 69 | `fem_paizu_69` | |
| `paizuri_kiss_tasteofchoklit.safetensors` | 0.7 | 파이즈리 + 귀두 키스/핥기 | 없음 — `paizuri, breast press, kiss, licking penis` 태그와 함께 사용 | 218MB. ✅ 파이즈리하면서 끝에 입술 대는 구도. DeepPaizuri(0.5) 보조 권장 |

### 착유/수유

| LoRA 파일명 | 강도 | 용도 | 트리거 태그 | 비고 |
|---|---|---|---|---|
| `milking_machine_concept.safetensors` | 0.5~0.7 | 착유기/브레스트 펌프 | `milking machine, breast pump, lactation, breast milk, nipples` | ⚠️ 수동 다운로드 필요 |
| `hand_milking.safetensors` | 0.5~0.7 | 손 착유/유두 짜기 | `hand_milking, milking_breasts, squeezing_nipple, pulling_nipple` | ⚠️ 수동 다운로드 필요 |
| `lactating_into_container.safetensors` | 0.5~0.7 | 용기에 착유/셀프 밀킹 | `lactating into container, lactation, breast milk, self milking, hand milking` | ✅ 다운로드 완료 |
| `dairy_farm_milking.safetensors` | 0.5~0.7 | 착유 시설/낙농장 배경 | `dairy farm milking 3ncl0sur3` | ⚠️ 수동 다운로드 필요 |

### 컨셉/상황

| LoRA 파일명 | 강도 | 용도 | 트리거 태그 | 비고 |
|---|---|---|---|---|
| `instantloss-10.safetensors` | 0.5~0.7 | 인스턴트 로스 (즉락) — 정상위/이라마치오 | `instant loss` (standing→missionary→irrumatio 변환) | |
| `instant-loss-v2-illustriousxl.safetensors` | 0.5~0.7 | 인스턴트 로스 v2 — 2컷 컨셉 | `instant loss` (2koma 형식) | |
| `impliedsex-12.safetensors` | 0.5~0.7 | 암시적 섹스 (상반신만) | `implied sex, ahegao, tongue out, upper body` | 상반신만 보이는 연출 |
| ~~`Heavy_Bondage_v1.safetensors`~~ | ~~0.5~0.7~~ | ~~헤비 본디지 / BDSM 구속~~ | — | **🚫 삭제됨** — 텐서 shape 불일치 에러 (파일 손상). `RuntimeError: shape '[32, 2048]' is invalid for input of size 53985` |
| `Tearing_Clothes_Off_Illustrious.safetensors` | 0.5~0.7 | 옷 찢기/강제 노출 컨셉 | `tearingclothesoff, assisted exposure, forced clothes tearing, torn clothes, pulling hands, multiple hands` | ⚠️ 수동 다운로드 필요 (CivitAI 로그인 필수). DL:13,441 👍1,677. https://civitai.com/models/1209779 |
| `HeldByGiantV2IL.safetensors` | 0.5~0.7 | 인간 오나홀 / 거인이 한 손으로 잡고 사용 (사이즈 디퍼런스) | `HBGV2, giant, holding person, size difference, living fleshlight, hand around waist` | ✅ 다운로드 완료. DL:14,355 👍1,486. 시리즈 중 최신 버전. https://civitai.com/models/1319951 |

### 구속/본디지 장비

| LoRA 파일명 | 강도 | 용도 | 트리거 태그 | 비고 |
|---|---|---|---|---|
| `spreadLegBondage.safetensors` | 0.5~0.7 | 다리 벌림 구속대 (허벅지 스톡) | `spreadLegBondage, stocks on thigh, stationary restraints, bound, bdsm` | DL:3,147 👍334 |
| `archback_bondage.safetensors` | 0.5~0.7 | 서있는 필로리 (목+손 구속, 등 젖힘) | `archback_bondage, stationary restraints, standing, arched back` | DL:2,370 👍262, 163MB |
| `piledriver_bondage.safetensors` | 0.5~0.7 | 파일드라이버 구속대 (굴곡 자세) | `piledriver_bondage, piledriver, bottom-up, upside-down, bound, bdsm` | DL:2,160 👍214 |
| `SuspendedSpreadEagleBondage.safetensors` | 0.5~0.7 | 매달림 사지 벌림 구속 | `SuspendedSpreadEagleBondage, legs up, spread legs, bound wrists, bound ankles` | DL:1,291 👍189 |
| `KneelingStrechedArmBondage.safetensors` | 0.5~0.7 | 무릎 꿇고 팔 벌림 구속 | `KneelingStrechedArmBondage, bdsm, bondage, bound wrists, bound ankles` | DL:958 👍121 |
| `Folded_and_Spred_Holes_IL-epoch_3.safetensors` | 0.5~0.7 | 굽힌 자세 구멍 벌림 | `bentoverspreadholes, bondage, bdsm, rope bondage, full body` | DL:844 👍139 |
| `PublicBDSMonBlackToilet_IL_REAL_V01.safetensors` | 0.5~0.7 | 공중 화장실 BDSM 구속 | `public bdsm, bdsm, restrained, bondage, shibari, black toilet` | DL:1,362 👍190 |

### 최면/정신조작

| LoRA 파일명 | 강도 | 용도 | 트리거 태그 | 비고 |
|---|---|---|---|---|
| `hypnosis.safetensors` | 0.5~0.7 | 최면 이펙트 (진자/마법진) | `hypnosis_V1` | DL:613 👍139 |
| `spiral_eyes.safetensors` | 0.5~0.7 | 나선 최면 눈 (소용돌이) | `spiral_eyes_hypnosis` | DL:419 👍69 |

### 난교/멀티

| LoRA 파일명 | 강도 | 용도 | 트리거 태그 | 비고 |
|---|---|---|---|---|
| `Wild_Party_v3.safetensors` | 0.5~0.7 | 야생 파티/난교 장면 | `vc_partay, party, house, indoors, excited, multiple boys` | DL:1,184 👍147 |
| `double_nipple_sucking.safetensors` | 0.5~0.7 | 양쪽 유두 동시 빨기 (2boys+1girl) | `double nipple sucking, 1girl, 2boys, boys on either side` | DL:247 👍52 |

### 특수 체위/장비

| LoRA 파일명 | 강도 | 용도 | 트리거 태그 | 비고 |
|---|---|---|---|---|
| `Milking_Table_r1.safetensors` | 0.5~0.7 | 밀킹 테이블 핸드잡 | `milking table, 1girl, 1boy, completely nude, erection, hetero` | DL:448 👍80 |

### X-ray/내부 묘사

| LoRA 파일명 | 강도 | 용도 | 트리거 태그 | 비고 |
|---|---|---|---|---|
| `X-ray_womb_full_of_cum_IL.safetensors` | 0.5~0.7 | 자궁 X-ray + 정액 차오름 | `Pooling cum` | DL:158 👍20 |

### 사정/정액

| LoRA 파일명 | 강도 | 용도 | 트리거 태그 | 비고 |
|---|---|---|---|---|
| ~~`2-panel_facial.safetensors`~~ | ~~0.5~0.7~~ | ~~얼굴/몸 사정 (페이셜)~~ | — | **🚫 삭제됨** — 전반적 퀄리티 뭉개짐, 재다운로드 금지 |
| ~~`huge_cum_v2.safetensors`~~ | ~~0.4~0.7~~ | ~~대량 사정/컴샷 디테일 (얼굴, 가슴, 머리카락)~~ | — | **🚫 삭제됨** — 텐서 shape 불일치 에러 (파일 손상 또는 비호환 아키텍처). `RuntimeError: shape '[32, 1280]' is invalid for input of size 8249` |
| `cum_covered_facev2.safetensors` | 0.3~0.4 | 얼굴 집중 정액 커버 | `cum_covered_face, facial, bukkake, excessive cum, cum over eyes, cum on face, white sticky cum, cum on hair` | 218MB, 권장 0.4. 0.5 이상은 아트 스타일 간섭 주의 |
| ~~`Cum_drip.safetensors`~~ | ~~0.5~0.7~~ | ~~서있는 상태 정액 흘러내림~~ | — | **🚫 삭제됨** — 텐서 shape 불일치 에러 (파일 손상 또는 비호환 아키텍처). `RuntimeError: shape '[32, 1280]' is invalid for input of size 8249` |
| `Pussy_cumshot_illus-000037.safetensors` | 0.5~0.7 | 음부 사정 표현 | `Pussy cumshot, Cum on pussy` | |
| `XDomiKamiX_Style-000035.safetensors` | 0.4~0.6 | 진한 정액 스타일 전반 | `XDomiKamiX, thick cum, cum explosion, cum mouth, pussy full cum` | 스타일 LoRA 성격 |
| `Deep Overflow-IL_NAI_PY.safetensors` | 0.5~0.7 | 삽입 후 넘치는 정액 | `cum in pussy, after sex, overflow` | 포즈 섹션에도 등재 |

### NSFW 해부학

| LoRA 파일명 | 강도 | 용도 | 트리거 태그 | 비고 |
|---|---|---|---|---|
| `Pussy_Asshole_detailer_UHD_ILL.safetensors` | 0.5~0.7 | 보지+항문 UHD 디테일 | `anu5, pussy, vulva, anus` | 범용. 보지+항문 둘 다 커버 |
| `LylahLabiaILUV3.safetensors` | 0.6~0.8 | 소음순/대음순 세밀 묘사 | 기본: `lylahlabia, pussy, labia, vulva, well defined folds, detailed vagina` | 상황별 태그 아래 참고 |
| ↳ 퍼프/부풀린 | 0.6~0.8 | | `lylahlabia, pumped pussy` | |
| ↳ 삽입/섹스 | 0.6~0.8 | | `lylahlabia, dick, penis, sex, hetero, insertion, vaginal` | |
| ↳ 벌림/크림파이 | 0.6~0.8 | | `lylahlabia, gape, creampie, cum` | |
| `cervix_ILL.safetensors` | 0.5~0.7 | 자궁경부 내부 표현 | `cervix, spread pussy` | 특수 상황용 |

### 유두/가슴 특화

| LoRA 파일명 | 강도 | 용도 | 트리거 태그 | 비고 |
|---|---|---|---|---|
| `LookingAtNippleIll_v1_byLuminaAzure.safetensors` | 0.5~0.7 | 유두 클로즈업 응시, 모유 사출 | `erect nipple, close-up, breast focus, looking_at_nipple` | 218MB, DL:178 👍39. 모유: `lactation` 추가. 사출: `projectile, shot` 추가 |

### 의상/디테일

| LoRA 파일명 | 강도 | 용도 | 트리거 태그 | 비고 |
|---|---|---|---|---|
| `lace_clothing.safetensors` | 0.4~0.6 | 레이스 의상, 란제리 | `lace` | |

### 분위기/배경

| LoRA 파일명 | 강도 | 용도 | 트리거 태그 | 비고 |
|---|---|---|---|---|
| `DungeonTavern_IL.safetensors` | 0.4~0.7 | 던전 선술집 분위기/스타일 | `dungeontavern` | |
| `witch-cauldron-illustriousxl.safetensors` | 0.4~0.7 | 마녀 가마솥, 포션 제조 연출 | `witch cauldron, cauldron, potion, flask` | |
| `Coc2Styleillustrious.safetensors` | 0.4~0.6 | Corruption of Champions 2 아트스타일 | 없음 | 판타지 RPG풍 |

### 마법/이펙트

| LoRA 파일명 | 강도 | 용도 | 트리거 태그 | 비고 |
|---|---|---|---|---|
| `soul_grasp_v2_ill.safetensors` | 0.5~0.7 | 영혼 움켜쥐기 마법 이펙트 | `soul_grasp, magic` | |
| `mindblowing_IL.safetensors` | 0.4~0.6 | 사이키델릭/정신조작 효과 | `psychedelic, explosion` | |

### 표정/감정

| LoRA 파일명 | 강도 | 용도 | 트리거 태그 | 비고 |
|---|---|---|---|---|
| `looking_up_submissively.safetensors` | 0.5~0.7 | 복종적으로 올려다보는 시선 | `lookingup_submissively` | DL:866, 👍178 |
| `disgusted_face_ilxl_goofy.safetensors` | 0.4~0.7 | 역겨움/혐오 표정 | `disgusted face, shaded face` | 다운로드 25k, 범용성 높음 |
| ~~`cinematic_expression_style_illu_v1.safetensors`~~ | ~~0.4~0.6~~ | ~~시네마틱 감정 전반 강화~~ | — | **🚫 삭제됨** — 텐서 shape 불일치 에러 (파일 손상). `RuntimeError: shape '[1280, 64]' is invalid for input of size 9178` |
| `AhegaoFaceRef-AndroidXL.safetensors` | 0.4~0.7 | 아헤가오 다양한 변형 | `multiple expressions, ahegao, fucked silly` | 레퍼런스 시트 스타일 |
| ~~`The_Look_Illustrious.safetensors`~~ | ~~0.4~0.6~~ | ~~묘한 눈빛/시선 표현~~ | — | **🚫 삭제됨** — 텐서 shape 불일치 에러 (파일 손상) |
| ~~`IL_pain2il.safetensors`~~ | ~~0.4~0.7~~ | ~~고통/공포/울음 표정~~ | — | **🚫 삭제됨** — 텐서 shape 불일치 에러 (파일 손상). `RuntimeError: shape '[32, 2048]' is invalid for input of size 53985` |
| `ReddTheRats_Expressions.safetensors` | 0.4~0.6 | 다양한 감정 표현 | `:D, D:, :o, rolling eyes, tears, drooling, clenched teeth` | 이모티콘 스타일 |
| ~~`Airhead_expression.safetensors`~~ | ~~0.4~0.6~~ | ~~멍한/몽롱한 표정~~ | — | **🚫 삭제됨** — 텐서 shape 불일치 에러 (파일 손상). `RuntimeError: shape '[32, 1280]' is invalid for input of size 8249` |
| `duality__emotion.safetensors` | 0.4~0.6 | 이중 감정 (웃으면서 우는 등) | `duality_emotion` | |

### 변신/상태이상

| LoRA 파일명 | 강도 | 용도 | 트리거 태그 | 비고 |
|---|---|---|---|---|
| `petrification.safetensors` | 0.5~0.8 | 석화 효과 | `petrification, stone body, stone skin, cracked skin` | |
| `petrification_concept_ILXL.safetensors` | 0.5~0.8 | 석화 컨셉 (모노크롬) | `petrification, broken, crack, transformation, mineralization` | |
| `weatheredstatue_anyilxl.safetensors` | 0.5~0.7 | 풍화된 석상, 이끼/덩굴 뒤덮임 | `weathered statue, petrification, overgrown, moss, vines` | |
| `Fountain_Transformation.safetensors` | 0.5~0.7 | 분수대 변신/석화 | `Fountain_transformation, fountain, petrification` | |
| `sweetslimegirls.safetensors` | 0.5~0.7 | 슬라임화, 투명 피부 | `sweetslimegirl, slime skin, slime girl, translucent` | |
| `slime_universe_style.safetensors` | 0.4~0.6 | 슬라임 환경/오브젝트 | `slime theme, gooey translucent slime textures` | |
| `Kwaiiarts_Style.safetensors` | 0.4~0.6 | 심비오트/구 변신, 부패 | `Kwaiiarts_Style, symbiote transformation, goo transformation, corruption` | |

## 규칙

- `[BASE]` LoRA는 기본 적용됨 — 강도 0으로 제거하거나 다른 값으로 오버라이드 가능
- 강도는 보통 0.3~0.7 범위. 1.0 이상은 과적합 위험
- 동시 3개 이내 권장 (base 제외)
- 아트스타일 LoRA는 base 스타일과 상충할 수 있으므로 한 번에 하나만 권장
- 사용 불가능한 LoRA는 자동 스킵됨 (에러 없음)
