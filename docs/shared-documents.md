# Shared Document Map

이 프로젝트는 **루트 레벨 공용 문서**들이 빌더/세션 작업 디렉토리로 전파되는 구조다. 각 문서의 역할과 독자를 이해해야 변경 시 올바른 곳을 업데이트할 수 있다.

| Document | Audience | Purpose | Propagation |
|----------|----------|---------|-------------|
| `builder-prompt.md` | Builder AI | 페르소나 빌더 워크플로우, 파일 생성 명세 | 빌더 세션 시작 시 → 페르소나 디렉토리의 `CLAUDE.md` / `AGENTS.md` / `GEMINI.md`로 복사 |
| `builder-primer.yaml` | Builder AI | 빌더 모드 시스템 프롬프트 래퍼 | 빌더 세션 시작 시 `active_system_prompt` 추출 → AI 런타임 시스템 프롬프트로 전달 |
| `session-primer.yaml` | Session AI (Claude) | RP 세션 시스템 프롬프트 (캐릭터 몰입, 성인 콘텐츠 허용, 가이드라인) | 세션 Open 시 `active_system_prompt` 추출 → AI 런타임 시스템 프롬프트로 전달 (디스크에 쓰이지 않음) |
| `session-primer-codex.yaml` | Session AI (Codex) | Codex용 RP 세션 시스템 프롬프트 | 세션 Open 시 → `.codex/model-instructions.md`로 작성 |
| `session-primer-gemini.yaml` | Session AI (Gemini) | Gemini용 RP 세션 시스템 프롬프트 | 세션 Open 시 → `GEMINI.md`에 병합 |
| `session-shared.md` | Session AI (all) | 공용 세션 가이드 (응답 형식, OOC, STT, 이미지 생성, 선택지 시스템) | 세션 Open 시 primer와 결합 → AI 런타임 시스템 프롬프트로 전달 |
| `panel-spec.md` | Builder/Session AI | 패널 시스템 기술 레퍼런스 (Handlebars, panelBridge, placement, tools 등) | 빌더 세션 시작 및 RP 세션 Open 시 → 작업 디렉토리로 복사 (매번 최신본으로 갱신) |

## Document Assembly Flow

**빌더 세션** (`POST /api/builder/start`):
```
builder-prompt.md → 페르소나 디렉토리 CLAUDE.md / AGENTS.md / GEMINI.md
builder-primer.yaml → AI 런타임 시스템 프롬프트
panel-spec.md → 페르소나 디렉토리에 복사 (참조용)
```

**RP 세션 생성** (`POST /api/sessions`):
```
persona/session-instructions.md → 세션 CLAUDE.md / AGENTS.md / GEMINI.md
  + style section (style.json이 있으면)
  + profile section (프로필이 있으면)
  + opening section (opening.md가 있으면)
persona files (panels/, tools/, variables.json, *.json, ...) → 세션 디렉토리에 복사
panel-spec.md → 세션 디렉토리에 복사
global tool skills (data/tools/*/skills/) → .claude/skills/ + .agents/skills/
```

**RP 세션 Open** (`POST /api/sessions/[id]/open`):
```
session-primer{-codex,-gemini}.yaml + session-shared.md → AI 런타임 시스템 프롬프트 (에페메럴)
panel-spec.md → 세션 디렉토리에 갱신 (최신본)
global tool skills → 세션 skills 디렉토리에 갱신
```
