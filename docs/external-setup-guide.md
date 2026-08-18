# claude-play-bridge 외부 셋업 가이드 (AI 에이전트용)

이 문서는 Claude Play 브릿지의 이미지·영상 생성 MCP를 **다른 프로젝트**에 셋업하는 지시문이다.
대상 프로젝트의 AI 세션에게 이 문서를 주고 "이대로 셋업해줘"라고 하면 된다.

## 전제

- 브릿지와 **같은 PC**여야 한다. 브릿지 레포 위치: `C:\repository\claude bridge`
- 브릿지 서버가 실행 중이어야 한다 (기본 포트 3340). 안 떠 있으면 사용자에게 기동을 요청하라
  (브릿지 레포에서 `npm run dev` 또는 `npm run start`).

## 셋업 단계 (AI가 수행)

1. **셋업 스크립트 실행** — 현재 프로젝트 루트에서:

   ```bash
   node "C:\repository\claude bridge\scripts\setup-external.mjs" .
   ```

   비기본 포트를 쓰는 경우 `--port <N>` 추가.

2. **출력 확인** — 다음 두 줄이 보여야 정상:
   - `✓ .mcp.json: claude-play-bridge → http://127.0.0.1:<포트>/mcp/external`
   - `✓ 스킬 복사 (11): generate-image, generate-video, generate-image-gemini, manage-workflows, civitai-search, lora-lab, workflow-research, minimax-h3, h3-longtake, long-video-chaining, video-sound-design`

3. **MCP 재연결** — Claude Code를 재시작하거나 `/mcp` 명령으로 `claude-play-bridge` 서버가 connected인지 확인.
   (`.mcp.json`은 프로젝트 스코프라 최초 1회 신뢰 확인 프롬프트가 뜰 수 있다 — 승인하라.)

4. **검증** — `mcp__claude-play-bridge__comfyui_health` 도구를 호출해 응답이 오는지 확인.
   - `comfyui.status: "connected"` → 완전 정상.
   - `unreachable`이어도 **응답 자체가 왔으면 셋업은 성공** — ComfyUI 기동은 별개 문제이므로 사용자에게 알려만 준다.

5. **사용법 안내** — 사용법은 복사된 스킬 문서에 있다.
   - 이미지: `.claude/skills/generate-image/SKILL.md`
   - 영상: `.claude/skills/generate-video/SKILL.md` — 렌더가 수 분~수십 분이라 `async: true`로 던지고 파일을 폴링하는 절차가 핵심이다.
   - 심화(체이닝·사운드·연출 노하우): `minimax-h3`, `h3-longtake`, `long-video-chaining`, `video-sound-design`. 이들은 같은 PC의 ComfyUI를 직접 다루는 로컬 파이프라인이며, 경로 예시는 원본 개발 환경 기준이다.

   공통 핵심: 생성 도구는 `outputDir`(절대경로)이 필수이고, 파일은 그 디렉토리 직하에 저장되며 절대경로가 반환된다.

## 트러블슈팅

| 증상 | 원인 | 조치 |
|---|---|---|
| `401 Unauthorized` | 토큰 불일치 (재발급됨) | 셋업 스크립트 재실행 → MCP 재연결 |
| `ECONNREFUSED` / 연결 실패 | 브릿지 서버 미기동 | 사용자에게 브릿지 기동 요청 |
| `404` | 브릿지 서버가 구버전 코드 | 사용자에게 브릿지 재시작 요청 |
| `ComfyUI is not connected` | ComfyUI 미기동 (셋업은 정상) | 사용자에게 ComfyUI 기동 요청 |
| 영상 생성이 5분쯤 끊김 | MCP 클라이언트 유휴 타임아웃 | `comfyui_generate`를 `async: true`로 호출하고 `outputDir`의 파일 생성을 폴링 |

## 참고

- 노출 도구 전체 목록·확장 방법: [external-mcp.md](external-mcp.md)
- 브릿지 쪽 스모크: `node "C:\repository\claude bridge\scripts\smoke-external-mcp.mjs"`
