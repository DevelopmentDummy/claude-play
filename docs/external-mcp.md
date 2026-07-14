# External MCP — 외부 에이전트용 MCP 개방

같은 PC의 외부 AI 에이전트(Claude Code, Codex, MCP SDK 클라이언트 등)가 브릿지의 이미지 생성 코어 기능을 사용할 수 있게 하는 Streamable HTTP MCP 엔드포인트.

설계 배경·결정 근거: [docs/specs/2026-07-15-external-mcp-design.md](specs/2026-07-15-external-mcp-design.md)

## 엔드포인트

- `POST /mcp/external` — Streamable HTTP (stateless, JSON 응답). **POST 전용** — GET(SSE 스트림)/DELETE(세션 종료)는 405.
- `server.ts`가 Next.js 핸들러보다 먼저 가로채므로 **ADMIN_PASSWORD 미들웨어와 무관**하다. 인증은 아래 전용 토큰만.
- 요청마다 `McpServer` + transport 인스턴스를 새로 만들어 처리 후 폐기 — 서버측 세션 상태 없음.

## 인증

- 헤더 `x-external-token` = `data/.runtime/external-mcp-token` 파일 값 (timing-safe 비교, 불일치 시 401).
- 토큰은 서버 시작 시(또는 `scripts/setup-external.mjs` 실행 시) 없으면 자동 생성·영속화. 두 경로가 같은 파일을 공유한다.
- 재발급: 파일을 지우고 서버 재시작(또는 setup 스크립트 재실행) → 소비자 쪽 `.mcp.json` 갱신 필요.

## v1 노출 툴

| 툴 | 동작 | 비고 |
|---|---|---|
| `comfyui_generate` | 워크플로 패키지 기반 생성 (동기) | `outputDir` 필수. `workflow` 생략 시 활성 프리셋 기본 템플릿 |
| `generate_image_openai` | GPT 이미지 (Codex 구독 백엔드 기본) | 완료 대기 후 응답 |
| `generate_image_gemini` | Gemini 이미지 | 완료 대기 후 응답 |
| `comfyui_health` | ComfyUI/GPU Manager 상태 | `/api/tools/comfyui/health` 프록시 |
| `comfyui_models` | 체크포인트/LoRA 목록 | `/api/tools/comfyui/models` 프록시 |
| `comfyui_workflow` | 워크플로 패키지 조회 | **list/get만** — save/delete는 RP 세션과 공유되는 패키지 보호를 위해 미노출 |

### outputDir 시맨틱

- 모든 생성 툴은 `outputDir`(절대경로) 필수. 결과 파일은 **outputDir 직하**에 저장되고 응답 `path`는 절대경로.
- 내부 클라이언트는 `{dir}/images/`에 쓰므로, 외부 분기는 완료 후 `src/lib/external-mcp/flatten.ts`로 직하 이동 + 빈 `images/` 정리.
- 세션 전용 개념(`$IMAGE:...$` 토큰, targetScope, async 폴링)은 외부 응답에 없다.

## 구현 구조

```
[외부 에이전트] --POST /mcp/external (x-external-token)--> [server.ts]
    → src/lib/external-mcp/server.ts   (transport + 토큰 게이트)
    → src/lib/external-mcp/registry.ts (툴 정의 — 확장 지점)
    → localhost fetch + 내부 토큰(x-bridge-token) → 기존 API 라우트
```

| 파일 | 역할 |
|---|---|
| `src/lib/external-mcp/token.ts` | 외부 토큰 생성/영속화/검증 |
| `src/lib/external-mcp/registry.ts` | 노출 툴 정의 목록 (`EXTERNAL_TOOLS`) |
| `src/lib/external-mcp/server.ts` | McpServer 조립 + HTTP 요청 처리 |
| `src/lib/external-mcp/flatten.ts` | images/ → outputDir 직하 이동 헬퍼 |

기존 API 라우트 3종(`/api/tools/{comfyui,openai,gemini}/generate`)은 `outputDir` body 파라미터를 받는데, **내부 토큰(`validateInternalToken`) 인증 요청에서만 허용**된다 — ADMIN 쿠키 인증으로는 임의 경로 쓰기가 불가능하다. openai/gemini 라우트의 외부 분기는 세션 경로와 달리 fire-and-forget이 아니라 완료를 기다린다.

## 확장 방법

1. `src/lib/external-mcp/registry.ts`의 `EXTERNAL_TOOLS`에 `ExternalToolDef` 항목 추가 → 자동 노출.
2. 노출 금지 정책: 세션/정책/오케스트레이션 툴(`fire_ai`, `run_tool`, `policy_*`, `bridge_*`)은 노출하지 않는다.
3. 스킬팩에 반영이 필요하면 `scripts/setup-external.mjs`의 `CURATED_SKILLS`와 `scripts/external-package/skills/`를 함께 갱신.
4. 문서 전파: 이 문서의 툴 표 + [change-propagation.md](change-propagation.md) 참조.

## 셋업 & 검증

- 소비자 셋업: [external-setup-guide.md](external-setup-guide.md) — 대상 프로젝트 AI 세션에게 그대로 건네면 된다.
- 스모크: 브릿지 서버 기동 후 `node scripts/smoke-external-mcp.mjs` (tools/list + health), `--generate <절대경로>`로 실제 생성까지.
- 2026-07-15 라이브 검증 완료: dev:lite 서버에서 tools 6종 나열, comfyui_health connected, comfyui_generate로 outputDir 직하 저장 확인.
