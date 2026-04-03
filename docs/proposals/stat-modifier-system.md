# 제안서: 스탯 모디파이어 시스템

## 배경

현재 가치관 선택이 단발성 스탯 변화(+3, -2)로 끝나서 장기적 영향이 약하다.
가치관 선택이 영구적 성장 계수(modifier)를 조정하여 이후 모든 스탯 획득에 영향을 주는 시스템으로 개편한다.

## 핵심 개념

### 1. 스탯 모디파이어
각 스탯에 곱셈 계수(기본 1.0)가 붙는다. 모든 스탯 변화가 이 계수를 거친다.

```json
// variables.json
"__stat_modifiers": {
    "combat": 1.2,      // 전투 관련 획득량 +20%
    "sensitivity": 0.9,  // 감수성 획득량 -10%
    // 없는 키 = 1.0 기본
}
```

### 2. Float 내부, Integer 표시
- 내부: 모든 스탯을 float으로 저장 (예: `stamina: 112.7`)
- 표시: `Math.floor()`로 정수 변환
- 증감 표기: `floor(new) - floor(old)` = 정수 단위 차이

예시:
- 3.5 → 4.8: 표시 +1 (floor 3→4)
- 4.8 → 6.2: 표시 +1 (floor 4→6, 아 이건 +2)
- 2.1 → 2.9: 표시 +0 (floor 2→2, 변화 없음)

### 3. 가치관 선택 형식 변경
```json
{
    "label": "지키는 거야. 소중한 걸.",
    "effects": {"morals": 5, "combat": 2},
    "modifiers": {"combat": 0.1, "morals": 0.05}
}
```
- `effects`: 즉시 스탯 변화 (기존, 유지)
- `modifiers`: 영구 계수 조정 (신규). ±0.1 스케일.

## 중앙화 함수

### applyStat
```js
function applyStat(v, stat, rawDelta, modifiers) {
    const mod = (modifiers || {})[stat] || 1.0;
    const actualDelta = rawDelta * mod;
    const max = v[stat + '_max'] || (stat === 'stress' ? 100 : 999);
    const oldVal = v[stat] || 0;
    v[stat] = clamp(oldVal + actualDelta, 0, max);
    return Math.floor(v[stat]) - Math.floor(oldVal);
}
```

### applyStatChanges (배치)
```js
function applyStatChanges(v, changes, modifiers) {
    const displayDeltas = {};
    for (const [stat, delta] of Object.entries(changes)) {
        const d = applyStat(v, stat, delta, modifiers);
        if (d !== 0) displayDeltas[stat] = d;
    }
    return displayDeltas;
}
```

## 리팩토링 대상

engine.js에서 `v[stat] = clamp(v[stat] + delta, ...)` 패턴을 `applyStat` 호출로 교체:

| 위치 | 함수/경로 | 설명 |
|------|----------|------|
| `simulateSlotDaily` | 일별 스탯 적용 | dailyStats, dailySideEffects, dailyBonus |
| old single-roll path | effects/side_effects/stat_bonus | 휴식, 모험 등 |
| `talk_to_father` | 대화 효과 + 배경 보너스 | |
| adventure fight | exp_combat 적용 | |
| competition | 보상 적용 | |
| values choice | effects 적용 + modifiers 적용 | 11-values.html |
| `buy_item`/`use_item` | 아이템 효과 | |
| `equip` | 장비 스탯 | 모디파이어 미적용? (장비는 고정값) |
| `advanceMonth` | 양육비, 스트레스 폭발 | |

### 모디파이어 미적용 대상
- 장비 착용/해제 (고정 보너스)
- 골드 변동 (수입, 비용)
- HP 변동 (전투 데미지, 회복)

## 표시 처리

### advance 패널 (일별 시뮬레이션)
- `cumulative_vars` 스냅샷: floor 처리하여 정수 표시
- 일별 변화량: `floor(today) - floor(yesterday)`
- 결과 카드의 `stat_changes`: 엔진이 반환하는 display delta 사용

### [STATE] 힌트 라인
- `hint-snapshot.ts`에서 값 표시 시 `Math.floor()` 적용
- `buildHintSnapshotLine`에서 float → int 변환

### 패널 게이지
- `02-stats.html`에서 `d[statKey]`를 `Math.floor(d[statKey])` 로 표시
- 게이지 바 width 계산은 float 그대로 사용 (부드러운 진행)

## 가치관 선택 → 모디파이어 적용 흐름

1. 사용자가 가치관 선택
2. `11-values.html` 패널에서 `effects` 적용 (즉시 스탯)
3. `modifiers` 적용: `__stat_modifiers[stat] += modifier_value`
4. 이후 모든 스탯 변화에 새 계수 반영

## 계수 범위 가이드

| 계수 | 의미 | 예시 |
|------|------|------|
| 0.5 | 반감 | 심각한 패널티 |
| 0.8 | 약간 감소 | 관심 없는 분야 |
| 1.0 | 기본 | 변동 없음 |
| 1.2 | 약간 증가 | 관심 있는 분야 |
| 1.5 | 크게 증가 | 핵심 가치관 |
| 2.0 | 두 배 | 극단적 특화 |

가치관 1회 선택당 ±0.05~0.15 범위. 8년간 수십 회 선택이 누적되면 1.5~2.0까지 갈 수 있음.

## 구현 순서

### 단계 1: 기반
- [ ] `__stat_modifiers` 변수 추가 (variables.json)
- [ ] `applyStat` / `applyStatChanges` 헬퍼 구현 (engine.js 상단)
- [ ] 기존 스탯을 float으로 유지하되, 현재 정수값은 그대로 (하위 호환)

### 단계 2: 엔진 리팩토링
- [ ] `simulateSlotDaily`의 모든 스탯 적용을 `applyStat`으로 교체
- [ ] old single-roll path 교체
- [ ] `talk_to_father` 교체
- [ ] adventure/competition 교체
- [ ] buy/use/equip 교체 (장비는 모디파이어 미적용)

### 단계 3: 가치관 패널
- [ ] `11-values.html`에서 `modifiers` 필드 처리 추가
- [ ] `__stat_modifiers` 업데이트 로직
- [ ] AI의 `__values_prompt` 생성 시 `modifiers` 필드 가이드

### 단계 4: 표시
- [ ] advance 패널의 stat_changes를 display delta 기반으로 수정
- [ ] `02-stats.html` 게이지 값 floor 처리
- [ ] `hint-snapshot.ts` / MCP 서버의 값 표시 floor 처리
- [ ] [STATE] 라인에서 정수 표시

### 단계 5: CLAUDE.md 가이드
- [ ] 가치관 선택 시 `modifiers` 필드 작성 가이드
- [ ] 계수 범위 가이드
- [ ] 서사에서 계수 직접 언급 금지 (기존 스탯 수치 비언급 규칙 확장)

## 미해결 사항

1. **음수 모디파이어**: 계수가 0 이하가 되면? → 최소값 0.1로 클램프?
2. **스트레스 모디파이어**: 스트레스 증가에도 모디파이어 적용? 계수가 높으면 스트레스도 더 받음? → 스트레스는 모디파이어 미적용이 나을 수 있음
3. **모디파이어 표시**: 사용자에게 현재 모디파이어를 보여줄 UI? → 스탯 패널에 화살표(↑↓) 아이콘?
4. **기존 세션 마이그레이션**: 이미 진행 중인 세션에 모디파이어 추가 시 기본값 1.0으로 초기화
