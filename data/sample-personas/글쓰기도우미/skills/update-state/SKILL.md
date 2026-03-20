---
name: update-state
description: 세션 상태 변수(커뮤니티, 작업 단계, 문서 수)를 갱신할 때 사용
allowed-tools: Read, Edit
---

# 상태 변수 갱신

## 변수 목록
- `community` (string): 현재 타겟 커뮤니티명. 커뮤니티 분석 완료 시 설정.
- `community_tone` (string): 커뮤니티 톤 한 줄 요약. 분석 결과를 간결하게 기록.
- `stage` (string): 현재 작업 단계. article.json의 stage와 동기화한다.
  - 가능한 값: "대기", "분석중", "초안", "수정중", "검토", "완성"
- `doc_count` (int): docs/ 폴더의 보관 문서 수. 저장/삭제 시 갱신.

## 갱신 규칙
1. `variables.json`을 Read로 읽는다
2. 변경이 필요한 필드만 Edit으로 수정한다
3. JSON 유효성을 반드시 유지한다 (쉼표, 따옴표 확인)
4. 커뮤니티 변경 시 `community`와 `community_tone`을 함께 업데이트한다
5. article.json의 stage가 변경되면 variables.json의 stage도 동기화한다

## 주의
- 변수명을 임의로 추가하지 않는다 (위 4개만 사용)
- doc_count는 실제 docs/ 파일 수와 일치해야 한다
