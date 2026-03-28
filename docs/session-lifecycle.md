# Session Lifecycle

1. **Create**: `POST /api/sessions` — 페르소나 디렉토리 → 세션 디렉토리 복사, CLAUDE.md/AGENTS.md/GEMINI.md 조립, 런타임 설정 파일 생성
2. **Open**: `POST /api/sessions/[id]/open` — AI 프로세스 spawn, PanelEngine 시작, panel-spec.md 및 글로벌 스킬 갱신
3. **Chat**: WebSocket `chat:send` or `POST /api/chat/send` — 사용자 메시지를 AI stdin으로 전달, NDJSON 스트리밍 응답
4. **Accumulate**: `SessionInstance`에서 `text_delta` 이벤트를 수집, dialog/choice 추출, 히스토리 저장
5. **Panel refresh**: AI 턴 종료 시 `PanelEngine.reload()`로 데이터 파일 재로드 및 패널 재렌더링
6. **Sync** (수동): `POST /api/sessions/[id]/sync` — 양방향. Forward(페르소나→세션)는 OOC 알림 전송, Reverse(세션→페르소나)는 페르소나 템플릿에 역기록
7. **Leave/Disconnect**: 마지막 클라이언트 연결 해제 후 5초 유예 → AI 프로세스 종료, PanelEngine 중지

## Triple Runtime (Claude / Codex / Gemini)

- Provider determined by model at session creation, locked for session lifetime
- **Claude**: `claude -p` persistent process, NDJSON streaming
- **Codex**: `codex app-server` persistent JSON-RPC 2.0 over stdin/stdout
- **Gemini**: `gemini` per-turn spawning with `--resume` for session continuity
- All three share same EventEmitter interface (`message/status/error/sessionId`)
- Instruction files: `CLAUDE.md` (Claude) + `AGENTS.md` (Codex) + `GEMINI.md` (Gemini) generated in parallel
- MCP config: `.mcp.json` (Claude) + `.codex/config.toml` (Codex)
- Builder mode supports service switching (Claude↔Codex)
