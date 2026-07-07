# Shared Document Map

이 프로젝트는 **루트 레벨 공용 문서**들이 빌더 / 세션 작업 디렉토리로 전파되는 구조다. 각 문서의 역할과 독자를 이해해야 변경 시 올바른 곳을 업데이트할 수 있다.

| Document | Audience | Purpose | Propagation |
|----------|----------|---------|-------------|
| `builder-prompt.md` | Builder AI | 페르소나 빌더 워크플로우, 파일 생성 명세 (Handlebars로 컨텍스트 주입) | 빌더 세션 시작/편집 시마다 → 페르소나 디렉토리의 `CLAUDE.md` / `AGENTS.md` / `GEMINI.md`에 매번 덮어쓰기 |
| `builder-primer.yaml` | Builder AI | 빌더 모드 시스템 프롬프트 래퍼 | 빌더 세션 시작/편집(respawn) 시 `active_system_prompt` 추출 → AI 런타임 시스템 프롬프트로 전달 (codex/gemini/kimi는 세션 플로우처럼 디스크 파일로도 기록) |
| `session-primer.yaml` | Session AI (Claude) | RP 세션 시스템 프롬프트 (캐릭터 몰입, 가이드라인) | 세션 Open 시 `active_system_prompt` 추출 → AI 런타임 시스템 프롬프트로 전달 (디스크에 쓰이지 않음) |
| `session-primer-codex.yaml` | Session AI (Codex / Kimi) | Codex·Kimi용 RP 세션 시스템 프롬프트 | 세션 Open 시 → Codex: `.codex/model-instructions.md`에 기록 (config.toml `model_instructions_file` + spawn 시 `CODEX_HOME` 리포인트로 로드) / Kimi: 세션 `AGENTS.md`에 CLAUDE.md와 병합 기록 |
| `session-primer-gemini.yaml` | Session AI (Antigravity / retired Gemini CLI) | Antigravity(구 Gemini)용 RP 세션 시스템 프롬프트 | 세션 Open 시 → Antigravity: spawn `--prompt-interactive`로 전달 (`GEMINI.md`에는 세션 instructions만 기록) / (retired) Gemini CLI: `GEMINI.md`에 병합. `NEXT_PUBLIC_DISABLE_GEMINI=true`(현재 설정) 시 gemini-* 모델은 Antigravity로 라우팅됨 |
| `session-shared.md` | Session AI (all providers) | 공용 세션 가이드 (응답 형식, OOC, STT, 이미지 생성, 선택지 시스템, 패널 액션, scene break) | 세션 Open 시 primer와 결합 → AI 런타임 시스템 프롬프트로 전달 |
| `panel-spec.md` | Builder / Session AI | 패널 시스템 기술 레퍼런스 (Handlebars, panelBridge, placement, 패널 액션 메타 등) | 빌더 세션 시작 및 RP 세션 Open 시 → 작업 디렉토리로 복사 (매번 최신본으로 갱신) |

## Document Assembly Flow

**빌더 세션 시작/편집** (`POST /api/builder/start`, `POST /api/builder/edit`):
```
builder-prompt.md (Handlebars 컴파일)
  → 페르소나 디렉토리 CLAUDE.md / AGENTS.md / GEMINI.md (매번 덮어쓰기)
builder-primer.yaml → AI 런타임 시스템 프롬프트
  (codex/gemini/kimi는 .codex/model-instructions.md / GEMINI.md / AGENTS.md에도 기록)
panel-spec.md → 페르소나 디렉토리에 복사 (참조용)
빌더 전용 스킬 (data/builder_skills/*) → 페르소나 .claude/skills/
  (Claude 전용 — 글로벌 data/skills/*는 빌더 플로우에서 복사되지 않음)
```

**RP 세션 생성** (`POST /api/sessions`):
```
persona/session-instructions.md
  + style section (style.json이 있으면)
  + profile section (프로필이 있으면)
  + opening section (opening.md가 있으면)
  → 세션 CLAUDE.md / AGENTS.md / GEMINI.md
  (session-instructions.md 원본도 sync diff용으로 세션에 그대로 보존)
persona files (panels/, tools/, hooks/, variables.json, *.json, ...)
  → 세션 디렉토리에 복사
  (.sessionignore 항목은 제외, images/는 profile.png/icon.png만 선별 복사)
panel-spec.md → 세션 디렉토리에 복사
런타임 config 생성 (.claude/settings.json, .mcp.json 등 — Open 시에도 갱신)
페르소나 skills/ + 글로벌 공유 스킬 (data/skills/*) + 도구 스킬 (data/tools/*/skills/*)
  → 세션 .claude/.agents/.kimi/skills/
  (.gemini/skills는 생성 시점엔 없음 — Open 시 refreshToolSkills가 생성)
```

**RP 세션 Open** (`POST /api/sessions/[id]/open`):
```
session-primer{,-codex,-gemini}.yaml + session-shared.md
  → AI 런타임 시스템 프롬프트 (provider별 primer 선택 + 전달 경로 분기):
    Claude      → session-primer.yaml, spawn append-system-prompt (디스크 미기록)
    Codex       → session-primer-codex.yaml, .codex/model-instructions.md에 기록
    Kimi        → session-primer-codex.yaml, 세션 AGENTS.md에 CLAUDE.md와 병합 기록
    Antigravity → session-primer-gemini.yaml, spawn --prompt-interactive
                  (GEMINI.md는 세션 instructions만 — persona-only)
    Gemini CLI  → session-primer-gemini.yaml, GEMINI.md에 병합 (retired 경로)
panels/_actions.meta.json → 패널 액션 스펙 markdown으로 직렬화 → 시스템 프롬프트에 주입
panel-spec.md → 세션 디렉토리에 갱신 (최신본)
글로벌 + 도구 스킬 → 세션 skills 디렉토리에 갱신 (refreshToolSkills — .gemini 포함 4곳)
persona에 새로 추가된 파일 → 세션에 additive mirror (mirrorNewPersonaFiles, 기존 파일 미덮어씀)
런타임 config 갱신 (.claude/settings.json, .mcp.json, .codex/config.toml,
  .gemini/settings.json, .agents/mcp_config.json, policy-context.json — runtime-config.ts)
```

## Assembly Notes

- **프롬프트 재조립은 Open 외에도 발생**: `POST /api/sessions/[id]/sync`와 `POST /api/sessions/[id]/options/apply`도 시스템 프롬프트를 다시 조립하고 `writeInstructionsForProvider`(`src/lib/respawn-helpers.ts`)로 provider별 instruction 파일을 재기록한다.
- **fire_ai 백그라운드 AI도 같은 primer를 소비**: `useSessionContext:true`면 `background-session.ts`의 `buildSystemPromptForSession()`이 동일한 primer + session-shared.md 조합을 provider별로 조립한다 — primer 수정은 세션 Open뿐 아니라 백그라운드 실행에도 영향.
- **플레이스홀더/템플릿 처리** (`src/lib/prompt-assembly.ts`): 조립 시 `{agent_name}`/`{user_name}` 치환 후, `.md` 가이드 파일은 `{ options }` 컨텍스트로 Handlebars 컴파일된다 — session-shared.md 안의 리터럴 `{{...}}`는 템플릿 문법으로 해석되므로 주의.
