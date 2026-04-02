# Background Session (Fire-and-Forget AI Session)

## Summary

대화 세션과 독립적으로 AI 세션을 fire-and-forget으로 실행하는 시스템 도구. 현재 세션 디렉토리에서 `claude -p`를 one-shot으로 spawn하여, 기존 시스템 프롬프트와 MCP 도구를 모두 활용 가능.

## Motivation

상당한 시간이 소요되는 컨텐츠 생성 과정을 백그라운드에서 실행하여, 유저가 현재 세션을 플레이하는 동안 새 컨텐츠를 자동으로 준비하는 파이프라인 구축.

## Entry Points

두 가지 진입점이 동일한 코어 함수를 호출:

### 1. MCP 도구: `background_session`

AI가 대화 중 직접 호출. `sessionDir`/`callerSessionId`는 MCP 환경변수(`CLAUDE_PLAY_SESSION_DIR`, `CLAUDE_PLAY_SESSION_ID`)에서 자동 추출.

### 2. API 엔드포인트: `POST /api/sessions/[id]/background`

Panel engine, 프론트엔드 등 프로그래밍적 호출용. URL 파라미터 `[id]`에서 세션 정보 추출.

## Parameters

| 파라미터 | 필수 | 타입 | 설명 |
|----------|------|------|------|
| `prompt` | O | string | 실행할 프롬프트 |
| `model` | X | string | 모델 지정 (예: `sonnet`, `opus`) |
| `effort` | X | string | reasoning effort (`low`, `medium`, `high`) |
| `notify` | X | boolean | 완료 시 호출 세션에 이벤트 전송 (기본: `false`) |

## Core Function

```
spawnBackgroundSession({ sessionDir, prompt, model?, effort?, notify?, callerSessionId? })
```

### 동작 흐름

1. 세션 디렉토리에서 페르소나 정보 추출 (`session.json`)
2. `buildServiceSystemPrompt()`로 기존과 동일한 시스템 프롬프트 빌드
3. `claude -p "prompt"` one-shot 실행:
   - `--system-prompt` — 빌드된 시스템 프롬프트
   - `--dangerously-skip-permissions`
   - `--model` — 지정 시
   - `--effort` — 지정 시
   - `--mcp-config` — 세션 디렉토리의 `.mcp.json`
   - streaming 플래그 없음 (`--input-format`, `--output-format` 생략)
   - `cwd` = 세션 디렉토리
4. 도구는 즉시 `{ pid, status: "fired" }` 반환 (완료 대기 안 함)
5. `notify: true`인 경우, 프로세스 exit 시 호출 세션의 `event:queue`에 완료 이벤트 push

### 환경 변수 클린업

기존 `ClaudeProcess.spawn()`과 동일하게 `CLAUDECODE`/`CLAUDE_CODE` 환경변수를 제거하여 nested session 에러 방지.

## File Locations

| 파일 | 역할 |
|------|------|
| `src/lib/background-session.ts` | 코어 함수 `spawnBackgroundSession()` |
| `src/mcp/claude-play-mcp-server.mjs` | MCP 도구 `background_session` 등록 |
| `src/app/api/sessions/[id]/background/route.ts` | API 엔드포인트 |
| `session-shared.md` | 빌더 프롬프트에 사용법 추가 |

## MCP Tool Registration

```javascript
server.registerTool(
  "background_session",
  {
    description: "Fire an independent AI session in the background. Runs claude in one-shot mode with the current session's system prompt and MCP tools. Returns immediately without waiting for completion.",
    inputSchema: {
      prompt: z.string().min(1).describe("The prompt to execute"),
      model: z.string().optional().describe("Model override (e.g. sonnet, opus)"),
      effort: z.string().optional().describe("Reasoning effort: low, medium, high"),
      notify: z.boolean().optional().describe("Send completion event to this session when done (default: false)"),
    },
  },
  async (input) => { ... }
);
```

## API Endpoint

```
POST /api/sessions/[id]/background
Content-Type: application/json

{
  "prompt": "Generate next adventure scenario...",
  "model": "sonnet",
  "effort": "medium",
  "notify": true
}

Response: { "pid": 12345, "status": "fired" }
```

## Builder Prompt Documentation

`session-shared.md`에 background_session 도구 사용법 섹션 추가:

```markdown
## Background Session

`background_session` 도구를 사용하면 현재 대화와 독립적으로 AI 세션을 백그라운드에서 실행할 수 있습니다.
- 시간이 오래 걸리는 컨텐츠 생성, 데이터 준비 등에 활용
- 현재 세션의 시스템 프롬프트와 MCP 도구를 그대로 사용
- `notify: true`로 완료 알림 수신 가능
```

## Completion Notification

`notify: true`인 경우, 프로세스 종료 시:

```
[BACKGROUND_SESSION_COMPLETE] pid={pid} exit_code={code}
```

형태로 caller 세션의 `pending-events.json`에 추가. 다음 유저 메시지 전송 시 AI에게 전달됨.
