---
name: update-state
description: 대화 중 올리브의 상황 변수(기분, 위치, 복장)가 변할 때 호출. 스탯 수치 변경은 엔진이 처리하므로 이 스킬은 상황/서사 변수만 다룬다.
allowed-tools: Read, Edit
---

# 상태 변수 업데이트

## 이 스킬의 범위

**이 스킬이 다루는 변수** (대화 서사에서 자연스럽게 변하는 것들):
- `mood` — 기분 (매우 좋음/좋음/보통/나쁨/매우 나쁨/폭발 직전)
- `location` — 현재 위치 (집, 왕도, 시장, 숲 등)
- `outfit` — 현재 복장 (평상복, 원피스 등)

**이 스킬이 다루지 않는 변수** (엔진이 관리):
- 모든 스탯 수치 (stamina, intelligence, charm 등)
- gold, hp, stress
- schedule_1/2/3, current_month, current_year, age
- 이들은 `engine.js`의 `advance_turn` 등이 처리한다

## 절차

1. `./variables.json`을 읽는다
2. 대화 맥락에서 변경이 필요한 상황 변수를 파악한다
3. 해당 변수만 수정한다
4. JSON 유효성을 확인한다

## 변경 규칙

- `mood`는 스트레스 수치와 최근 대화 분위기를 종합하여 결정
  - stress 0~9: 매우 좋음
  - stress 10~29: 좋음
  - stress 30~49: 보통
  - stress 50~69: 나쁨
  - stress 70~89: 매우 나쁨
  - stress 90+: 폭발 직전
  - 단, 대화 중 즐거운 일이 있으면 스트레스와 무관하게 일시적으로 좋아질 수 있다
- `location`은 올리브가 실제로 이동했을 때만 변경
- `outfit`은 옷을 갈아입었을 때만 변경 (인벤토리의 outfits와 일치해야 함)
- 절대 `_max` 변수나 숫자형 스탯을 이 스킬로 수정하지 마라
