---
name: publish-persona
description: 페르소나를 GitHub에 퍼블리시할 때 호출. 리포 생성, remote 설정, push까지 진행.
allowed-tools: Read, Edit, Write, Bash, Glob
---

# Publish Persona to GitHub

## 절차

### 1. persona.json 확인/생성
- `persona.json`이 없으면 생성:
  ```json
  {
    "displayName": "(persona.md 첫 줄에서 추출)",
    "description": "(사용자에게 물어보거나 persona.md에서 요약)",
    "tags": [],
    "version": "1.0.0",
    "author": "(사용자 GitHub 유저명)"
  }
  ```
- 이미 있으면 version 업데이트 여부를 사용자에게 확인

### 2. .gitignore 확인
다음 파일들이 `.gitignore`에 포함되어 있는지 확인. 없으면 추가:
- `chat-history.json`
- `memory.md`
- `builder-session.json`
- `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`
- `.claude/`, `.agents/`, `.gemini/`, `.codex/`

### 3. 이미 tracked된 민감 파일 제거
```bash
git rm --cached chat-history.json memory.md builder-session.json 2>/dev/null || true
```

### 4. GitHub 리포 생성 및 Push

#### GitHub MCP가 있는 경우:
1. GitHub MCP로 리포 생성 (사용자에게 리포 이름 확인)
2. `git remote add origin <url>`
3. `git add -A && git commit -m "Publish persona"`
4. `git push -u origin master` (또는 현재 브랜치)

#### GitHub MCP가 없는 경우:
1. 사용자에게 GitHub에서 빈 리포를 직접 만들라고 안내
2. URL을 받아서 `git remote add origin <url>`
3. `git add -A && git commit -m "Publish persona"`
4. `git push -u origin master`

### 5. 이후 업데이트 Push
이미 remote가 설정된 경우:
```bash
git add -A
git commit -m "Update persona"
git push
```
