# 외부 에이전트용 MCP 개방 + 스킬팩 셋업 패키지 — 설계 스펙

- 날짜: 2026-07-15
- 상태: 설계 확정 (구현 전)
- 목적: 브릿지 내부 MCP 코어 기능(이미지 생성 중심)을 같은 PC의 외부 AI 에이전트가 MCP로 사용할 수 있게 개방하고, 서비스용 스킬팩을 함께 배포하는 셋업 패키지를 제공한다.

## 배경과 문제

내부 MCP 서버(`src/mcp/claude-play-mcp-server.mjs`)는 세션별 stdio 자식 프로세스로,
`CLAUDE_PLAY_SESSION_DIR`/`CLAUDE_PLAY_PERSONA` env와 일회성 내부 토큰에 묶여 있어 외부에서 접근할 수 없다.
실제 로직은 이미 HTTP API(`/api/tools/comfyui/generate` 등)에 있으나:

1. `sessionId` 또는 `persona`가 없으면 400 — 출력 디렉토리가 세션/페르소나 폴더에 결합.
2. 인증이 내부 토큰(프로세스 메모리) + ADMIN_PASSWORD 쿠키뿐 — 외부 클라이언트용 자격증명이 없음.
3. MCP 전송 계층이 stdio뿐 — 외부 에이전트가 붙을 엔드포인트가 없음.

## 결정 요약

| 항목 | 결정 |
|---|---|
| 소비 주체 | 같은 PC의 다른 AI 에이전트 (MCP 클라이언트) |
| 전송 | Streamable HTTP MCP 엔드포인트 (`/mcp/external`) — stateless JSON 모드 |
| 인증 | 고정 토큰 `data/.runtime/external-mcp-token` (서버 시작 시 자동 생성), `x-external-token` 헤더 |
| 출력 경로 | 호출자가 `outputDir`(절대경로) 지정, 결과는 **outputDir 직하** 저장 (`images/` 강제 없음) |
| 툴 범위 v1 | comfyui_generate, generate_image_openai, generate_image_gemini, comfyui_health, comfyui_models, comfyui_workflow(list/get) |
| 확장성 | 노출 툴 레지스트리 단일 모듈 — TTS/STT 등 추후 항목 추가만으로 확장 |
| 스킬팩 | 큐레이션 세트를 대상 프로젝트 `.claude/skills/`로 복사, generate-image는 외부용 변형본 별도 유지 |
| 패키지 형태 | `scripts/setup-external.mjs` + AI 에이전트용 셋업 가이드 문서 — 대상 프로젝트 AI 세션에게 "이거 셋업해줘"로 전달 가능 |

## 아키텍처

```
[외부 AI 에이전트 (Claude Code / Codex / SDK 클라이언트)]
        │  HTTP POST /mcp/external  (x-external-token)
        ▼
[server.ts 커스텀 HTTP 서버]  ← Next.js 핸들러보다 먼저 가로챔 (ADMIN 미들웨어 무관)
        │  StreamableHTTPServerTransport (stateless, 요청당 인스턴스)
        ▼
[src/lib/external-mcp/]  ← 툴 레지스트리 + 핸들러
        │  localhost fetch + 내부 토큰 (기존 라우트 재사용)
        ▼
[기존 API: /api/tools/comfyui/generate 등]  ← outputDir 분기 추가
```

### 1. 전송 계층

- `server.ts`에 `/mcp/external` 라우트 추가. Next.js에 넘기기 전에 처리하므로 미들웨어 게이트와 충돌하지 않는다.
- `@modelcontextprotocol/sdk`의 `StreamableHTTPServerTransport`를 stateless 모드(`sessionIdGenerator: undefined`, JSON 응답)로 사용.
  요청마다 `McpServer` 인스턴스를 만들어 처리 후 폐기 — 세션 상태 관리 불필요.
- 신규 모듈 `src/lib/external-mcp/`:
  - `registry.ts` — 노출 툴 정의 목록(이름/스키마/핸들러). 확장 지점.
  - `server.ts` — McpServer 조립 + HTTP 요청 처리 엔트리.

### 2. 인증

- 서버 시작 시 `data/.runtime/external-mcp-token` 파일이 없으면 32바이트 랜덤 hex 생성·영속화.
- `/mcp/external` 요청은 `x-external-token` 헤더가 파일 값과 일치해야 통과 (timing-safe 비교), 불일치 시 401.
- 외부 MCP 핸들러 → 기존 API 호출은 in-process `getInternalToken()`으로 localhost fetch (기존 검증 로직 그대로 재사용).

### 3. 세션 의존성 해소 — `outputDir`

- 외부 툴은 `sessionId`/`persona` 대신 `outputDir`(절대경로) **필수** 파라미터를 받는다.
- 대상 라우트: `/api/tools/comfyui/generate`, `/api/tools/openai/generate`, `/api/tools/gemini/generate`.
  body에 `outputDir` 분기 추가 — 지정 시 세션 조회 없이 해당 디렉토리를 대상.
  `outputDir`는 내부 토큰 인증 요청에서만 허용(외부 MCP 계층 경유 전용, 쿠키 인증으로는 불가).
- **직하 저장 구현**: 공유 클라이언트(comfyui-client `downloadResults`, image-fs `writeSessionImage`)는
  `{dir}/images/` 저장을 전제하므로 건드리지 않는다. 외부 분기는 항상 생성 완료를 기다린 뒤
  `{outputDir}/images/{file}` → `{outputDir}/{file}`로 이동(extraPaths 포함)하고 빈 `images/` 디렉토리를 정리한다.
- 응답은 **절대경로**(`filepath` 절대화)로 반환. `$IMAGE:...$` 토큰은 외부 응답에서 제외(세션 프론트 전용 개념).
- reference_image 류 입력은 v1에서 `outputDir` 기준 상대경로로 해석(내부와 동일한 join 로직 재사용).
- openai/gemini 라우트는 현재 fire-and-forget → `outputDir` 분기에서는 완료 대기 후 응답 (외부엔 폴링 UI가 없음).

### 4. v1 노출 툴

| 툴 | 동작 | 비고 |
|---|---|---|
| `comfyui_generate` | 워크플로 패키지 기반 생성, 동기 | `async` 미지원. `outputDir` 필수 |
| `generate_image_openai` | GPT 이미지 (Codex 구독 백엔드 기본) | 완료 대기로 보강 |
| `generate_image_gemini` | Gemini 이미지 | 완료 대기로 보강 |
| `comfyui_health` | 상태 확인 | 프록시 그대로 |
| `comfyui_models` | 체크포인트/LoRA 목록 | 프록시 그대로 |
| `comfyui_workflow` | `list`/`get`만 | `save`/`delete`는 RP 세션과 공유되는 패키지 보호를 위해 v1 제외 |

- 내부 MCP 서버의 정책/세션 툴(fire_ai, run_tool, policy_* 등)은 노출하지 않는다.
- TTS/STT 등은 registry에 항목 추가로 확장 (v2 후보).

### 5. 셋업 패키지

**`scripts/setup-external.mjs <대상 프로젝트 경로>`** (멱등, 재실행 = 갱신):

1. 브릿지 포트 결정(레포 설정/기본 3340) + `data/.runtime/external-mcp-token` 읽기(없으면 생성 — 서버와 같은 파일을 공유).
2. 대상 프로젝트 `.mcp.json`에 `claude-play-bridge` 항목 병합(기존 다른 서버 항목 보존):
   ```json
   { "mcpServers": { "claude-play-bridge": {
       "type": "http",
       "url": "http://127.0.0.1:3340/mcp/external",
       "headers": { "x-external-token": "<토큰>" } } } }
   ```
3. 큐레이션 스킬을 `<대상>/.claude/skills/`로 복사 (`{{PORT}}` 치환 포함):
   - `generate-image` — **외부용 변형본** (`scripts/external-package/skills/generate-image/`에 별도 유지;
     세션 전용 지시(character-tags.json, persona.md, `$IMAGE$` 토큰, targetScope)를 제거하고 outputDir 사용법 기술)
   - 원본 그대로: `generate-image-gemini`, `manage-workflows`, `civitai-search`, `lora-lab`, `workflow-research`
   - 목록은 스크립트 상수(`CURATED_SKILLS`) — 추가/제외 한 줄.
4. 결과 요약 출력 (등록된 URL, 복사된 스킬, 검증 방법).

**`docs/external-setup-guide.md`** — 대상 프로젝트 AI 세션에게 그대로 건네는 지시문.
스크립트 실행 → MCP 재연결 → `comfyui_health` 호출 검증까지 AI가 자가 진행하도록 단계별 작성
(기존 `docs/ai-setup-guide.md` 패턴).

### 6. 에러 처리

- 토큰 불일치/누락 → 401 + JSON-RPC 에러 아님(전송 계층 거부).
- `outputDir` 미존재 → 생성 시도(`mkdirSync recursive`); 절대경로 아님 → 툴 에러 반환.
- ComfyUI 미기동 → 기존 503 메시지를 툴 에러로 그대로 전달.
- 생성 실패 시 부분 파일 정리는 기존 라우트 동작에 따름(외부 분기에서 이동 실패 시 원 경로를 에러 메시지에 포함).

### 7. 검증 계획

- `npm run verify` (typecheck + lint:data + check:static + smoke).
- 라이브 스모크: SDK `StreamableHTTPClientTransport`로 스크래치 프로젝트에서 접속 →
  `tools/list` → `comfyui_health` → `comfyui_generate`(outputDir=스크래치) → 파일이 outputDir 직하에 생겼는지 확인.
- 셋업 스크립트 스모크: 스크래치 디렉토리에 실행 → `.mcp.json`/스킬 복사 결과 확인 → 재실행 멱등성 확인.

### 8. 문서 전파

- `docs/external-mcp.md` 신설(엔드포인트/인증/툴 표/확장 방법) + `docs/external-setup-guide.md`.
- `docs/architecture.md`, `docs/api-routes.md`, `docs/change-propagation.md` 갱신.
- `HANDOVER.md`에 라이브 스모크 백로그 항목 추가.

## 비고

- 단일 사용자 개인 서비스 + 같은 PC 전제 — `outputDir` 임의 경로 쓰기는 토큰 게이트로 충분하다고 판단.
  원격 노출이 필요해지면 그 시점에 허용 루트 제한(env) 도입을 재검토.
- stdio 전용 구형 클라이언트는 `npx mcp-remote <url>` 셈으로 커버 — 별도 구현 없음.
