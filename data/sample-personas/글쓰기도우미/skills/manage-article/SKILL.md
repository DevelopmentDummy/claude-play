---
name: manage-article
description: 글 저장(docs/ 보관), 불러오기, 목록 조회, 새 글 시작, 삭제 등 문서 관리 작업 시 사용
allowed-tools: Read, Write, Edit, Glob
---

# 문서 관리

article.json(현재 작업 글)과 docs/(보관 라이브러리)를 관리한다.

## 저장 (보관)

1. 현재 `article.json`을 Read로 읽는다
2. 파일명을 생성한다:
   - 형식: `{YYYY-MM-DD}_{커뮤니티약칭}_{제목요약}.json`
   - 커뮤니티 약칭 예: 디시인사이드 → `dc`, 에펨코리아 → `fm`, 루리웹 → `ruli`, 클리앙 → `clien`
   - 제목은 영문/한글 10자 이내로 요약, 특수문자와 공백은 `-`로 대체
   - 예: `2026-03-12_dc_AI발전전망.json`
3. `docs/` 디렉토리에 Write로 저장한다 (디렉토리가 없으면 생성)
4. `article.json`을 Edit로 업데이트:
   - `dirty` → `false`
   - `savedAs` → 저장된 파일명
5. `variables.json`의 `doc_count`를 갱신한다 (/update-state)

## 불러오기

1. `docs/*.json`을 Glob으로 조회한다
2. 각 파일의 title, community를 Read로 확인하여 목록을 사용자에게 보여준다
3. 사용자가 선택하면 해당 파일을 Read로 읽는다
4. **현재 article.json에 dirty 내용이 있으면 저장 여부를 먼저 확인한다**
5. 선택된 파일 내용으로 `article.json`을 Write로 덮어쓴다
6. `dirty` → `false`, `savedAs` → 해당 파일명

## 새 글 시작

1. 현재 `article.json`의 `dirty`가 `true`이면 저장 여부를 사용자에게 확인한다
2. `article.json`을 Write로 초기화한다:
```json
{
  "title": "",
  "body": "",
  "community": "",
  "tags": [],
  "stage": "대기",
  "dirty": false,
  "notes": "",
  "savedAs": ""
}
```
3. `variables.json`의 `stage`도 "대기"로 갱신한다

## 삭제

1. 사용자에게 삭제 확인을 받는다
2. 해당 파일의 내용을 빈 JSON `{}`으로 Write한다 (또는 Bash로 삭제)
3. `doc_count`를 갱신한다
4. 현재 article.json의 `savedAs`가 삭제된 파일이면 `savedAs`를 빈 문자열로 설정

## Dirty 체크 규칙

- article.json의 내용을 수정할 때마다 `dirty: true` 설정
- 저장 완료 시 `dirty: false` 설정
- 불러오기 직후에는 `dirty: false`
- 새 글 시작 시 `dirty: false`
- `savedAs`에 원본 파일명을 유지하여 어디서 불러온 글인지 추적
