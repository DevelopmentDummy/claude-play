# MCP 서버 인증 수정 — 완료

## 문제

계정 시스템 도입 후 `src/middleware.ts`가 모든 API 요청에서 쿠키를 검사하는데, MCP 서버는 쿠키 없이 호출하므로 미들웨어 단계에서 401로 차단되었음.

## 해결

Internal token 방식 — 서버가 프로세스 수명 동안 유효한 랜덤 토큰을 생성하고, MCP 서버에 환경변수로 전달. MCP 서버가 API 호출 시 헤더로 첨부.

## 수정된 파일 (5건, 모두 적용 완료)

| 파일 | 수정 내용 |
|------|----------|
| `src/lib/auth.ts` | `getInternalToken()` 함수 + `requireAuth()`에 internal token 검사 분기 |
| `src/lib/session-manager.ts` | `writeMcpConfig()`/`writeCodexConfig()`에 `CLAUDE_BRIDGE_AUTH_TOKEN`, `CLAUDE_BRIDGE_USER_ID` env 주입 + `userId` 멤버 추가 |
| `src/lib/services.ts` | `new SessionManager(userDataDir, getAppRoot(), userId)` |
| `src/mcp/claude-bridge-mcp-server.mjs` | `requestJson()`에서 `x-bridge-token`, `x-bridge-user-id` 헤더 전송 |
| `src/middleware.ts` | 쿠키 검사 전에 `x-bridge-token` 헤더 있으면 통과 |

## 인증 흐름

```
[브라우저]  --cookie:cb_token-----------> [middleware: 쿠키 확인 → 통과] → [requireAuth(): cookie → userId] → ✅
[MCP 서버] --x-bridge-token + user-id--> [middleware: 헤더 확인 → 통과] → [requireAuth(): token 검증 → userId] → ✅
```
