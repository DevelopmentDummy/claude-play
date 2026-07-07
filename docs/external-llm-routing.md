# Claude Code / Codex CLI External LLM Routing Guide

검증 기준: 2026-05-07, `codex-cli 0.124.0`, `Claude Code 2.1.119`.

이 문서는 Claude Code, Codex CLI, Kimi CLI, Antigravity CLI, 그리고 외부 LLM 게이트웨이를 함께 쓸 때의 설정 경로를 정리한다.

Claude Play는 외부 LLM API 키를 자체 검증하지 않는다. 서버 프로세스가 읽은 환경변수를 CLI 하위 프로세스에 상속할 뿐이고, 실제 인증과 검증은 각 CLI, OAuth 로그인, 라우터, 게이트웨이가 처리한다.

## 핵심 차이

| CLI | 기본 API 형식 | 외부 API 연결 방식 |
| --- | --- | --- |
| Claude Code | Anthropic Messages API | 기존 OAuth 흐름 유지. 외부 OpenAI 호환 모델에는 변환 프록시가 필요해서 우선 경로로 쓰지 않음 |
| Codex CLI | OpenAI Responses API | 외부 모델 선택 시에만 `codex app-server -c model_provider=...`로 per-process gateway 설정 |
| Kimi CLI | Kimi Code CLI | native `kimi --wire` 흐름 사용. UI에는 `kimi-auto`, `moonshot-ai/kimi-k2.6`, `moonshot-ai/kimi-k2.6:thinking`만 노출 |
| Antigravity CLI | 자체 ConnectRPC (HTTPS+JSON, 로컬 agy CLI 로그인) | 외부 API 연결 없음. `antigravity-*` 모델 전용이며, `NEXT_PUBLIC_DISABLE_GEMINI=true`면 `gemini-*` 모델도 antigravity로 투명 라우팅됨 (`src/lib/ai-provider.ts`) |

주의: 예전 Codex CLI 자료에는 `wire_api = "chat"` 예시가 많지만, `codex-cli 0.124.0`에서는 더 이상 지원되지 않는다. OpenAI 호환 Chat Completions만 제공하는 엔드포인트는 Responses API로 변환하는 프록시가 필요하다.

## 1. Codex CLI

기존 Claude/Codex/Gemini/Kimi 모델은 각 CLI의 로그인 흐름을 그대로 사용한다. Kimi는 `kimi --wire`를 직접 실행한다. `kimi-auto`는 Kimi CLI의 `default_model`을 따르고, `moonshot-ai/kimi-k2.6`는 `~/.kimi/config.toml`의 `[models]`에 정의된 모델 key를 `--model`로 넘긴다. 외부 gateway 모델은 UI의 `External Gateway` 모델값, 즉 `external/...` prefix가 붙은 모델을 선택했을 때만 Codex app-server에 별도 provider 설정을 주입한다.

`.env.local`:

```dotenv
CODEX_EXTERNAL_BASE_URL=http://localhost:4000/v1
CODEX_EXTERNAL_API_KEY=sk-...
```

동작 방식:

- 모델값이 `gpt-5.5:medium`이면 기존 Codex OAuth/app-server 흐름을 사용한다.
- 모델값이 `kimi-auto`이면 Kimi CLI의 기본 모델을 따른다.
- 모델값이 `moonshot-ai/kimi-k2.6`이면 Kimi CLI에 해당 key를 `--model`로 넘긴다.
- Kimi 모델값의 `:thinking` suffix는 `--thinking`으로 전달한다. suffix가 없으면 Kimi CLI의 저장된/default thinking 설정을 따른다.
- Kimi spawn에는 `--yolo`(자동 승인)가 상시 부착되고, effort가 `no-thinking`이면 `--no-thinking`으로 전달한다(UI 선택기에는 없고 fire_ai/서브에이전트의 명시 effort로 도달) (`src/lib/kimi-process.ts`).
- 모델값이 `external/deepseek/deepseek-chat`이면 Codex app-server를 띄울 때만 `model_provider="external"`을 주입한다.
- Codex에 전달되는 실제 model id는 `external/`을 제거한 `deepseek/deepseek-chat`이다.
- 전역 `~/.codex/config.toml`은 수정하지 않는다.
- 선택 env `CODEX_EXTERNAL_ENV_KEY`로 API 키를 읽을 env var 이름을 재지정할 수 있다. 미설정 시 `CODEX_EXTERNAL_API_KEY`가 기본이며, 해당 env var가 실제로 존재할 때만 `model_providers.external.env_key`가 주입된다 (`src/lib/codex-process.ts`).
- 이 모델→프로바이더 라우팅(`providerFromModel`의 prefix 판정)은 인터랙티브 세션 외에 fire_ai 백그라운드 작업(`src/lib/background-session.ts`)과 서브에이전트 per-sub 고정 모델(`src/lib/subagent-manifest.ts`)에도 동일하게 적용된다.

### Chat Completions 전용 API를 쓰려는 경우

Moonshot, DeepSeek, OpenRouter 등 많은 외부 API는 `/v1/chat/completions` 형식을 제공한다. 현재 Codex CLI가 `wire_api = "chat"`을 거부하므로, 외부 게이트웨이는 Codex가 쓰는 Responses API를 노출해야 한다.

- Responses API를 노출하는 게이트웨이 사용
- Chat Completions를 Responses API로 변환하는 프록시 사용
- `wire_api = "chat"`을 지원하던 구버전 Codex CLI 사용. 권장하지 않음

### 검증

사용 중인 Codex 버전 확인:

```bash
codex --version
```

`wire_api = "chat"` 지원 여부를 임시 설정으로 확인:

```bash
codex exec \
  -c model_providers.test.name='"Test"' \
  -c model_providers.test.base_url='"http://127.0.0.1:9/v1"' \
  -c model_providers.test.env_key='"TEST_KEY"' \
  -c model_providers.test.wire_api='"chat"' \
  -c model_provider='"test"' \
  -c model='"dummy"' \
  "say hi"
```

현재 로컬 검증 결과:

```text
Error loading config.toml: `wire_api = "chat"` is no longer supported.
How to fix: set `wire_api = "responses"` in your provider config.
```

### OpenAI 이미지 생성 백엔드

GPT 이미지 생성은 채팅 라우팅과 별개의 외부 LLM 경로다. `OPENAI_IMAGE_BACKEND` env가 백엔드를 결정한다 (`src/app/api/tools/openai/generate/route.ts`).

- `codex`(기본): `codex exec` + 내장 `image_gen` 도구로 렌더링. ChatGPT 구독으로 커버되어 건당 과금 없음. `$CODEX_HOME/generated_images/`에 떨어지는 `ig_*.png`를 하베스트해 세션 `images/`로 복사한다 (`src/lib/codex-image.ts`).
- `api`: 메터링 OpenAI Responses API 사용. `OPENAI_API_KEY` 필요.

주의: `codex` 경로는 브리지 서버 프로세스의 `CODEX_HOME`이 unset(기본 `~/.codex`)인 것에 의존한다. 세션 spawn은 child env에서만 `CODEX_HOME`을 세션 `.codex`로 리포인트하므로(`src/lib/codex-process.ts`), 서버 env에 `CODEX_HOME`을 설정하지 말 것.

## 2. Claude Code

Claude Code는 Anthropic Messages 형식을 기준으로 동작한다. 외부 OpenAI 호환 Chat Completions API에 직접 붙이는 방식은 일반적으로 맞지 않고, Anthropic Messages 형식을 노출하는 게이트웨이나 변환 프록시가 필요하다. 이 프로젝트에서는 기존 Claude 모델은 OAuth 흐름을 유지하고, 외부 OpenAI 호환 모델은 Codex gateway 경로를 우선 사용한다.

### 옵션 A: Claude Code Router

설치:

```bash
npm install -g @musistudio/claude-code-router
```

`~/.claude-code-router/config.json` 예시:

```json
{
  "Providers": [
    {
      "name": "deepseek",
      "baseUrl": "https://api.deepseek.com/v1",
      "apiKey": "$DEEPSEEK_API_KEY",
      "models": ["deepseek-chat"]
    }
  ],
  "Router": {
    "default": "deepseek,deepseek-chat"
  }
}
```

실행:

```bash
ccr code
```

주의: Claude Code Router 문서와 예시에는 버전에 따라 `baseUrl`, `HOST`, `api_base_url` 같은 키 이름이 혼재한다. 설치한 버전의 문서와 샘플 config를 기준으로 맞춘다.

Claude Code용 `ANTHROPIC_*` 전역 env는 기존 OAuth/subscription 인증을 덮어쓸 수 있으므로 `.env.local` 기본 예시에는 넣지 않는다.

## 3. 프로바이더 선택 기준

가격, 컨텍스트 길이, 모델 ID는 자주 바뀐다. 문서에 고정 가격표를 넣기보다, 실제 설정 직전에 각 프로바이더의 공식 문서를 확인한다.

실무 기준:

| 프로바이더 | 장점 | 주의점 |
| --- | --- | --- |
| OpenRouter | 한 키로 여러 모델 테스트 가능 | 모델별 기능, 툴 호출 품질, 가격이 자주 바뀜 |
| Moonshot Kimi | 긴 컨텍스트와 코딩 모델 선택지 | 모델 ID와 API 호환성 확인 필요 |
| DeepSeek | 비용 대비 성능이 좋은 편 | Claude/Codex 도구 호출 호환성 검증 필요 |
| Qwen | 한국어/중국어/일본어 계열 작업에 강한 편 | 제공 경로마다 모델 ID가 다를 수 있음 |
| GLM/Z.ai | 중국어 작업과 일부 코딩 모델 선택지 | Anthropic 형식 게이트웨이 제공 여부 확인 필요 |

## 4. 체크리스트

- API-key 방식이 필요한 외부 gateway 모델을 선택했을 때만 키를 환경변수로 주입했는가?
- 기존 OAuth 방식 CLI라면 불필요한 override env가 설정되어 있지 않은가?
- Codex 외부 gateway가 Responses API를 노출하는가?
- Codex에 붙일 게이트웨이가 Responses API를 실제로 지원하는가?
- Claude Code라면 게이트웨이가 Anthropic Messages 형식을 노출하는가?
- Claude Code 프록시가 `anthropic-beta`, `anthropic-version` 헤더를 전달하는가?
- 모델 ID가 정확한가?
- MCP와 tool calling을 실제 작업으로 검증했는가?

## 5. 알려진 제약

- Claude Code의 도구 호출은 Anthropic tool use 형식을 전제로 한다. 변환 프록시가 이를 제대로 변환하지 못하면 코드 편집, MCP, tool search 품질이 떨어진다.
- Codex의 일부 기능은 OpenAI Responses API 및 OpenAI 모델 전용 기능에 의존할 수 있다.
- 외부 모델은 reasoning, tool calling, 이미지 입력, 긴 컨텍스트 지원 범위가 다르다.
- 게이트웨이를 쓰면 인증, 로깅, 프롬프트 캐싱, 헤더 전달 문제가 추가된다.
- 가격표와 컨텍스트 길이는 문서에 박아두기보다 설정 시점에 확인하는 것이 안전하다.
