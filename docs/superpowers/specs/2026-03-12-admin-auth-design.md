# Admin Authentication Design

## Overview

Claude Bridge에 단일 어드민 비밀번호 인증을 추가한다. Cloudflare Tunnel로 외부에 노출된 서비스를 보호하기 위한 최소한의 인증 레이어.

## Requirements

- 단일 비밀번호 인증 (ID 없음)
- 환경변수 `ADMIN_PASSWORD`로 비밀번호 설정
- `ADMIN_PASSWORD` 미설정 시 인증 비활성화 (로컬 개발 편의)
- 90일 쿠키 유지 (브라우저 닫아도 로그인 유지)
- 모든 경로 보호: 페이지, API, WebSocket, TTS 라우트

## Architecture

### Authentication Token

- 로그인 성공 시 HMAC-SHA256 서명된 토큰 발급
- 토큰 페이로드: `{ timestamp }` (JSON)
- 서명 키: `ADMIN_PASSWORD` + 고정 salt (`"claude-bridge-auth"`)를 SHA-256으로 해싱하여 파생
- 토큰 형식: `base64(payload).base64(signature)`
- `httpOnly`, `sameSite=strict` 쿠키로 저장, 90일 만료
- `secure` 플래그: `NODE_ENV === 'production'`일 때만 활성화 (로컬 HTTP 개발 호환)
- 서버사이드 만료 검증: `verifyAuthToken()`에서 `timestamp`가 90일 이내인지 확인 (쿠키 만료와 별개로 서버에서도 검증)
- 모든 비교 연산에 `crypto.timingSafeEqual()` 사용 (타이밍 공격 방지)

### Middleware (`src/middleware.ts`)

모든 요청을 가로채서 인증 상태 확인.

**예외 경로** (인증 불필요):
- `/login` — 로그인 페이지
- `/api/auth/*` — 인증 API (login, logout)
- `/_next/*` — Next.js 정적 에셋 (기존 matcher에서 이미 제외)
- `/favicon.ico` — 파비콘 (기존 matcher에서 이미 제외)

**MCP 서버 예외**:
- `x-bridge-token` 헤더가 유효한 요청은 쿠키 검증 건너뜀 (MCP 서버는 브라우저가 아니므로 쿠키 없음)

**인증 비활성화 시** (`ADMIN_PASSWORD` 미설정):
- 모든 요청 통과 (기존 동작)

**동작**:
- 쿠키 없거나 서명 검증 실패 시:
  - 페이지 요청 → `/login`으로 리다이렉트
  - API 요청 → 401 JSON 응답
- 인증된 사용자가 `/login` 접근 시 → `/`로 리다이렉트

### WebSocket 보호 (`src/lib/ws-server.ts`)

- HTTP 업그레이드 요청의 `Cookie` 헤더에서 토큰 수동 파싱 (`IncomingMessage`이므로 Next.js cookie API 사용 불가)
- 인증 비활성화 시 검증 건너뜀
- 토큰 검증 실패 시 연결 거부 (401 응답 후 소켓 종료)

### TTS 라우트 보호 (`server.ts`)

- `server.ts`에서 Next.js 전에 인터셉트하는 TTS 라우트에도 쿠키 검증 추가
- 인증 비활성화 시 검증 건너뜀
- 검증 실패 시 401 응답

### Login Page (`src/app/login/page.tsx`)

- 단순 비밀번호 입력 폼
- `POST /api/auth/login`으로 비밀번호 전송
- 실패 시 에러 메시지 표시
- 성공 시 `/`로 리다이렉트

### Login API (`src/app/api/auth/login/route.ts`)

- `POST`: 비밀번호 검증, 쿠키 설정
- 비밀번호 비교 시 `crypto.timingSafeEqual()` 사용
- 비밀번호 일치 시 서명된 토큰 쿠키 + 200 응답
- 불일치 시 401 응답
- 로그인 시도 제한: IP당 분당 5회 (인메모리 `Map<ip, { count, resetTime }>`), 초과 시 429 응답

### Logout API (`src/app/api/auth/logout/route.ts`)

- `POST`: 쿠키 삭제 (`Max-Age=0`)
- 200 응답

## File Changes

| File | Change Type | Description |
|------|-------------|-------------|
| `src/lib/auth.ts` | Modify | `createAuthToken()`, `verifyAuthToken()`, `isAuthEnabled()`, `parseCookieToken()` 추가 |
| `src/middleware.ts` | Modify | 쿠키 검증 로직으로 교체 |
| `src/app/login/page.tsx` | New | 로그인 페이지 |
| `src/app/api/auth/login/route.ts` | New | 로그인 API (rate limiting 포함) |
| `src/app/api/auth/logout/route.ts` | New | 로그아웃 API |
| `src/lib/ws-server.ts` | Modify | 업그레이드 시 쿠키 검증 추가 |
| `server.ts` | Modify | TTS 인터셉트 라우트에 쿠키 검증 추가 |
| `CLAUDE.md` | Modify | `ADMIN_PASSWORD` 환경변수 문서화 |

## Security Considerations

- `httpOnly` 쿠키 → XSS로 토큰 탈취 불가
- `sameSite=strict` → CSRF 방지
- `secure` 플래그 → production에서만 활성화 (HTTPS 전용)
- HMAC 서명 + 고정 salt → 토큰 위변조 불가, 레인보우 테이블 방지
- `crypto.timingSafeEqual()` → 비밀번호 비교 및 서명 검증 시 타이밍 공격 방지
- 서버사이드 토큰 만료 검증 → 쿠키 탈취 시에도 90일 후 무효화
- 로그인 rate limiting → 브루트포스 공격 완화
- 비밀번호 변경 시 (환경변수 변경 + 서버 재시작) 기존 토큰 자동 무효화 (서명 키가 달라지므로)
- `ADMIN_PASSWORD` 미설정 시 인증 완전 비활성화 — 프로덕션 배포 시 반드시 설정 필요
