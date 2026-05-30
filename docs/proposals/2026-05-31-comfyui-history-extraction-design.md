# comfyui-history.ts 추출 (Wave 9) 설계+플랜

> 거대 클래스 분해(⑥) 후속. ComfyUI **history/outputs 파싱** 순수 함수 3개를 prompt-그래프 수술과 분리해
> 신설 `src/lib/comfyui-history.ts`로 추출한다. behavior-preserving, 순수 verbatim move.

## 대상 (전부 pure, `this` 무의존 — understand 워크플로 확인)

| 함수 | 현재 위치 | 호출부 | 시그니처 |
|---|---|---|---|
| `extractAudioFilenames` | 977–998 | 1469 | `(historyEntry): string[]` |
| `extractOutputFilenames` | 1001–1028 | 1151 | `(historyEntry): string[]` |
| `extractTextOutputs` | 1535–1551 | 1611 | `(historyEntry): string[]` |

세 함수 모두 `historyEntry` 인자만 읽고 새 배열 반환, `this`/fs/network 없음. comfyui-graph.ts가 아닌
별도 모듈인 이유: **prompt-그래프 수술이 아니라 history-outputs 도메인**이라 단일 책임 분리.

## 설계

### 신설 `src/lib/comfyui-history.ts`
- 헤더 주석 1줄(`// ComfyUI history/outputs 파싱 순수 헬퍼. ComfyUIClient에서 추출(Wave 9). this/fs/network 무의존.`)
- 3개 함수를 현재 본문 그대로 `export function`으로 이동(`private X(`→`export function X(` 외 무변경).

### `src/lib/comfyui-client.ts`
- import 추가: `import { extractAudioFilenames, extractOutputFilenames, extractTextOutputs } from "./comfyui-history";`
- 3개 private 메서드 삭제.
- 호출부 3곳 `this.X(`→`X(`: 1469·1151·1611(메서드명 기준).

## 불변식
- 본문 한 글자도 변경 없음(순수 code-move). 반환 배열 형태/필터 로직 보존.

## 검증
1. `npm run build` — TS strict.
2. 전역 grep `this\.(extractAudioFilenames|extractOutputFilenames|extractTextOutputs)` → 0건.
3. 적대적 토큰대조: 본문 byte-동일, 호출부 인자 동일.
