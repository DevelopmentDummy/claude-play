# 설계: 모델 선택기 advisor 프리셋 (베이스 + advisor 조합)

- 날짜: 2026-07-09
- 상태: 설계 승인됨 (구현 계획 대기)
- 범위: Claude 프로바이더 전용

## 배경 / 목적

Claude Code(`claude -p`)에는 `advisor` 도구를 뒷받침하는 모델을 지정하는 `--advisor <model>`
플래그(및 `advisorModel` 설정)가 있다. 현재는 유저 전역 `~/.claude/settings.json`의
`advisorModel: fable`로만 제어되어 모든 세션·모든 프로젝트에 공통 적용된다.

우리 서비스(Claude Bridge)의 세션 모델 선택기에서 **"opus 베이스 + fable advisor"** 같은 조합을
세션 단위로 고를 수 있게 하는 것이 목표. 이번 범위에서는 **고정 프리셋 3개**만 노출한다.

## 승인된 프리셋 (Claude 그룹)

| value | label |
|-------|-------|
| `opus@fable` | Opus + Fable advisor |
| `opus:high@fable` | Opus High + Fable advisor |
| `opus:ultracode@fable` | Opus Ultracode + Fable advisor |

## 인코딩

모델 값 문법을 확장: `<baseModel>[:<effort>][@<advisor>]`

- `@<advisor>` 접미사(옵션). advisor 값은 별칭(`fable`/`opus`/`sonnet`) 또는 전체 모델 id.
- `@`는 기존 어떤 모델 id에도 쓰이지 않아(`external/…`, `moonshot-ai/…` 포함) 충돌 없음.
- `providerFromModel`은 `:` 앞 첫 토큰만 보므로 `@advisor`가 붙어도 provider 판정 정상.

## 컴포넌트별 변경

### 1. `src/lib/ai-provider.ts`
- `parseModelEffort`를 `{ model, effort, advisor }` 반환으로 확장.
  - 먼저 `@`를 기준으로 advisor를 분리한 뒤 나머지를 `:`로 쪼갬(effort 슬롯 오염 방지).
  - **하위호환**: 기존 호출부는 `{ model, effort }`만 구조분해 → advisor는 조용히 무시됨.
- `resolveBuilderModel`도 advisor를 보존해 반환·재조립(`combined`에 `@advisor` 유지)하도록 확장.
  빌더 재open 시 advisor 유실 방지.
- `MODEL_GROUPS`의 Claude 그룹에 위 프리셋 3개 추가.

### 2. `src/lib/claude-process.ts`
- `spawn(...)` 시그니처에 후행 옵션 파라미터 `advisor?: string` 추가.
  - 존재 시 `args.push("--advisor", advisor)`.
  - `lastSpawnParams`에 저장 → `respawn()` 복구 경로에서도 유지.
- ClaudeProcess 전용이므로 provider 가드 불필요.

### 3. Claude spawn 호출부 (advisor 배선)
아래는 모두 이미 `parseModelEffort`(또는 `resolveBuilderModel`)를 호출 중 → 새 `advisor`를
`instance.claude.spawn(...)` 인자로 전달하는 변경만 필요:
- `src/app/api/sessions/[id]/open/route.ts`
- `src/app/api/sessions/[id]/options/apply/route.ts`
- `src/app/api/sessions/[id]/sync/route.ts`
- `src/app/api/builder/start/route.ts`
- `src/app/api/builder/edit/route.ts`

### 4. 프론트엔드
변경 없음. 모델 선택기는 `MODEL_GROUPS`의 value/label을 그대로 렌더.

## 비-목표 (YAGNI)

- 조합 자유 선택(별도 advisor 드롭다운) — 이번 범위 아님.
- Claude 외 프로바이더의 advisor — 개념 없음, 대상 아님.
- fire_ai / 서브에이전트 경로의 advisor 전파 — 이번 범위 아님(필요 시 후속).

## 알려진 한계 / 기대치

1. `advisor` 도구는 모델이 자발적으로 호출할 때만 작동. RP 페르소나 세션에선 호출이 드묾 →
   실효는 코딩/빌더성 페르소나 또는 advisor 사용을 유도하는 프롬프트에서만 체감됨.
2. 현재 유저 전역 `advisorModel: fable`이므로, `opus@fable` 프리셋은 현 시점 기능상 plain `opus`와
   동일. 프리셋의 가치는 (a) 세션별 다른 advisor 명시 지정, (b) 전역값 변경에도 고정.

## 검증

- `npm run typecheck` (parseModelEffort 시그니처 변경 파급 확인).
- `npm run verify` (커밋 전 게이트).
- `--advisor` 플래그 유효성은 확인됨: `claude 2.1.204`에서 `claude --advisor fable -p …` 정상 실행.
- 라이브 스모크(권장): 선택기에서 프리셋으로 세션 생성 → spawn 로그(`claude-stream.log`의
  `args:` 라인)에 `--advisor fable` 포함 확인.
