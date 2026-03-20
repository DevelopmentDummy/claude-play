# Setup Wizard Design

**Date**: 2026-03-20
**Status**: Approved

## Overview

Claude Bridge 배포를 위한 3단계 셋업 시스템: CLI 스크립트 → 웹 마법사 → AI 가이드.

- **CLI (`setup.js`)**: 서버가 뜰 수 있는 환경을 만드는 것 (인프라)
- **웹 UI (`/setup`)**: 서비스 동작에 필요한 설정 (서비스 연결)
- **AI 가이드 (`SETUP.md`)**: AI 에이전트가 자율적으로 셋업할 수 있는 문서

## 1. CLI 셋업 스크립트 (`setup.js`)

**실행**: `node setup.js` (의존성 제로, Node.js만 필요)

**언어**: 순수 JavaScript (npm install 이전에 실행되므로 TypeScript 불가)

**인터랙티브**: `readline` 기반 프롬프트. `--yes` 플래그로 비대화형 모드 지원 (AI 에이전트용, 모든 프롬프트에 기본값 사용).

### 단계별 흐름

1. **Node.js 버전 체크** — 18+ 필수. 미충족 시 중단.
2. **npm install** — 프로젝트 의존성 설치.
3. **Python 확인** — `python` / `python3` 탐색. 없으면 경고 후 "계속할까요?" 프롬프트.
4. **Python venv 생성** — `gpu-manager/` 에 venv 생성 + `requirements.txt` 설치.
5. **PyTorch GPU 설정**:
   - `nvidia-smi`로 CUDA 버전 감지
   - CUDA 버전 매핑: `>=12.4` → cu124, `>=12.1` → cu121, `>=11.8` → cu118
   - CUDA 있음 → `pip install torch --index-url https://download.pytorch.org/whl/{cuda_tag}` (확인 프롬프트)
   - CUDA 없음 또는 매핑 불가 → CPU 버전 설치 (fallback)
6. **ComfyUI 자동 설치** (선택, VRAM >= 8GB일 때만 제안):
   - "ComfyUI를 설치하시겠습니까?" 프롬프트
   - Yes → ComfyUI 리포 클론 + Python venv 생성 + 의존성 설치
   - 설치 경로 입력 (기본값: `../ComfyUI`)
   - "추천 체크포인트 모델을 다운로드하시겠습니까?" 프롬프트
     - Yes → CivitAI API 키 입력 → 키 검증 → 추천 모델(Illustrious XL 계열) 다운로드
     - No 또는 키 없음 → "나중에 모델을 직접 다운로드하세요" 안내 + 스킵
7. **Claude Code CLI 확인** — `claude --version`. 없으면 경고 출력 (중단하지 않음).
8. **포트 설정** — 메인 포트 입력 (기본값: 3340). TTS = 메인+1, GPU Manager = 메인+2로 자동 할당.
9. **.env.local 생성** — 없을 때만 기본 템플릿 생성 (PORT, COMFYUI_URL 등 포함). 이미 존재하면 스킵.
10. **포트 충돌 검사** — 메인, 메인+1, 메인+2 세 포트. 사용 중이면 프로세스 정보와 함께 경고.
11. **data/ 디렉토리 초기화** — `personas/`, `sessions/`, `profiles/`, `tools/` 생성.
12. **완료 메시지** — `npm run dev`(개발) 또는 `npm run build && npm run start`(프로덕션)로 시작 안내.

### 에러 처리

- 각 단계 실패 시 에러 메시지 출력 후 "계속할까요? (Y/n)" 프롬프트
- 필수 단계 (npm install) 실패 시에만 중단

## 2. 웹 셋업 마법사 (`/setup`)

### 진입 조건

- `data/.setup-complete` 파일 미존재 시 → 모든 경로에서 `/setup`으로 리다이렉트 (**`server.ts`에서 처리** — Edge Runtime middleware는 `fs` 접근 불가)
- 설정 완료 후에도 `/setup`으로 직접 접근 가능 (ADMIN_PASSWORD 설정 상태면 로그인 필요)
- 리다이렉트 제외 경로: `/setup`, `/api/setup/*`, `/_next/*`, 정적 파일

### 마법사 스텝

**Step 1: 관리자 비밀번호**
- 비밀번호 입력 + 확인 입력
- 강도 표시 (선택)

**Step 2: ComfyUI 연결 (선택사항)**
- "ComfyUI를 사용하시나요?" 토글
- Yes:
  - 호스트/포트 입력 (기본값: 127.0.0.1:8188)
  - "ComfyUI 서비스를 실행한 후 아래 버튼을 눌러주세요" 안내
  - [연결 테스트] 버튼 → 성공/실패 결과 표시
  - 실패 시 "다시 시도" 또는 "나중에 설정" 옵션
- No: 스킵

**Step 3: API 키 (선택사항)**
- **Gemini API 키**: "Gemini 이미지 생성을 사용하시나요?" 토글 → Yes: 키 입력 + 즉시 검증
- **CivitAI API 키**: "CivitAI에서 모델을 다운로드하시겠습니까?" 토글 → Yes: 키 입력 (체크포인트/LoRA 다운로드용)

**Step 4: TTS 설정**
- Edge TTS (클라우드, 무료) 활성화 여부
- Local TTS (GPU, 음성 클로닝) 활성화 여부

**Step 5: 확인 & 완료**
- 설정 요약 표시
- "설정 완료" → `.env.local` 저장 + `data/.setup-complete` 생성 + 서버 자동 재시작

### API 엔드포인트

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/setup/status` | GET | 각 항목 현재 설정 상태 반환 |
| `/api/setup/save` | POST | 설정 저장 + 서버 재시작 트리거 |
| `/api/setup/test-comfyui` | POST | ComfyUI 연결 테스트 |
| `/api/setup/test-gemini` | POST | Gemini API 키 검증 |

**보안**: `data/.setup-complete` 존재 시 모든 `/api/setup/*` 엔드포인트는 ADMIN_PASSWORD 인증 필수. 초기 셋업 중(`.setup-complete` 미존재)에만 인증 없이 접근 가능.

### 재시작 메커니즘

- `.env.local` 저장 후 `process.env`를 즉시 업데이트 (현재 프로세스에도 반영)
- Dev 모드: 트리거 파일 touch → `tsx watch`가 파일 변경 감지 → 자동 재시작
- Production 모드: 새 프로세스를 spawn한 후 현재 프로세스 exit
- 프론트엔드는 폴링으로 서버 복귀 감지 후 홈으로 이동

## 3. AI 셋업 가이드 (`SETUP.md`)

AI 에이전트가 읽고 자율적으로 셋업을 수행할 수 있는 구조화된 문서.

### 구조

```
# Claude Bridge 설치 가이드

## 전제 조건
  - Node.js 18+
  - Python 3.10+ (GPU Manager용, 선택)
  - Claude Code CLI (선택)

## Step 1: CLI 셋업
  node setup.js
  - 예상 프롬프트와 권장 응답 목록

## Step 2: 서버 시작
  npm run dev

## Step 3: 웹 셋업
  브라우저에서 http://localhost:3340/setup 접속
  - 각 스텝별 입력 항목과 설명

## 검증
  - 서버 정상 동작 확인 방법
  - 각 서비스 헬스체크 엔드포인트

## 트러블슈팅
  - 자주 발생하는 에러와 해결법
```

### 핵심 원칙

각 단계마다 **실행할 명령어**, **예상 출력**, **성공/실패 판단 기준**이 명확히 기술되어 에이전트가 자율적으로 진행 가능.

## 4. 기존 코드 변경사항

### server.ts

- `/setup` 리다이렉트 로직 추가 (`data/.setup-complete` 존재 여부로 판단, `fs` 사용 가능)
- 제외 경로: `/setup`, `/api/setup/*`, `/_next/*`, 정적 파일
- `/api/setup/save` 처리 후 재시작 메커니즘 (dev: 트리거 파일 touch, prod: spawn + exit)
- **포트 자동 계산**: `PORT` 환경변수 기준으로 `TTS_PORT = PORT+1`, `GPU_MANAGER_PORT = PORT+2` 자동 할당. 개별 환경변수가 명시되어 있으면 그 값을 우선 사용 (하위 호환).

### .env.local 관리

- `setup.js`가 기본 템플릿 생성
- 웹 마법사가 값을 업데이트 (파일 직접 읽기/쓰기)

## 5. 신규 파일 목록

| 파일 | 역할 |
|------|------|
| `setup.js` | CLI 셋업 스크립트 (순수 JS) |
| `.env.example` | 환경변수 템플릿 |
| `SETUP.md` | AI용 셋업 가이드 |
| `src/app/setup/page.tsx` | 웹 셋업 마법사 UI |
| `src/app/api/setup/status/route.ts` | 설정 상태 조회 API |
| `src/app/api/setup/save/route.ts` | 설정 저장 + 재시작 API |
| `src/app/api/setup/test-comfyui/route.ts` | ComfyUI 연결 테스트 API |
| `src/app/api/setup/test-gemini/route.ts` | Gemini 키 검증 API |
