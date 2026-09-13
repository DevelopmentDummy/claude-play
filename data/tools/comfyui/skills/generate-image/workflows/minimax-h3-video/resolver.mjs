// minimax-h3-video resolver
// first_frame / last_frame 파라미터 유무에 따라 t2v / i2v / FLF2V(키프레임 보간)를 자동 분기한다.
//
// last_frame을 함께 주면 클립이 그 이미지로 수렴한다(FLF2V). 시작 프레임만 주고 15초를
// 방치하면 후반부가 드리프트하는데, 양 끝을 고정하면 그 표류가 구조적으로 줄고
// "어디로 끝날지"를 샷 단위로 지정할 수 있다. 체이닝 시 다음 세그먼트의 시작 프레임을
// 이번 세그먼트의 last_frame으로 주면 이음새도 함께 잡힌다.
export default function resolve(workflow, params, context) {
  const wf = context.defaultResolve(workflow, params, context);

  const pick = (v) => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);
  const ff = pick(params?.first_frame);
  const lf = pick(params?.last_frame);

  const w = wf["104"].inputs.width;
  const h = wf["104"].inputs.height;

  if (ff) {
    // i2v — LoadImage에 파일명을 넣고, ImageScale을 생성 해상도에 맞춘다
    wf["30"].inputs.image = ff;
    wf["31"].inputs.width = w;
    wf["31"].inputs.height = h;
    wf["104"].inputs.first_frame = ["31", 0];
  } else {
    // t2v — 시작 프레임 로더 계열 노드를 통째로 제거한다
    delete wf["104"].inputs.first_frame;
    delete wf["30"];
    delete wf["31"];
  }

  if (lf) {
    // FLF2V — 끝 프레임 고정. first_frame 없이 last_frame만 줘도 노드는 받아준다.
    wf["32"].inputs.image = lf;
    wf["33"].inputs.width = w;
    wf["33"].inputs.height = h;
    wf["104"].inputs.last_frame = ["33", 0];
  } else {
    delete wf["104"].inputs.last_frame;
    delete wf["32"];
    delete wf["33"];
  }

  

  // ── style_loras — H3 전용 LoRA 로더 체인 (선택) ──────────────────────────
  // ⚠️ generic LoraLoaderModelOnly를 쓰면 안 된다. pruned/양자화 베이스
  // (MiniMax_H3_FL2VA_pruned_nvfp4)에서는
  //   ① adaln_proj delta가 weight patch로 표현되지 않아 런타임 재주입이 필요하고
  //   ② int8-fused fc2 모듈이 bypass hook에 보이지 않아 조용히 누락된다.
  // MiniMaxH3TurboLoRA 노드가 이 둘을 처리한다(이름만 Turbo일 뿐 범용 H3 LoRA 로더).
  // payload 최상위 loras는 features.lora_injection=false라 무시된다 —
  // Illustrious용 baseLoras가 끌려 들어오는 걸 막으려고 그 경로는 닫아뒀다.
  const rawLoras = params?.style_loras ?? params?.loras;
  const entries = (Array.isArray(rawLoras) ? rawLoras : [])
    .map((e) => (typeof e === "string" ? { name: e, strength: 1.0 } : e))
    .filter((e) => e && typeof e.name === "string" && e.name.trim().length > 0)
    .map((e) => ({
      name: e.name.trim(),
      strength: typeof e.strength === "number" ? e.strength : 1.0,
      low_vram: e.low_vram === true,
    }))
    .filter((e) => e.strength !== 0);

  if (entries.length > 0) {
    // 이 패키지는 풀스텝(기본 25)이다. 터보 distill을 섞으면 스케줄이 어긋난다.
    const turbo = entries.filter((e) => /turbo/i.test(e.name));
    if (turbo.length > 0) {
      throw new Error(
        `[minimax-h3-video] 터보 distill LoRA는 이 패키지에 얹지 마라: ${turbo
          .map((t) => t.name)
          .join(", ")} — 전용 샘플러가 함께 필요하다. minimax-h3-video-turbo를 사용하라.`
      );
    }

    // 조용한 무시 방지 — 없는 파일이면 생성 자체를 실패시킨다.
    const available = context?.models?.loras;
    if (Array.isArray(available) && available.length > 0) {
      const missing = entries.filter((e) => !available.includes(e.name));
      if (missing.length > 0) {
        throw new Error(
          `[minimax-h3-video] 존재하지 않는 LoRA: ${missing.map((m) => m.name).join(", ")}`
        );
      }
    }

    let src = ["6", 0];
    let nextId = 300;
    for (const e of entries) {
      const nid = String(nextId++);
      wf[nid] = {
        class_type: "MiniMaxH3TurboLoRA",
        inputs: {
          model: src,
          lora_name: e.name,
          strength: e.strength,
          low_vram: e.low_vram,
        },
      };
      src = [nid, 0];
    }
    // UNETLoader(6)를 직접 물고 있던 두 소비처를 체인 끝으로 갈아끼운다.
    wf["9"].inputs.model = src;
    wf["16"].inputs.model = src;
  }

  return wf;
}
