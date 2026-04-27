# 세션 Resume 메뉴 — Design

## 배경 / 동기

세션이 새로 생성되는 버그(기존 대화로 연결되지 않고 새 세션이 시작됨)를 우회할 수 있도록, 사용자가 같은 페르소나의 과거 세션 목록을 보고 직접 골라서 resume 할 수 있는 메뉴를 제공한다.

이미 `/chat/{folderName}` 라우팅 + `POST /api/sessions/{id}/open`이 provider별 `--resume <id>`로 컨텍스트를 복원하는 로직을 갖추고 있으므로, 이번 작업은 **"같은 페르소나의 세션 목록을 보고 라우팅"** 만 추가하면 된다.

## 범위

- **In**: 현재 채팅 세션 페이지에서 같은 페르소나의 과거 세션 리스트 모달, 메타정보 파싱, 클릭 시 라우팅
- **Out**: 빌더 모드 / 페르소나 카드 페이지(이미 `SessionCard`가 있음) / 세션 검색·필터 / 페이지네이션 / 토큰 추정

## 사용자 흐름

1. 채팅 페이지의 `StatusBar` 도구 드롭다운(☰)에서 **"Sessions"** 클릭
2. 모달이 뜨고 같은 페르소나의 세션이 **마지막 활동 시간 내림차순**으로 나열됨
3. 각 항목에 메타정보 (제목·시간·용량·마지막 메시지·모델 뱃지)가 표시됨
4. 항목 클릭 → 해당 세션 채팅 페이지로 이동 → 기존 open 라우트가 `--resume`으로 컨텍스트 복원

## 아키텍처

### API 엔드포인트 (신규 1개)

`GET /api/personas/{slug}/sessions`
- 입력: 페르소나 slug
- 출력: 세션 메타 배열 (마지막 활동 시간 내림차순)
- 위치: `src/app/api/personas/[slug]/sessions/route.ts`

응답 스키마 (`SessionListItem[]`):
```ts
{
  id: string;                    // 폴더명 (e.g. "be_a_god-2026-04-21T19-18-59")
  title: string;                 // session.json.title
  createdAt: string;             // session.json.createdAt (ISO)
  lastActivityAt: number;        // 컨텍스트 파일 mtime (없으면 chat-history.json mtime → session.json mtime)
  contextSizeBytes: number | null;  // provider 컨텍스트 파일 크기, 없으면 null → "—"
  lastMessage: { role: "user" | "assistant"; preview: string } | null;
                                 // chat-history.json 마지막 메시지 1건 (60자 트림)
  model: string;                 // session.json.model
  provider: "claude" | "codex" | "gemini";
  isCurrent: boolean;            // 호출자가 같은 세션인지 (쿼리 ?currentId=... 로 받음)
}
```

### 백엔드 로직 (`src/lib/session-list.ts`, 신규 파일)

핵심 함수: `listSessionsForPersona(slug: string, currentId?: string): SessionListItem[]`

1. `data/sessions/` 디렉토리를 스캔, 각 폴더의 `session.json` 읽음
2. `session.json.persona === slug`인 것만 필터
3. 각 세션마다 `enrichSession()` 호출:
   - **provider 판별**: model prefix로 (`gpt-5|codex-mini|o3|o4` → codex, `gemini` → gemini, 그 외 → claude). `SessionCard.providerInfo` 로직과 동일.
   - **컨텍스트 파일 경로**:
     - Claude: `~/.claude/projects/{encodeCwd(absoluteSessionDir)}/{claudeSessionId}.jsonl`
       - encodeCwd: `C:\repo\foo bar\baz` → `C--repo-foo-bar-baz` (실제 Claude Code 인코딩 규칙은 코드에서 검증)
     - Codex: `~/.codex/sessions/**/rollout-*-{codexThreadId}.jsonl` — 날짜별 디렉토리라 glob/walk 필요. `session.createdAt` 날짜를 시작점으로 좁혀서 검색
     - Gemini: 위치 미지정 — 1차 구현에선 `null` 반환 (용량은 "—"로 표시), 차후 확장
   - **lastActivityAt**: 컨텍스트 파일 stat.mtime → 없으면 chat-history.json mtime → 없으면 session.json.createdAt
   - **contextSizeBytes**: 컨텍스트 파일 stat.size → 없으면 null
   - **lastMessage**: chat-history.json을 stream-parsing 하지 않고 통째 읽어 마지막 user/assistant 메시지를 찾고 60자 트림. 파일 없거나 비어있으면 null
4. `lastActivityAt` 내림차순 정렬해서 반환

성능 메모: 페르소나당 세션이 ~수십 개 수준이라 동기 fs 호출로 충분. 비동기 병렬화는 YAGNI.

### Claude cwd 인코딩 검증

`~/.claude/projects/` 폴더명 샘플(`C--repository-claude-bridge`, `C--repository-claude-bridge-data-personas---`)을 보면:
- `:` 제거 (또는 다음 문자와 합쳐 `--`로)
- 백슬래시 → `-`
- 공백 → `-`

세션 폴더 절대경로는 `C:\repository\claude bridge\data\sessions\be_a_god-2026-04-21T19-18-59`.
구현 시 1차로 `C--repository-claude-bridge-data-sessions-be_a_god-2026-04-21T19-18-59` 형태를 시도하고, 폴더가 없으면 한 단계씩 prefix를 시도(=`C--repository-claude-bridge` 같은 상위 폴더만 잡힐 수도 있음). 정확한 인코딩은 구현 단계에서 실제 폴더 한 번 확인해서 매칭.

### Frontend (`src/components/SessionListModal.tsx`, 신규 파일)

기존 `SessionCard` 디자인 토큰을 재사용 (그라디언트, provider 뱃지, relativeTime).

```tsx
interface SessionListModalProps {
  open: boolean;
  onClose: () => void;
  personaSlug: string;
  currentSessionId: string;
  onPick: (sessionId: string) => void;
}
```

- 마운트 시 `GET /api/personas/{slug}/sessions?currentId=...` fetch
- 로딩/에러/빈 상태 처리
- 각 항목 행:
  - 좌: 제목 (강조), 마지막 메시지 미리보기 (`{role}: {preview}`, 흐릿한 색)
  - 우: 마지막 활동 시간 (relative), 용량 (KB/MB), provider 뱃지
  - `isCurrent`인 항목은 비활성 + "현재 세션" 라벨
- 클릭: `onPick(id)` → 부모가 `router.push('/chat/' + id)`
- ESC / 바깥 클릭 / X 버튼으로 닫힘 (`SyncModal` 패턴 따라감)

### StatusBar 통합

- `chat/[sessionId]/page.tsx` 에 상태 추가: `const [sessionListOpen, setSessionListOpen] = useState(false)`
- `StatusBar`에 `onSessionList` prop 추가 → Debug/Tools 드롭다운 안에 "Sessions" 항목 (`hasDebugItems` 조건에 포함)
- 페르소나 슬러그는 `session.json`에서 읽어와야 함 — 이미 채팅 페이지가 어디선가 가져오고 있는지 확인 필요. 없다면 별도 GET으로 받기 (대부분의 다른 모달이 그런 식).

## 에러 / 엣지 케이스

- session.json 없는 폴더: 스킵
- chat-history.json 없음 / 비어 있음: lastMessage = null
- claudeSessionId 없는 옛날 세션: contextSizeBytes = null
- 컨텍스트 파일 mtime이 chat-history mtime보다 미래: 그대로 사용 (실제 LLM 마지막 응답 시점)
- 빈 결과: "세션이 없습니다" 안내 문구

## 보안

- 페르소나 slug 경로 traversal: `/` 또는 `..` 포함 거부
- session id 마찬가지: 라우팅 전에 `data/sessions/{id}` 폴더 존재 검증

## 테스트 계획

테스트 프레임워크가 없으므로 수동:
1. 같은 페르소나로 N개 세션 누적된 상태에서 메뉴 열기
2. 정렬 / 메타정보 일치 확인
3. 항목 클릭 → 라우팅 → resume 성공
4. 빈 페르소나 (세션 0개) 확인
5. 컨텍스트 파일 없는 옛 세션 확인 ("—" 표시)

## 변경 파일 요약

- 신규
  - `src/app/api/personas/[slug]/sessions/route.ts`
  - `src/lib/session-list.ts`
  - `src/components/SessionListModal.tsx`
- 수정
  - `src/components/StatusBar.tsx` — `onSessionList` prop, 드롭다운 항목 추가
  - `src/app/chat/[sessionId]/page.tsx` — 모달 마운트, 핸들러 wiring
- 문서
  - `docs/api-routes.md` — 새 엔드포인트 1줄 추가
