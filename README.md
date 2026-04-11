# Claude Play

[![Node.js 18+](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Next.js 15](https://img.shields.io/badge/Next.js-15-black?logo=next.js)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**AI 캐릭터와 몰입형 롤플레이 세션을 즐기는 웹 앱.**
[Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code), [Codex CLI](https://github.com/openai/codex), [Gemini CLI](https://github.com/google-gemini/gemini-cli)를 브릿지합니다.

> [!NOTE]
> This is a community project and is not affiliated with, endorsed by, or sponsored by Anthropic, OpenAI, or Google.

## What is Claude Play?

Claude Play는 AI 캐릭터 페르소나를 만들고, 대화형 롤플레이 세션을 진행하는 웹 애플리케이션입니다. HP, 인벤토리, 지도 같은 실시간 상태 패널이 AI 응답에 따라 동적으로 업데이트되며, 이미지 생성과 TTS 음성까지 지원합니다.

CLI 기반 AI 런타임(Claude Code, Codex, Gemini)을 서브프로세스로 스폰하고, WebSocket을 통해 브라우저와 실시간 스트리밍으로 연결합니다. 모든 데이터는 파일 기반으로 저장되어 데이터베이스가 필요 없습니다.

## Features

### Core

- **Persona Builder** — AI 어시스턴트가 가이드하는 캐릭터 페르소나 제작
- **Live RP Sessions** — 캐릭터와 대화하며 몰입형 세션 진행, 세션 persist & resume 지원
- **Dynamic Panels** — Handlebars 템플릿 기반 HTML 패널 (side, modal, dock), AI 응답에 따라 실시간 업데이트
- **Custom Themes** — 페르소나별 레이아웃, 컬러 테마, UI 커스터마이징

### AI Providers

| Provider | Command | Communication |
|----------|---------|---------------|
| Claude Code | `claude -p` | NDJSON streams |
| Codex | `codex app-server` | JSON-RPC 2.0 over stdin/stdout |
| Gemini | `gemini --resume` | NDJSON streams |

세션 생성 시 모델을 선택하면, 해당 프로바이더가 세션 수명 동안 고정됩니다.

### Media

- **Image Generation** — ComfyUI (로컬 GPU), Gemini, OpenAI 통합
- **TTS Voice** — Edge TTS (클라우드, 무료) + Qwen3-TTS (로컬 GPU, 음성 클로닝)
- **GPU Manager** — Python FastAPI 기반 직렬 GPU 큐, VRAM 충돌 방지

### Developer

- **MCP Integration** — 세션별 MCP 서버 (11+ tools)로 AI가 브릿지와 상호작용
- **Custom Tools & Skills** — 페르소나별 도구 스크립트와 AI 스킬 확장
- **File-Based Storage** — DB 불필요, `data/` 디렉토리에 모든 데이터 저장

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (또는 [Codex CLI](https://github.com/openai/codex), [Gemini CLI](https://github.com/google-gemini/gemini-cli)) 설치 및 인증 완료
- Python 3.10+ *(선택 — GPU Manager, 로컬 TTS용)*
- NVIDIA GPU 8GB+ VRAM *(선택 — ComfyUI, 로컬 TTS용)*

### Setup

```bash
# 1. Clone
git clone https://github.com/DevelopmentDummy/claude-play.git
cd claude-play

# 2. Setup wizard (deps 설치, 데이터 디렉토리 초기화)
node setup.js

# 3. Start
npm run dev

# 4. Open http://localhost:3340
```

> **AI 에이전트** (Claude Code, Codex 등): `docs/ai-setup-guide.md`를 읽고 따라하세요.

자세한 설치 과정은 [SETUP.md](SETUP.md)를 참고하세요.

## Usage

1. **페르소나 생성** — 홈에서 "New Persona" 클릭. AI 빌더가 캐릭터 파일 생성을 가이드합니다.
2. **세션 시작** — 페르소나 선택 후 "New Session". 유저 프로필을 선택할 수 있습니다.
3. **채팅** — 페르소나의 오프닝 메시지와 함께 세션이 시작됩니다.
4. **패널** — 게임 상태(스탯, 인벤토리, 지도 등)가 AI 플레이에 따라 실시간으로 업데이트됩니다.

## Persona Sharing

페르소나를 GitHub에 퍼블리시하고, 다른 사람이 만든 페르소나를 URL만으로 가져와 바로 플레이할 수 있습니다.

### 내 페르소나 공유하기

1. 페르소나를 선택해 대화 시작 모달에서 **Publish** 버튼 클릭
2. 두 가지 방식 중 선택:
   - **직접 Push** — 직접 생성한 GitHub 리포지토리 URL을 입력하면 즉시 커밋 & 푸시
   - **빌더 세션** — AI가 리포 생성부터 설정, push까지 전 과정을 대화형으로 처리 (GitHub CLI(`gh`) 또는 GitHub MCP가 설치되어 있으면 리포 생성까지 자동화)
3. 채팅 기록·메모리 등 개인 데이터는 `.gitignore`로 자동 제외됩니다

### 다른 사람의 페르소나 가져오기

1. 홈 화면에서 **"GitHub에서 가져오기"** 클릭
2. 공유된 GitHub URL 붙여넣기
3. 미리보기에서 캐릭터 정보 확인 후 설치
4. 바로 세션을 시작해 플레이!

가져온 페르소나는 원본 리포지토리의 업데이트를 확인하고 pull할 수 있습니다.

## How It Works

```
Persona ──clone──▶ Session Dir ──spawn──▶ AI Process (Claude/Codex/Gemini)
                                              │
Browser ◀──WebSocket──▶ server.ts ◀──NDJSON/JSON-RPC──┘
                            │
                     Panel Engine ──watch──▶ variables.json → re-render HTML panels
```

1. 페르소나 디렉토리를 새 세션 디렉토리로 클론
2. `session-instructions.md`가 세션의 `CLAUDE.md` / `AGENTS.md`로 적용
3. 세션별 MCP 설정과 권한 샌드박스로 AI 프로세스 스폰
4. 사용자 메시지: Browser → WebSocket → AI stdin
5. AI 응답: stdout → stream parser → WebSocket → Browser
6. 패널 엔진이 `variables.json`과 커스텀 데이터 파일을 감시, 변경 시 Handlebars 템플릿 재렌더링

## Configuration

핵심 환경변수 (`.env.local`에 설정):

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3340` | 메인 서버 포트 (TTS=PORT+1, GPU Manager=PORT+2) |
| `DATA_DIR` | `./data` | 데이터 디렉토리 경로 |
| `ADMIN_PASSWORD` | — | 관리자 비밀번호 (비워두면 인증 비활성화) |
| `COMFYUI_HOST` | `127.0.0.1` | ComfyUI 호스트 |
| `COMFYUI_PORT` | `8188` | ComfyUI 포트 |
| `GEMINI_API_KEY` | — | Gemini 이미지 생성 API 키 |
| `TTS_ENABLED` | `true` | TTS 전역 활성화/비활성화 |

전체 목록은 [`.env.example`](.env.example)을 참고하세요.

## Project Structure

```
setup.js               # CLI 셋업 위자드 (pure JS, zero deps)
server.ts              # Custom HTTP + WebSocket 서버
gpu-manager/           # Python FastAPI GPU 태스크 큐
src/
├── app/               # Next.js App Router (pages + API routes)
├── lib/               # 핵심 라이브러리 (세션, 패널 엔진, AI 프로세스, TTS 등)
├── mcp/               # 세션별 MCP 서버
├── components/        # React 컴포넌트
└── hooks/             # React 훅
data/                  # 파일 기반 스토리지 (gitignored)
├── personas/          # 페르소나 템플릿
├── sessions/          # 세션 인스턴스
├── profiles/          # 유저 프로필
└── tools/             # 글로벌 도구 스킬 & 워크플로우
```

## Documentation

| Document | Contents |
|----------|----------|
| [Architecture](docs/architecture.md) | 스택, 서버, GPU Manager, 핵심 라이브러리, MCP |
| [API Routes](docs/api-routes.md) | 전체 API 라우트 (50+ endpoints) |
| [Frontend](docs/frontend.md) | 페이지 (5) 및 컴포넌트 (30+) |
| [Data Model](docs/data-model.md) | 파일 기반 데이터 디렉토리 구조 |
| [Session Lifecycle](docs/session-lifecycle.md) | 세션 라이프사이클, Triple Runtime |
| [Change Propagation](docs/change-propagation.md) | 변경 시 업데이트 가이드 |
| [Infrastructure](docs/infrastructure.md) | 컨벤션, 환경변수 전체 목록 |

## License

[MIT](LICENSE)

---

> This is a community project and is not affiliated with, endorsed by, or sponsored by Anthropic, OpenAI, or Google.
> "Claude" is a trademark of Anthropic. "Codex" is a trademark of OpenAI. "Gemini" is a trademark of Google.
