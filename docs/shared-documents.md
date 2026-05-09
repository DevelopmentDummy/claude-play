# Shared Document Map

이 프로젝트는 **루트 레벨 공용 문서**들이 빌더 / 세션 작업 디렉토리로 전파되는 구조다. 각 문서의 역할과 독자를 이해해야 변경 시 올바른 곳을 업데이트할 수 있다.

| Document | Audience | Purpose | Propagation |
|----------|----------|---------|-------------|
| `builder-prompt.md` | Builder AI | 페르소나 빌더 워크플로우, 파일 생성 명세 (Handlebars로 컨텍스트 주입) | 빌더 세션 시작/편집 시마다 → 페르소나 디렉토리의 `CLAUDE.md` / `AGENTS.md` / `GEMINI.md`에 매번 덮어쓰기 |
| `builder-primer.yaml` | Builder AI | 빌더 모드 시스템 프롬프트 래퍼 | 빌더 세션 시작 시 `active_system_prompt` 추출 → AI 런타임 시스템 프롬프트로 전달 |
| `session-primer.yaml` | Session AI (Claude / Kimi) | RP 세션 시스템 프롬프트 (캐릭터 몰입, 가이드라인) | 세션 Open 시 `active_system_prompt` 추출 → AI 런타임 시스템 프롬프트로 전달 (디스크에 쓰이지 않음) |
| `session-primer-codex.yaml` | Session AI (Codex) | Codex용 RP 세션 시스템 프롬프트 | 세션 Open 시 → Codex `baseInstructions`로 전달 |
| `session-primer-gemini.yaml` | Session AI (Gemini) | Gemini용 RP 세션 시스템 프롬프트 | 세션 Open 시 → `GEMINI.md`에 병합 |
| `session-shared.md` | Session AI (all providers) | 공용 세션 가이드 (응답 형식, OOC, STT, 이미지 생성, 선택지 시스템, 패널 액션, scene break) | 세션 Open 시 primer와 결합 → AI 런타임 시스템 프롬프트로 전달 |
| `panel-spec.md` | Builder / Session AI | 패널 시스템 기술 레퍼런스 (Handlebars, panelBridge, placement, 패널 액션 메타 등) | 빌더 세션 시작 및 RP 세션 Open 시 → 작업 디렉토리로 복사 (매번 최신본으로 갱신) |

## Document Assembly Flow

**빌더 세션 시작/편집** (`POST /api/builder/start`, `POST /api/builder/edit`):
```
builder-prompt.md (Handlebars 컴파일)
  → 페르소나 디렉토리 CLAUDE.md / AGENTS.md / GEMINI.md (매번 덮어쓰기)
builder-primer.yaml → AI 런타임 시스템 프롬프트
panel-spec.md → 페르소나 디렉토리에 복사 (참조용)
글로벌 공유 스킬 (data/skills/*) + 빌더 전용 스킬 (data/builder_skills/*)
  → .claude/skills/ + .agents/skills/ + .gemini/skills/ + .kimi/skills/
```

**RP 세션 생성** (`POST /api/sessions`):
```
persona/session-instructions.md
  + style section (style.json이 있으면)
  + profile section (프로필이 있으면)
  + opening section (opening.md가 있으면)
  → 세션 CLAUDE.md / AGENTS.md / GEMINI.md
persona files (panels/, tools/, hooks/, variables.json, *.json, ...)
  → 세션 디렉토리에 복사
panel-spec.md → 세션 디렉토리에 복사
글로벌 공유 스킬 (data/skills/*) + 도구 스킬 (data/tools/*/skills/*)
  → 세션 .claude/.agents/.gemini/.kimi/skills/
```

**RP 세션 Open** (`POST /api/sessions/[id]/open`):
```
session-primer{,-codex,-gemini}.yaml + session-shared.md
  → AI 런타임 시스템 프롬프트 (에페메럴, provider별로 분기)
panels/_actions.meta.json → 패널 액션 스펙 markdown으로 직렬화 → 시스템 프롬프트에 주입
panel-spec.md → 세션 디렉토리에 갱신 (최신본)
글로벌 + 도구 스킬 → 세션 skills 디렉토리에 갱신
```
