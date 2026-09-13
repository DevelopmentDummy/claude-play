// minimax-h3-video-turbo resolver
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

  // Turbo LoRA 옵션
  if (typeof params?.turbo_strength === 'number' && wf['200']) wf['200'].inputs.strength = params.turbo_strength;
  if (typeof params?.turbo_low_vram === 'boolean' && wf['200']) wf['200'].inputs.low_vram = params.turbo_low_vram;

  

  // ── style_loras — 터보 LoRA(200) 뒤에 H3 전용 LoRA를 추가로 체인한다 ────────
  // MiniMaxH3TurboLoRA는 이름만 Turbo일 뿐 범용 H3 LoRA 로더다(MODEL→MODEL).
  // generic LoraLoaderModelOnly는 pruned 베이스에서 int8-fused fc2를 놓치므로 쓰지 않는다.
  // 터보 distill은 이미 node 200이 담당하므로 여기에 또 넣는 것은 거부한다.
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
    const turbo = entries.filter((e) => /turbo/i.test(e.name));
    if (turbo.length > 0) {
      throw new Error(
        `[minimax-h3-video-turbo] 터보 LoRA는 node 200이 이미 담당한다: ${turbo
          .map((t) => t.name)
          .join(", ")} — 교체하려면 workflow.json의 200.lora_name을 고쳐라.`
      );
    }

    const available = context?.models?.loras;
    if (Array.isArray(available) && available.length > 0) {
      const missing = entries.filter((e) => !available.includes(e.name));
      if (missing.length > 0) {
        throw new Error(
          `[minimax-h3-video-turbo] 존재하지 않는 LoRA: ${missing.map((m) => m.name).join(", ")}`
        );
      }
    }

    // 터보(200) 출력을 받아 그 위에 스타일을 얹는다.
    let src = ["200", 0];
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
    wf["9"].inputs.model = src;
    wf["16"].inputs.model = src;
  }

  return wf;
}
