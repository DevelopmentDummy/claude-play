# 서브에이전트 고정 모델/프로바이더 지정 (v2.1) — 설계

- 날짜: 2026-06-22
- 상태: 설계 승인 대기
- 선행: [v1 오케스트레이션](2026-06-07-persona-subagent-orchestration-design.md), [v2 세션 provider 상속](2026-06-09-subagent-follow-session-provider-design.md)
- 후속(별도 스펙): 서브에이전트 대화 모달 패널 + 대화 내역 (이 스펙 범위 밖)

## 배경 / 문제

v2(2026-06-09)에서 서브에이전트는 세션의 `provider/model/effort`를 **강제 상속**한다. 매니페스트의 `provider/model/effort` 필드는 파싱은 되지만 런타임에서 무시된다(`subagent-manifest.ts`의 "v2: ... ignored at runtime" 주석, `subagent-manager.ts:spawnAll`이 세션값만 사용).

요구사항: **서브별로 다른 모델/프로바이더를 설정 단계에서 고정 지정**할 수 있어야 한다 (예: 문체 검토 서브는 Gemini, 개발 백그라운드 서브는 GPT). **미지정이면 기존처럼 세션 모델을 따라간다.**

### 이미 시작된 작업 (working tree, 미커밋)

세션 시작 시점에 `subagent-manifest.ts`와 `subagent-manager.ts`에 이 기능의 lib 절반이 이미 구현돼 있었다(커밋 안 됨, 메모리 미기록):

- `subagent-manifest.ts`: `model?`/`effort?`를 "무시되는 back-compat" → "per-sub 오버라이드, 미지정 시 세션 폴백"으로 격상. `providerExplicit?: AIProvider` 신설(매니페스트가 **실제로** provider를 지정했을 때만 set → 모든 서브에 `"claude"`를 강제하던 문제 회피). 주석 v2 → v2.1.
- `subagent-manager.ts:spawnAll`: def별로 `subProvider = def.providerExplicit ?? provider`, `subModel = def.model ?? model`, `subEffort = def.effort ?? effort`로 resolve해 인스턴스 생성/캐시 비교.

이 작업은 **분리 필드(provider/model/effort 각각) 방식**이며 **미완성**이다 — `bridge_define_subagent` MCP, `builder-prompt.md`, 문서는 손대지 않았다. 본 스펙은 이를 베이스로 **절충안**으로 완성한다.

> 비고: 같은 working tree의 `package.json` typescript 5.9.3 → 5.8.2 다운그레이드는 본 기능과 무관하며 **건드리지 않는다**.

## 목표

1. 빌더(`bridge_define_subagent`)가 서브 정의 시 **단일 `model` 문자열**(effort suffix 포함 가능)로 모델을 지정할 수 있다.
2. 미지정이면 그 서브는 세션의 `provider/model/effort`를 그대로 따라간다(현행 동작 보존).
3. 5개 provider(Claude/Codex/Gemini/Kimi/Antigravity) 전부 지정 가능.
4. **provider–model 어긋남 불가** — provider는 model id에서 도출(`providerFromModel`)하므로 사용자가 따로 provider를 고를 일이 없다.

## 비목표

- 사용자가 직접 조작하는 전용 설정 UI (빌더 대화 경유만). 단, 고급 사용자가 `subagents.json`을 수동 편집하는 경로는 막지 않는다.
- 서브에이전트 대화 모달 패널 / 대화 내역 표시 (후속 별도 스펙).
- always-on 상주 모델 변경 (v1 키스톤 결정 1 유지 — 지정된 서브도 세션 open 시 상주).
- `package.json` typescript 버전 변경.

## 절충안 — 핵심 결정

**저장은 분리 필드(이미 구현됨)를 유지하되, 빌더 입력과 분해는 단일 `model` 문자열을 1차 소스로 한다.**

- 입력 단순(모델 id 하나) + 세션 모델 선택기 형식과 일관(`"gpt-5.4:high"`, `"gemini-3-flash-preview"`).
- provider는 항상 model에서 도출 → 어긋남 불가.

### MCP `.mjs` 제약과 분해 위치

`src/mcp/claude-play-mcp-server.mjs`는 `.mjs`라 TS 모듈(`ai-provider.ts`)을 import할 수 없다(메모리의 `MAX_SUBAGENTS` 값 복제 사례와 동일 제약). 따라서 `providerFromModel`/`parseModelEffort` 분해를 **MCP에서 하지 않는다**(로직 복제 회피). 대신:

- **MCP는 단일 `model` 문자열을 매니페스트에 그대로 저장**한다(분해 없음).
- **분해/도출은 `validateManifest`(.ts)** 가 매니페스트를 읽는 시점에 수행한다 — `providerFromModel`/`parseModelEffort`를 정식 import해 분리 필드(`providerExplicit`/`model`/`effort`)를 채운다.

결과(어긋남 불가·단일 입력)는 사용자가 선택한 절충안과 동일하며, 분해 위치만 MCP→validateManifest로 옮겨 로직 중복을 없앤다.

## 설계

### 1. 데이터 모델 — `src/lib/subagent-manifest.ts`

분리 필드(`providerExplicit`/`model`/`effort`)는 유지. `validateManifest`가 **단일 `model` 문자열을 1차 소스로** 분리 필드를 채우도록 수정한다.

각 항목에 대해:

```text
const rawModel = (typeof e.model === "string" && e.model.trim()) ? e.model.trim() : undefined;
const { model: baseModel, effort: suffixEffort } = rawModel
  ? parseModelEffort(rawModel)              // "gpt-5.4:high" → { model: "gpt-5.4", effort: "high" }
  : { model: undefined, effort: undefined };

// provider: 매니페스트가 명시했으면 그것(legacy 수동 편집 존중), 아니면 model에서 도출.
let providerExplicit: AIProvider | undefined;
if (typeof e.provider === "string" && e.provider.trim()) {
  providerExplicit = e.provider.trim() as AIProvider;
} else if (rawModel) {
  try { providerExplicit = providerFromModel(rawModel); }
  catch { providerExplicit = undefined; }   // gemini disabled 등 → 세션 폴백 + 경고 로그
}

const model = baseModel;                      // 분리 필드: effort suffix 제거된 순수 model
const effort = (typeof e.effort === "string" && e.effort.trim())
  ? e.effort.trim()                           // legacy 명시 effort 우선
  : suffixEffort;                             // 아니면 model suffix에서
```

- `provider`(기존 default-fill 필드)는 `providerExplicit ?? "claude"`로 종전과 동일하게 채워 back-compat 소비자 보호.
- `providerFromModel` 도출 실패(예: `NEXT_PUBLIC_DISABLE_GEMINI=true`인데 gemini model 지정)는 **그 항목만** `providerExplicit=undefined`로 떨궈 세션 폴백시키고 `console.warn`. 매니페스트 전체를 invalid로 만들지 않는다.
- 오타 등 어느 prefix에도 안 걸리는 model id는 `providerFromModel`이 `"claude"`를 반환한다(현행 동작). 완전한 화이트리스트 검증은 하지 않는다(YAGNI) — 빌더 프롬프트의 유효 id 예시로 예방.

### 2. Resolve / Spawn — `src/lib/subagent-manager.ts`

이미 구현된 def별 resolve를 유지하되 **effort 폴백 규칙을 정교화**한다. 현재는 `subEffort = def.effort ?? effort`(무조건 세션 effort 폴백)인데, provider가 세션과 다르면 세션 effort가 부적합하다(예: 세션 `opus:max`인데 서브가 gemini → `max`는 gemini에 무의미).

규칙:

```text
const subProvider = def.providerExplicit ?? sessionProvider;
const subModel    = def.model ?? sessionModel;
const subEffort   =
  def.effort                                  // suffix/legacy로 정해진 서브 effort 우선
  ?? (subProvider === sessionProvider ? sessionEffort  // 같은 provider면 세션 effort 상속 OK
                                      : undefined);      // 다른 provider면 그 provider 기본에 맡김
```

- 캐시 비교(`inst.provider/model/effort !== sub*`)와 인스턴스 생성에 resolve된 값 사용(이미 구현됨).
- `inst.start()`는 이미 try/catch로 감싸져 한 서브 spawn 실패가 다른 서브를 막지 않는다. 도출은 `validateManifest`에서 끝나므로 `spawnAll` 루프에 추가 throw 지점은 없다.

### 3. 인스턴스 — `src/lib/subagent-instance.ts`

**무변경.** 생성자가 이미 `provider/model/effort`를 받아 처리하고, `.resume-{provider}` 네임스페이스·kimi sticky id 비캡처·antigravity reap 등 provider별 분기가 모두 있다. provider가 고정되면 재오픈마다 같은 `.resume-{provider}`를 써서 오히려 연속성이 안정적이다.

### 4. 정의 경로 — `src/mcp/claude-play-mcp-server.mjs` (`bridge_define_subagent`)

- optional `model` 파라미터 추가: `model: z.string().optional().describe("...")`. 단일 모델 id(effort suffix 포함 가능). **미지정 시 세션 상속.**
- entry 머지에 `...(input.model && input.model.trim() ? { model: input.model.trim() } : {})` 추가. 미지정이면 키 자체를 안 넣어 "세션 상속" 시맨틱 유지. (재정의로 model을 비우려면 빈 문자열 처리는 별도 — v1 범위 밖, 수동 편집으로 가능.)
- **분해하지 않는다**(`.mjs` 제약) — `model` 문자열만 저장.
- description 갱신: 현재 "A sub automatically runs on the SAME provider and model/effort as the session ... you do not choose a provider or model here." → "By default a sub follows the session's provider/model/effort. Optionally pin a sub to a specific model with `model` (a single id like `gemini-3-flash-preview` or `gpt-5.4:high`); the provider is inferred from the id. The chosen provider's CLI must be authenticated. Omit `model` to follow the session."

### 5. 빌더 프롬프트 — `builder-prompt.md` (서브에이전트 섹션, ~1340–1380)

- `1346`줄의 "**provider·모델은 지정하지 않는다** — 서브는 세션을 연 provider/모델/effort를 자동으로 따라간다" 를 다음으로 교체:
  - 기본은 미지정(세션 상속).
  - 다른 모델/프로바이더가 유리하면 `model`에 **단일 id**를 지정한다. provider는 id에서 자동 판별된다.
    - 예: 가볍고 빈번한 부기 → `gemini-3-flash-preview` 또는 `gpt-5.4`; 무거운 일관성 분석 → `gpt-5.4:high` 또는 `opus[1m]:high`.
  - ⚠️ 지정한 provider의 CLI가 **인증돼 있어야** 한다(미인증 시 그 서브만 spawn 실패, 메인엔 영향 없음).
  - ⚠️ Antigravity(`antigravity-*`)는 spawn이 무겁고 tool-call 안정성이 낮으니 꼭 필요할 때만.
- 인자 목록에 `model?` 항목 추가(단일 id, 미지정=세션 상속).
- 예시 jsonc에 `"model": "gemini-3-flash-preview"` 지정 변형을 한 줄 주석과 함께 추가.
- 유효 id 힌트로 `ai-provider.ts` `MODEL_GROUPS`의 대표 값을 몇 개 나열(Claude `opus[1m]`/`sonnet`, Codex `gpt-5.4`/`gpt-5.5`, Gemini `gemini-3-flash-preview`/`gemini-3.1-pro-preview`, Kimi `kimi-auto`, Antigravity `antigravity-flash`).

### 6. 문서 — `docs/session-lifecycle.md`

서브에이전트 항목의 "세션 provider를 따라간다" 서술을 "기본은 세션 상속, 매니페스트 `model` 지정 시 그 모델로 고정(provider는 id에서 도출, effort는 suffix 또는 동일 provider일 때만 세션 상속)"으로 갱신.

## 폴백 시맨틱 (요약)

| 매니페스트 `model` | subProvider | subModel | subEffort |
|---|---|---|---|
| 미지정 | 세션 provider | 세션 model | 세션 effort |
| 지정, provider == 세션 | 도출 provider(=세션) | 도출 base model | suffix effort ?? 세션 effort |
| 지정, provider != 세션 | 도출 provider | 도출 base model | suffix effort ?? (해당 provider 기본) |
| 지정했으나 도출 실패(gemini disabled 등) | 세션 provider | 세션 model | 세션 effort (+ 경고 로그) |

## 엣지 케이스

- **미인증 provider 지정** → 해당 서브 프로세스 spawn 실패. `spawnAll`이 로그만 남기고 open flow엔 던지지 않음(현행 정책). 메인 서사 정상.
- **gemini disabled + gemini model 지정** → `validateManifest`에서 도출 실패를 잡아 그 서브만 세션 폴백 + 경고.
- **무효/오타 model id** → `providerFromModel`이 `"claude"` 반환 → claude 프로세스로 spawn. 빌더 프롬프트의 유효 id 예시로 예방(화이트리스트 강검증은 하지 않음).
- **빌더가 model 재정의 후 재오픈** → `spawnAll`이 resolved runtime 차이를 감지해 기존 서브 destroy & recreate.

## 영향 파일

| 파일 | 변경 |
|---|---|
| `src/lib/subagent-manifest.ts` | `validateManifest`가 단일 `model`에서 분리 필드 도출(`providerFromModel`/`parseModelEffort` import, try/catch) |
| `src/lib/subagent-manager.ts` | `spawnAll` effort 폴백 3분기(동일 provider일 때만 세션 effort 상속) |
| `src/mcp/claude-play-mcp-server.mjs` | `bridge_define_subagent`에 `model?` 파라미터 + entry 머지 + description 갱신 |
| `builder-prompt.md` | 서브에이전트 섹션: 모델 지정 안내/인자/예시/유효 id |
| `docs/session-lifecycle.md` | 서브에이전트 항목 서술 갱신 |

`subagent-instance.ts`·`ai-process-factory.ts`·`open/route.ts`·5개 provider 프로세스 클래스는 무변경(재사용).

## 검증

- `npx tsc --noEmit` 그린 (next build 금지 — 라이브 `.next`).
- 라이브 스모크(사용자, 인증된 provider로):
  1. 서브 1개에 세션과 **다른** provider model 지정(예: 세션 claude, 서브 `gemini-3-flash-preview`) → 세션 open → `data/sessions/{id}/subagents/{name}/sub.log`에 해당 provider 프로세스 기동 + `.resume-gemini` 생성 확인.
  2. model **미지정** 서브 → 세션 provider 그대로 따라가는지 확인.
  3. 빌더로 `model` 재정의 → 세션 닫았다 다시 열어 갈아끼워지는지 확인.

## 향후 (별도 스펙)

서브에이전트 대화 모달 패널 + 서브↔메인 대화 내역 표시. 필요한 신설 인프라: ① 서브 응답 캡처(현재 `message` 미구독, sub.log로만 감) ② 서브별 대화 transcript 영속화 ③ 사용자→서브 직접 입력 라우트 ④ React 네이티브 대화 모달 UI ⑤ 실시간 `subagent:message` WS 푸시. "기존 대화 내역"은 현재 영구 기록이 없어 *지금부터 기록 시작* 형태가 된다.
