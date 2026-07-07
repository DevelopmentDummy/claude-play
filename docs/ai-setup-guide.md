# Claude Play — AI Agent Setup Guide

이 문서는 AI 에이전트가 Claude Play를 설치할 때 단계별로 따라야 하는 가이드입니다.
각 단계를 순서대로 실행하고, 결과를 확인한 후 다음 단계로 진행하세요.

## Step 1: CLI Setup

```bash
node setup.js --yes
```

- 의존성 설치, Python venv, 빌드 등을 자동으로 진행합니다.
- 완료되면 프로세스가 종료됩니다. **서버가 시작되지 않습니다.**
- `--yes` 모드는 선택형 GPU 구성요소를 모두 건너뜁니다: 로컬 TTS 엔진(Qwen3-TTS/VoxCPM2)과 ComfyUI 설치가 기본값 "건너뛰기/No"로 자동 선택됩니다. 이것들이 필요하면 사용자에게 알리고, 대화형 `node setup.js`(`--yes` 없이)로 다시 실행해야 합니다.
- `data/personas/`가 비어 있으면 GitHub에서 샘플 페르소나 3종(quiz-hana, princessmaker, detective)을 git clone합니다 — git과 네트워크가 필요하며, 실패 시 경고만 남기고 계속 진행합니다.
- 결과를 사용자에게 요약 보고하세요.

## Step 2: Web Setup

```bash
node setup-web.js
```

- 프로덕션 서버를 백그라운드로 시작합니다.
- 포트는 `.env.local`의 `PORT`를 읽습니다(기본 3340). `/api/setup/status`가 401을 반환하면(ADMIN_PASSWORD 활성) 셋업 완료로 간주합니다 — 포트/인증 관련 혼선 진단 시 참고.
- 브라우저가 자동으로 열려 설정 마법사(`/setup`)가 표시됩니다.
- 사용자가 브라우저에서 설정을 완료할 때까지 대기합니다.
- 설정이 완료되면 서버를 종료하고 완료 메시지를 출력합니다.

**이 스크립트가 끝날 때까지 기다리세요.** 출력 결과를 사용자에게 전달하세요.

## Step 3: 사용자 안내

`setup-web.js`가 종료되면 사용자에게 다음을 안내하세요:

- `start.bat`을 더블클릭하거나 `npm run start`로 서버를 시작할 수 있습니다.
  - `start.bat`은 서버 시작 외에 ComfyUI 서브모듈이 설치되어 있으면(`comfyui_submodule/main.py` + venv) `start-comfyui.bat`으로 ComfyUI도 자동 실행합니다.
- 개발 모드: `npm run dev`

## 주의사항

- Step 1과 Step 2를 하나의 명령으로 연결하지 마세요 (`&&` 금지). 각 단계의 결과를 사용자에게 보고한 후 다음을 진행하세요.
- 이미 웹 셋업이 완료된 경우 `setup-web.js`는 서버를 잠시 기동해 상태를 확인한 뒤 사용자 입력 없이 스스로 종료됩니다 (수십 초 걸릴 수 있음 — 멈춘 것이 아니니 kill하지 마세요).
- RTX 50 시리즈(Blackwell, sm_120) GPU: `setup.js`의 CUDA 태그 자동 감지는 cu124까지만 지원하므로, 로컬 TTS용 PyTorch는 cu128 빌드를 수동 설치해야 합니다.
- 상세한 설치 옵션과 트러블슈팅은 [SETUP.md](../SETUP.md)를 참고하세요.
