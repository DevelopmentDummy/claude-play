# Style Check System — 공용 문체 점검기 설계

## 배경

현재 `slave_trainer` 페르소나는 자체 엔진(`tools/engine.js`)에 문체 자가검토 루프를 박아 두고 있다. N턴마다 LLM이 직전 응답들을 self-review하고 결과를 `style_drift_verdict` / `style_warning` 변수로 기록 → 다음 user turn의 `[STATE]` 헤더로 노출되어 다음 응답 톤을 보정하게 만든다.

이 구조는 페르소나에 박혀 있어 다른 페르소나(라티스, 향후 RP들)가 재사용할 수 없다. **시스템 공용 기능으로 추출**하는 게 목표.

## 목표

- 문체 자가검토를 페르소나 코드 밖, claude-bridge 코어로 끌어올린다
- 공용 룰셋 + 페르소나별 룰셋 override 패턴
- 옵트인 — 기본 off, 페르소나가 명시적으로 켜야 동작
- 기존 hook 시스템(`hooks/on-compaction-resume.js`)과 동일한 lifecycle hook 패턴으로 통합

## 아키텍처 — 4 레이어

### Layer 1 — 트리거 인프라 (코어)

**위치:** `src/lib/session-instance.ts`

- 응답 턴 카운터를 세션 인스턴스에 추가 (혹은 기존 카운터 활용)
- 임계(`intervalTurns`, 기본 10) 도달 시 lifecycle hook 호출
- hook 경로: `hooks/on-style-check.js` (페르소나 세션 디렉토리 안)
- hook 시그니처:
  ```js
  module.exports = async function ({ variables, data, sessionDir, recentTurns, defaults }) {
    // defaults: data/style-check/defaults.md 내용 (string)
    // recentTurns: 직전 N턴의 user/assistant 메시지 슬라이스
    return {
      fireAi?: { prompt, model?, effort?, notify? }, // 백그라운드 자가검토 트리거
      contextBlock?: string,                          // (선택) 즉시 silent system turn 주입
    };
  };
  ```
- hook이 없으면 비활성 (기본 off)
- 기존 hook 시스템 그대로 재사용 — `runCompactionResumeHook()` 옆에 `runStyleCheckHook()` 추가

### Layer 2 — 공용 룰셋

**위치:** `data/style-check/defaults.md`

LLM 자가검토 프롬프트에 들어가는 일반 문체 가이드. 페르소나 무관하게 적용.

포함 내용 예시:
- `*기울임*` 파편 빈도 (단어 단위 강조 남용 감지)
- 대시(—)로 문장 파편 이어붙이기 (시적 호흡 방지)
- 동일 추상 명사구·후렴어 반복 (어휘 틱)
- 시적 톤이 3인칭 내레이션으로 새어나오는 것
- 응답 길이 편차
- 캐릭터 대사·내레이션·내면독백 톤 분리

각 항목은 LLM이 카운트·예시 인용·verdict 톤으로 보고할 수 있게 구조화.

### Layer 3 — 페르소나 오버라이드

**위치:** `data/sessions/{persona}-{ts}/style-check-rules.md` (선택)

페르소나 고유 룰을 markdown으로. 공용 defaults.md 뒤에 머지되어 LLM에 전달.

포함 예시:
- 캐릭터별 후렴어 블랙리스트 ("한 자락", "한 박자" 등)
- 캐릭터별 톤 가이드 (베스라의 마담 톤 vs 트레이니 톤 분리 등)
- 페르소나 특화 금기 표현

### Layer 4 — 자가검토 실행 + 결과 머지

**실행:**
- hook에서 `fireAi` 반환 → 코어가 `spawnBackgroundClaude()` 호출 (기존 fire_ai 인프라 재사용)
- 백그라운드 세션의 프롬프트:
  ```
  너는 문체 검토관이다. 아래 [룰셋]과 [최근 응답 N개]를 받아
  각 룰 항목별로 위반 여부·빈도·예시를 짧게 보고하라.
  결과는 variables.style_drift_verdict / variables.style_warning에
  update_variables 도구로 직접 기록한 뒤 종료한다.

  [룰셋]
  {공용 defaults.md + 페르소나 rules.md 머지본}

  [최근 응답]
  {recentTurns}
  ```
- 백그라운드 LLM이 변수 갱신 → 다음 user turn의 `[STATE]` 헤더에 자연 노출

**결과 변수(공용 스키마):**
- `style_drift_verdict`: 자가검토 결과 한 줄 요약 (`🎭 문체 정성 평가 — ...`)
- `style_warning`: 다음 응답에서 즉시 정정해야 할 항목 (`⚠ 문체 경고 — ...`)
- `style_check_last_fired`: `Day N (turn M)` 마지막 점검 시점

## 페르소나 옵트인 설정

**위치:** `data/sessions/{persona}-{ts}/style-check.json` (선택, 없으면 비활성)

```json
{
  "enabled": true,
  "intervalTurns": 10,
  "rulesPath": "style-check-rules.md",
  "model": "claude-sonnet-4.6",
  "effort": "low"
}
```

또는 `voice.json`에 통합해도 OK — 별 config 파일 늘리고 싶지 않으면.

## 개발 순서 제안

1. **현황 파악**
   - `slave_trainer`의 `tools/engine.js`에서 `style_check_*` 변수 갱신 흐름 추적
   - LLM 자가검토를 어디서 어떻게 호출하는지 확인 (engine 내부? 별도 hook? 직접 fire_ai?)
   - 분리 가능한 부분 vs 페르소나 고유 부분 마킹

2. **공용 인프라 추가**
   - `src/lib/session-instance.ts`에 `runStyleCheckHook()` 메서드
   - 턴 카운터 + threshold 비교 + hook 로딩 + fire_ai spawn
   - `hooks/on-style-check.js` lifecycle 등록

3. **공용 룰셋 작성**
   - `data/style-check/defaults.md` 초안
   - LLM 프롬프트 템플릿 (`data/style-check/review-prompt.md`?)

4. **페르소나 머지 로직**
   - hook에서 defaults + persona-rules 합쳐 fireAi 프롬프트로 전달

5. **slave_trainer 마이그레이션**
   - 기존 engine.js의 style_check 로직 제거
   - 페르소나에 `hooks/on-style-check.js` + `style-check-rules.md` 작성
   - 기존 변수 스키마(`style_drift_verdict` 등) 그대로 유지 → STATE 헤더 출력 호환

6. **2번째 페르소나에서 검증**
   - 라티스 또는 신규 RP에 옵트인 적용 → 동작 확인

## 고려할 점

- **비용 통제**
  - LLM 자가검토 토큰 누적 주의. `intervalTurns` 기본 10 이상 권장.
  - `effort: "low"` 권장. 문체 점검은 깊은 추론 필요 없음.
  - 페르소나가 끄면 비용 0.

- **노이즈 통제**
  - 자가검토 결과가 매번 잡소리 내면 STATE 헤더 더러워짐.
  - fire_ai 프롬프트에 "위반 없으면 한 줄 OK만" 가이드 박기.
  - `style_warning`은 *조치 필요할 때만* 채우고, 그 외엔 빈 문자열.

- **변수 충돌**
  - 다른 페르소나가 이미 `style_*` 변수 쓰고 있으면 충돌. 공용 스키마 네이밍에 prefix(`_style_check_*`?) 고려.

- **권한·격리**
  - 백그라운드 자가검토 LLM이 변수를 직접 갱신할 수 있어야 함. 기존 fire_ai의 MCP 권한 그대로 사용 가능.

- **자가학습**
  - 페르소나 후렴어 사전을 LLM이 자가검토 결과로 자동 누적할지(rules.md에 자동 append) 결정 필요. 처음엔 수동 편집만 허용 권장.

- **컴팩션 후 동작**
  - 컴팩션이 일어나면 직전 N턴 슬라이스가 압축됐을 수 있음. 컴팩션 직후 1~2턴은 style-check 스킵하거나 다른 소스(`narrative-timeline.json` 등) 활용 검토.

## 참고 — 기존 시스템

- 컴팩션 hook: `data/skills/panel-design/references/engine-and-data.md` 참조
- 코어 hook 실행 위치: `src/lib/session-instance.ts:runCompactionResumeHook()` (라인 685-742 부근)
- fire_ai 백그라운드 세션: `src/lib/background-session.ts:spawnBackgroundClaude()`
- 변수 갱신 경로: 백그라운드 세션 → MCP `run_tool` → 페르소나 engine.js → variables.json

## 변경 영향 파일 (예상)

- `src/lib/session-instance.ts` — hook 실행 메서드 추가
- `docs/session-lifecycle.md` — 새 lifecycle 이벤트 문서화
- `docs/data-model.md` — `data/style-check/` 디렉토리 + 페르소나 옵션 파일
- `data/style-check/defaults.md` — 신규
- `data/style-check/review-prompt.md` — 신규 (LLM 프롬프트 템플릿)
- `data/skills/panel-design/references/engine-and-data.md` — hook 시그니처 명세 추가
- `data/sessions/slave_trainer-*/` — 마이그레이션 (engine.js 정리 + hook/rules 신규)
