# Persona Sharing System Design

## Overview

GitHub를 백엔드로 활용하는 페르소나 공유 시스템. 중앙 레지스트리 없이 GitHub URL만으로 페르소나를 공유하고 설치할 수 있다. 기존 페르소나 내부 git 버전 관리를 그대로 활용한다.

## Goals

- 로컬에서 만든 페르소나를 GitHub에 퍼블리시
- GitHub URL로 외부 페르소나를 미리보기 후 설치
- 설치된 외부 페르소나의 업데이트 확인 및 적용
- Import/업데이트 시 보안 점검 제안
- 빌더 세션(AI)을 활용한 publish/update 자동화

## Non-Goals

- 중앙 마켓플레이스 UI (추후 큐레이션 목록으로 확장 가능)
- OAuth 기반 GitHub 연동
- 클라우드 호스팅 / SaaS

---

## 1. Metadata — `persona.json`

페르소나 리포 루트에 위치하는 메타데이터 파일. 현재는 Import 미리보기에 사용하고, 향후 레지스트리/큐레이션 대비.

```json
{
  "displayName": "미쿠",
  "description": "보컬로이드 하츠네 미쿠와의 일상 RP",
  "tags": ["vocaloid", "casual"],
  "version": "1.0.0",
  "author": "github-username"
}
```

### 필드 정의

| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| `displayName` | string | Y | 표시 이름 |
| `description` | string | Y | 페르소나 설명 (1-2줄) |
| `tags` | string[] | N | 검색/분류용 태그 |
| `version` | string | N | semver 버전 |
| `author` | string | N | GitHub 유저명 |

---

## 2. Publish (페르소나 → GitHub)

기존 페르소나 내부 `.git`을 그대로 활용. remote만 추가하면 된다.

### 두 가지 방식

#### A. URL 직접 입력

유저가 GitHub에서 리포를 미리 생성한 후 URL을 입력.

1. Publish 버튼 클릭 → URL 입력 다이얼로그
2. `POST /api/personas/[name]/publish` 호출
3. 서버에서 `git remote add origin <url>` + `git push -u origin master`
4. `persona.json` 없으면 자동 생성 후 commit & push

#### B. 빌더 세션으로 진행

GitHub MCP 등이 연동된 환경에서 AI가 리포 생성부터 push까지 처리.

1. Publish 버튼 → "빌더 세션으로 진행" 선택
2. 빌더 페이지 열기 + 자동 메시지 주입:
   > "이 페르소나를 GitHub에 퍼블리시해줘. 리포 생성, remote 설정, push까지 진행해줘."
3. AI가 GitHub MCP를 활용해 리포 생성 → remote 설정 → persona.json 생성 → push

### .gitignore 관리

Publish 시 민감/불필요 파일이 제외되도록 `.gitignore` 업데이트:

```gitignore
# Session/runtime files (excluded from publish)
chat-history.json
memory.md
builder-session.json
CLAUDE.md
AGENTS.md
GEMINI.md
.claude/
.agents/
.gemini/
```

---

## 3. Import (GitHub → 설치)

### 흐름

1. **URL 입력** — 로비에서 Import 버튼 → GitHub URL 입력
2. **미리보기** — `persona.json` + `images/icon.png`를 GitHub Raw API로 fetch
   - 표시: 이름, 설명, 태그, 아이콘
   - `persona.json` 없는 리포: `persona.md` 첫 줄에서 이름 추출, 아이콘만 표시
3. **설치** — "설치" 버튼 → `git clone <url> data/personas/<name>/`
   - 폴더명은 리포 이름에서 추출 (예: `persona-miku` → `persona-miku`)
   - 동일 이름이 이미 존재하면 설치 차단 및 안내
4. **보안 점검 제안** — 설치 완료 후:
   > "외부 페르소나의 보안 점검을 진행하시겠습니까?"
   - **Yes** → 빌더 세션 열기 + 보안 점검 skill 자동 실행
   - **No** → 바로 사용 가능

### 설치 후 메타데이터 기록

설치된 페르소나의 origin 정보를 추적하기 위해 `import-meta.json` 저장:

```json
{
  "source": "github",
  "url": "https://github.com/user/persona-miku",
  "installedAt": "2026-04-10T12:00:00Z",
  "installedCommit": "abc1234"
}
```

---

## 4. Update (업데이트 확인 및 적용)

### 업데이트 체크

- 로비 UI에서 import된 페르소나에 **"업데이트 체크" 버튼** 표시
- `POST /api/personas/[name]/check-update` → `git fetch` → local HEAD vs remote HEAD 비교
- 뒤쳐졌으면 업데이트 가능 표시 (커밋 수 차이 등)

### 업데이트 적용

- 실제 업데이트는 **빌더 세션에서 AI가 처리** (pull, rebase 등)
- 로컬 수정사항이 있으면 AI가 판단해서 merge/rebase
- **업데이트 시에도 보안 점검 진행 여부를 제안** (새 코드가 유입되므로)

---

## 5. Security Review Skill

Import 및 업데이트 시 빌더 세션에서 실행되는 보안 점검 skill.

### 점검 항목

| 대상 | 점검 내용 |
|------|-----------|
| `tools/*.js` | 파일시스템 접근, 네트워크 요청, `child_process`, `eval`, 위험 패턴 |
| `hooks/on-message.js` | 동일 |
| `panels/*.html` | 외부 스크립트 로드, XSS 가능성 |
| `session-instructions.md` | prompt injection 시도 여부 |

### 결과 보고

빌더 세션에서 AI가 점검 결과를 요약 보고. 위험 요소 발견 시 구체적으로 설명하고 조치 권고.

---

## 6. API Endpoints

| Method | 엔드포인트 | 설명 |
|--------|-----------|------|
| `POST` | `/api/personas/import/preview` | GitHub URL → 메타데이터 + 아이콘 fetch |
| `POST` | `/api/personas/import` | `git clone`으로 설치, `import-meta.json` 기록 |
| `POST` | `/api/personas/[name]/publish` | URL 직접 입력 방식: remote 설정 + push |
| `POST` | `/api/personas/[name]/check-update` | `git fetch` → 업데이트 확인 |

---

## 7. UI Touch Points

### 로비 (Lobby)

- **Import 버튼** — GitHub URL 입력 → 미리보기 → 설치 → 보안 점검 제안
- **업데이트 체크 버튼** — import된 페르소나에만 표시. 뒤쳐졌으면 업데이트 가능 배지

### 페르소나 상세 / 빌더

- **Publish 버튼** — URL 직접 입력 or 빌더 세션으로 진행

---

## 8. AI Guide Documents

빌더 세션에서 AI가 참조할 문서/skill:

### Publish Guide Skill

- `persona.json` 생성 절차
- `.gitignore` 확인 및 민감 파일 제외
- GitHub MCP 활용 시 리포 생성 + push 절차
- 수동(URL 입력) 방식 시 안내 메시지

### Security Review Skill

- 점검 항목 체크리스트
- 위험 패턴 목록
- 결과 보고 형식

---

## 9. Data Flow

```
[Publish]
  페르소나 폴더 (.git 존재)
    → URL 직접: API가 remote add + push
    → 빌더 세션: AI가 리포 생성 + remote add + push
    → GitHub 리포 공개

[Import]
  GitHub URL 입력
    → API가 persona.json + icon fetch (미리보기)
    → 유저 확인 → git clone → data/personas/ 저장
    → import-meta.json 기록
    → 보안 점검 제안 → (선택) 빌더 세션 + security skill

[Update]
  업데이트 체크 버튼
    → API가 git fetch + HEAD 비교
    → 뒤쳐졌으면 표시
    → 유저가 빌더 세션에서 업데이트 지시
    → 보안 점검 제안 → (선택) 빌더 세션 + security skill
```
