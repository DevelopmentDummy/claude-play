/**
 * 앱 모드 검증용 최소 월드 엔진 (플랫폼 계약의 참조 구현).
 *
 * 규칙 하나: 자원 "밀"을 집는다. 같은 틱에 둘 이상이 노리면 전원 기각(경합).
 * 상태는 전부 world.json — 엔진은 메모리 상태를 가질 수 없다 (tool 라우트가 매 호출
 * require.cache를 purge한다).
 *
 * 의도 큐가 배열이 아니라 **키 있는 객체**인 것이 핵심이다: applyPatch/deepMerge는
 * 배열을 교체하므로, 배열로 두면 동시 submit 두 건이 각각 옛 스냅샷을 읽고 자기 것만
 * 덧붙인 전체 배열을 반환해 나중 것이 먼저 것을 지운다.
 */
module.exports = async function world(ctx, args) {
  const w = (ctx.data && ctx.data.world) || {};
  const state = {
    tick: w.tick || 0,
    wheat: typeof w.wheat === "number" ? w.wheat : 5,
    actors: w.actors || {},
    intents: w.intents || {},
    feedback: w.feedback || {},
  };

  switch (args.action) {
    case "observe": {
      const id = String(args.observerId || "");
      const me = state.actors[id] || { held: 0, memory: "" };
      const fb = state.feedback[id];
      const lines = [
        `[월드] tick=${state.tick} 남은 밀=${state.wheat}`,
        `[나] id=${id} 보유=${me.held} 기억=${me.memory || "(없음)"}`,
        fb ? `[직전 결과] ${fb}` : "",
        id === "main"
          ? ""
          : `밀을 집으려면 run_tool("world", { action: "submit", observerId: "${id}", intent: { type: "take_wheat", memory: "<한 줄 기억>" } }) 를 한 번만 호출하고 짧게 한 줄로 답하라.`,
      ].filter(Boolean);
      return { result: { text: lines.join("\n") } };
    }

    case "submit": {
      const id = String(args.observerId || "");
      if (!id) return { result: { ok: false, error: "observerId 누락" } };
      // 키는 dot을 포함하면 안 된다 — $unset dot-path 드레인과 충돌한다.
      const seq = state.tick * 1000 + Object.keys(state.intents).length;
      const key = `${id}__${seq}`;
      return {
        data: {
          world: {
            $merge: "deep",
            intents: { [key]: { seq, at: Date.now(), observerId: id, intent: args.intent } },
          },
        },
        result: { ok: true, key },
      };
    }

    case "step": {
      const entries = Object.entries(state.intents)
        .filter(([, v]) => v && typeof v === "object")
        .sort((a, b) => (a[1].seq || 0) - (b[1].seq || 0));
      const feedback = {};
      const actors = { ...state.actors };
      let wheat = state.wheat;

      const takers = entries.filter(([, v]) => v.intent && v.intent.type === "take_wheat");
      if (takers.length > 1) {
        // 같은 배치의 경합 — 배치 드레인이라야 가능한 판정이다.
        for (const [, v] of takers) feedback[v.observerId] = "기각: 같은 틱에 경합이 발생했다.";
      } else {
        for (const [, v] of takers) {
          if (wheat <= 0) { feedback[v.observerId] = "기각: 밀이 없다."; continue; }
          wheat -= 1;
          const prev = actors[v.observerId] || { held: 0, memory: "" };
          actors[v.observerId] = { ...prev, held: prev.held + 1 };
          feedback[v.observerId] = "성공: 밀 1개를 집었다.";
        }
      }

      // 스레드가 실어 보낸 기억은 월드에 저장한다 — 컨텍스트 리셋 후 재prime의 재료다.
      for (const [, v] of entries) {
        if (v.intent && v.intent.memory) {
          const prev = actors[v.observerId] || { held: 0, memory: "" };
          actors[v.observerId] = { ...prev, memory: String(v.intent.memory).slice(0, 200) };
        }
      }

      return {
        data: {
          world: {
            $merge: "deep",
            $unset: entries.map(([k]) => `intents.${k}`),
            tick: state.tick + 1,
            wheat,
            actors,
            feedback,
          },
        },
        result: { note: `tick ${state.tick} → ${state.tick + 1}, 밀 ${state.wheat} → ${wheat}, 의도 ${entries.length}건` },
      };
    }

    case "snapshot":
      return { result: { tick: state.tick, wheat: state.wheat, actors: state.actors } };

    default:
      return { result: { error: `알 수 없는 action: ${args.action}` } };
  }
};
