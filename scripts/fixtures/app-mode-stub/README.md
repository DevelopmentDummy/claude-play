# 앱 모드 스텁 월드 (검증용 픽스처)

플랫폼의 앱 모드 계약이 실제로 도는지 확인하기 위한 **최소 월드**다. 게임이 아니라 계약의 참조 구현이다.
설계: [docs/specs/2026-09-12-app-mode-platform-design.md](../../../docs/specs/2026-09-12-app-mode-platform-design.md)

## 무엇이 들어 있나

| 파일 | 역할 |
|---|---|
| `layout.json` | `app` 블록 + `chat.mode: "dock"` — 앱이 메인, 챗은 하단 독 |
| `tools/world.js` | 월드 엔진. `observe`/`submit`/`step`/`snapshot` 4액션. 의도 큐가 **키 있는 객체**인 참조 구현 |
| `subagents.json` | 역할 2개(`keeper`, `gatherer`) × 스레드 3개 — 같은 역할에서 스레드 2개가 뜨는 것을 검증 |
| `roles/*.md` | 역할 지침. 같은 역할의 스레드들이 공유하고, 정체성은 `params`가 준다 |
| `app/index.html` | 앱 슬롯. **1회 마운트 카운터**가 재마운트 여부를 눈으로 확인시켜 준다 |
| `world.json` | 월드 초기 상태 |

## 설치

이 디렉토리의 내용을 **새 페르소나** 디렉토리에 복사한다 (기존 페르소나를 건드리지 말 것):

```bash
cp -r scripts/fixtures/app-mode-stub/* "data/personas/<새-페르소나>/"
```

그런 다음 로비에서 그 페르소나로 세션을 만들고 Open 한다.

## 스모크 체크리스트

- [ ] **월드 시계가 AI와 무관하게 돈다** — StatusBar에서 일시정지하지 않은 채로 스레드를 전부 바쁘게
  두거나(또는 `subagents.json`의 `threads`를 비우고 열어) `world.json`의 `tick`이 계속 오르는지 확인.
  20틱마다 밀이 하나 자라는 것도 AI 없이 관찰돼야 한다
- [ ] 스레드 3개가 뜨고 각자 주기로 턴을 돈다 (`threads:status`의 스레드 수 = 3)
- [ ] 의도가 적용되어 `world.json`의 `wheat`이 줄고 `actors[*].held`가 는다
- [ ] 같은 틱 경합 시 양쪽 모두 기각되고 사유가 다음 관측의 `[직전 결과]`에 실린다
- [ ] 앱 HUD의 "갱신 N회 · 1회 마운트" 문구에서 **마운트 시각이 바뀌지 않는다** (재마운트 없음)
- [ ] StatusBar 일시정지를 누르면 `tick`이 멈추고 재개하면 다시 오른다
- [ ] 브라우저 탭을 닫으면 루프가 멈춘다 (`tick`이 더 안 오름)
- [ ] `resetEveryTurns: 10` 도달 후에도 스레드가 자기 `entityId`로 계속 행동한다
- [ ] 세션을 닫았다 다시 Open해도 `threads.json`의 스레드가 복원된다
- [ ] 앱 콘솔에서 `__panelBridge.updateData("world", {...})` 를 시도하면 403이 난다
- [ ] 바쁜 스레드를 despawn해도 `data/.runtime/subagent-procs.json`에 고아 PID가 남지 않는다
- [ ] **기존 페르소나 세션이 무영향이다** — 채팅·패널·모달이 평소대로
