# GPT 이미지 백엔드 수확 실패 — 핸드오버

**작성:** 2026-08-01 (d:\SimpleGame 세션에서 규명, 수정은 이 저장소에 미커밋 상태로 적용됨)

> **2026-08-17 후속:** 커밋 완료(`5e19184`) + 재빌드/재기동 완료. 아래 "남은 일"은
> 모두 처리됐다. 최종 필터는 프리픽스 열거를 버리고 `/\.png$/i`로 완화됐다
> (0.144.6의 `exec-<uuid>.png`까지 커버). 라이브 생성 검증은 미실행.

**한 줄 요약:** `generate_image_openai`은 고장난 적이 없다. Codex가 그림을 정상 생성하는데
브릿지가 **산출물 파일명 필터가 낡아서** 그 파일을 못 찾고 버리고 있었다. 소스 수정은
이미 적용해 뒀고, **남은 일은 재빌드 + 재시작뿐이다.**

---

## 1. 증상

```
generate_image_openai → "Codex produced no image (no new ig_*.png / call_*.png found after grace window)"
또는 MCP 호출 자체가 타임아웃
```

파일 크기·품질·프롬프트와 무관하게 재현. 오랫동안 "GPT 백엔드는 죽었다, ComfyUI를 쓰라"로
취급돼 왔다(호출자 쪽 메모에도 그렇게 기록돼 있었다).

## 2. 진짜 원인

`src/lib/codex-image.ts`는 `codex exec`를 띄우기 전 `$CODEX_HOME/generated_images/`를
스냅샷하고, 끝난 뒤 **새로 생긴 파일**을 수확한다. 그 "새 파일" 판정에 이름 필터가 걸려 있다:

```ts
const IG_OUTPUT_RE = /^(?:ig_|call_).+\.png$/i;
```

그런데 codex-cli는 산출물 파일명을 계속 바꿔 왔다:

| codex-cli | 파일명 |
|---|---|
| 구버전 | `ig_<id>.png` |
| 0.144.0 언저리 | `call_<toolCallId>.png` |
| **0.144.6 (현재 설치본)** | **`exec-<uuid>.png`** |

`exec-`가 필터에 없어 매칭이 0건 → "produced no image". **그림은 그동안 계속 생성되고 있었다.**

증거 (2026-08-01 실측):

```
$ ls -1t ~/.codex/generated_images/*/*.png | head -3
019fbc62-.../exec-5292f5db-ccc8-4ac5-b772-f53982b65932.png   2026-08-01 17:14:15
019fba34-.../exec-06bca824-f679-4df8-952d-6cea1f969770.png   2026-08-01 07:04:41
019fba33-.../exec-347dd774-256a-49ae-8d91-60ddb6e9ac0e.png   2026-08-01 07:03:30
```

07:00~07:04 파일들은 "실패"로 보고된 그날 아침 호출들의 산출물이고, 17:14 파일은
이번 조사 중 호출한 것이다 — 셋 다 정상적인 이미지였다.

## 3. 이미 적용해 둔 수정 (미커밋)

`src/lib/codex-image.ts` 한 곳. 접두사를 열거하는 방식을 버리고 `.png` 전체를 받는다.

```diff
-const IG_OUTPUT_RE = /^(?:ig_|call_).+\.png$/i;
+const IG_OUTPUT_RE = /\.png$/i;
```

에러 메시지도 낡은 접두사를 부르지 않도록 실제 탐색 경로를 찍게 바꿨다.

**왜 안전한가:** 수확 로직은 이미 "spawn 전 스냅샷에 없던 파일"만 남긴다(`before` Set 차집합).
게다가 `generated_images/<대화id>/` 아래에는 image_gen 산출물 외의 것이 들어오지 않는다.
필터를 넓혀도 남의 파일을 집어올 경로가 없다 — 원래 주석도 같은 논리를 이미 적고 있었다.
이렇게 해 두면 codex가 **다음에 또 이름을 바꿔도** 조용히 깨지지 않는다.

## 4. 왜 아직 안 먹히는가 — 재빌드가 필요하다

MCP 도구는 라이브러리를 직접 부르지 않고 **Next API 라우트를 HTTP로 경유**한다:

```
MCP generate_image_openai
  └─ src/lib/external-mcp/registry.ts:141  bridgeFetch("POST", "/api/tools/openai/generate")
       └─ src/app/api/tools/openai/generate/route.ts → CodexImageClient (src/lib/codex-image.ts)
```

현재 브릿지는 **production 모드**로 떠 있다 — `npm run start`(`NODE_ENV=production tsx server.ts`),
포트 3340. 이 모드에서 API 라우트는 `.next` **빌드 산출물**로 서빙되고, 그 빌드는
`2026-07-29`자라 낡은 필터를 그대로 품고 있다.

확인 방법:

```bash
grep -c "ig_\|call_" .next/server/app/api/tools/openai/generate/route.js   # 1 = 낡은 빌드
stat -c '%y' .next/server/app/api/tools/openai/generate/route.js
curl -s http://127.0.0.1:3340/ | grep -c "react-refresh"                   # 0 = production
```

## 5. 남은 작업

- [x] `npm run typecheck` — 2026-08-01 통과 확인함 (정규식 한 줄이라 타입 영향 없음)
- [ ] `npm run build`
- [ ] 브릿지 재시작 (production 유지 시 `npm run start`. `npm run dev`로 띄우면 이후엔
      소스 수정이 즉시 반영되므로 같은 함정을 다시 밟지 않는다)
- [ ] 스모크: 아래 §6 검증
- [ ] 커밋 (`fix(codex-image): 수확 필터를 접두사 열거에서 .png 전체로` 정도)

> 재시작은 이 서버에 붙어 있는 다른 세션·MCP 클라이언트를 끊는다. 조용한 시간대에.

## 6. 검증 절차

```
generate_image_openai {
  outputDir: "<절대경로>",
  filename: "harvest_smoke.png",
  prompt: "a single red apple on a plain white background",
  size: "1024x1024"
}
```

- **성공 판정:** `outputDir/harvest_smoke.png`가 실제로 생기고 응답에 절대경로가 온다.
- **실패 시 1차 확인:** `ls -1t ~/.codex/generated_images/*/*.png | head -1`
  - 방금 시각의 파일이 **있다** → 생성은 됐고 수확/전달 단계 문제 (빌드가 안 바뀌었는지부터)
  - **없다** → 이번엔 진짜 codex 쪽 문제 (인증·레이트리밋·프롬프트 거절)

## 7. 같이 봐야 할 별건 — 동기 호출과 타임아웃

`codex exec` 한 턴은 **2분 이상** 걸린다(`CODEX_TIMEOUT_MS = 420_000`). 반면 MCP 클라이언트
쪽 타임아웃은 그보다 훨씬 짧다 — 이번 조사에서도 도구 호출은 타임아웃했는데 그림은
그 뒤에 정상 저장됐다. 즉 **필터를 고쳐도 호출자는 여전히 경로를 못 받을 수 있다.**

지금 당장의 우회는 "타임아웃 나면 `~/.codex/generated_images/`를 최신순으로 뒤져 직접
가져오기"다(이번 작업도 그렇게 했다). 제대로 고치려면 이 도구를 동기 대신
**작업 큐 + 폴링**(`job_id` 반환 → `check` 도구)으로 바꾸는 게 맞다. 도구 설명이
"Synchronous — waits for completion"이라고 약속하고 있으니 스펙 변경이라 별도 판단이 필요하다.

## 8. 참고

- 수정 파일: `src/lib/codex-image.ts`
- 호출 경로: `src/lib/external-mcp/registry.ts:139-150`, `src/app/api/tools/openai/generate/route.ts`
- 산출물 루트: `$CODEX_HOME/generated_images/<conversationId>/` (기본 `~/.codex`)
- 설치 버전: `codex-cli 0.144.6`
- 이 수정으로 되살아난 실사용 사례: d:\SimpleGame 챕터4 참격 VFX 크로마키 시트 생성
  (크로마 그린 배경 + "한 줄에 3개, 서로 떨어뜨려" 지시를 정확히 지켰다)
