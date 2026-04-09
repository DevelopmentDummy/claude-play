# Publish Guide

페르소나를 GitHub에 퍼블리시할 때 이 가이드를 참조하라.

---

## 1. `persona.json` 확인 / 생성

`persona.json`이 없으면 생성한다. 최소 구조:

```json
{
  "displayName": "캐릭터 표시 이름",
  "description": "이 페르소나에 대한 간단한 설명",
  "tags": ["fantasy", "romance"],
  "version": "1.0.0",
  "author": "작성자 이름 또는 GitHub 핸들"
}
```

필드 설명:
- `displayName` — 서비스 내 표시 이름 (필수)
- `description` — 페르소나 소개 (필수)
- `tags` — 분류 태그 (선택, 배열)
- `version` — 시맨틱 버전 (선택, 기본 `"1.0.0"`)
- `author` — 제작자 정보 (선택)

---

## 2. `.gitignore` 확인

페르소나 디렉토리의 `.gitignore`에 다음 항목이 포함되어 있는지 확인하라. 없으면 추가한다:

```
# Private / sensitive files — do not publish
chat-history.json
memory.md
builder-session.json
CLAUDE.md
AGENTS.md
GEMINI.md
.claude/
.agents/
.gemini/
.codex/
```

이 파일들은 로컬 세션 상태, 내부 지시문, AI 런타임 설정을 포함하므로 공개 저장소에 올려서는 안 된다.

---

## 3. Git 초기화 (최초 퍼블리시)

페르소나 디렉토리 안에서 Git이 초기화되어 있지 않으면:

```bash
git init
git add -A
git commit -m "Initial publish"
```

---

## 4. 원격 저장소 연결 및 푸시

### GitHub MCP가 사용 가능한 경우

1. GitHub MCP 도구로 새 저장소를 생성한다 (저장소 이름 = 페르소나 이름 권장)
2. 반환된 URL로 원격 연결:

```bash
git remote add origin <GitHub 저장소 URL>
git push -u origin master
```

### GitHub MCP가 없는 경우

사용자에게 직접 안내한다:

> "GitHub(https://github.com/new)에서 새 저장소를 만들어주세요. 완료 후 저장소 URL을 알려주시면 연결하겠습니다."

URL을 받으면:

```bash
git remote add origin <사용자가 제공한 URL>
git push -u origin master
```

### origin이 이미 설정된 경우

```bash
git push
```

---

## 5. 이후 업데이트 퍼블리시

초기 퍼블리시 이후 변경사항을 반영할 때:

```bash
git add -A
git commit -m "업데이트 내용을 설명하는 커밋 메시지"
git push
```

커밋 메시지는 무엇을 변경했는지 간략히 설명한다. 예: `"Add new panel and update variables"`, `"Fix engine action bug"`.

---

## 주의사항

- `.gitignore`는 반드시 첫 커밋 전에 확인하라. 한번 커밋된 파일은 이후 `.gitignore`에 추가해도 원격 저장소에서 자동으로 삭제되지 않는다.
- 퍼블리시 전 `tools/*.js` 또는 `hooks/*.js`에 API 키나 개인 정보가 하드코딩되어 있지 않은지 확인하라.
