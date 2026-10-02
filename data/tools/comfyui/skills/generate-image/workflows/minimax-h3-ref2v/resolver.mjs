// minimax-h3-ref2v resolver
//
// ref2va: 첫 프레임을 고정하는 i2v와 달리, 레퍼런스 이미지를 <Picture N> 태그로 제시하고
// 모델이 그 정체성/스타일만 가져다 새 장면을 그린다. 구도는 프롬프트가 결정한다.
//
// ⚠️ 레퍼런스는 ImageScale로 사전 리사이즈하지 않는다.
// 노드가 내부적으로 처리하기 때문이다:
//   - ref_image_size="match" → 생성 픽셀 면적에 맞춰 **축소만**, 종횡비 보존
//   - ref_image_size="max"   → 짧은변 2048px, 정체성 충실도 최상 (레퍼런스 토큰이 매 샘플링
//                              스텝을 타고 흐르므로 몇 배 느려질 수 있다)
// i2v 패키지처럼 crop:center로 미리 잘라 넣으면 레퍼런스의 위아래가 날아간다.
export default function resolve(workflow, params, context) {
  const wf = context.defaultResolve(workflow, params, context);

  const pick = (v) => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);

  // ref_images: 문자열 하나 또는 파일명 배열
  const raw = params?.ref_images ?? params?.ref_image;
  const list = (Array.isArray(raw) ? raw : [raw]).map(pick).filter(Boolean);

  if (list.length === 0) {
    throw new Error(
      "minimax-h3-ref2v에는 ref_images가 최소 1장 필요합니다. " +
      "(t2v가 필요하면 minimax-h3-video를 쓰세요)"
    );
  }

  // ⚠️ Autogrow 입력 키는 점(.)으로 이어붙인 경로다: "<입력 id>.<prefix><i>".
  // MiniMaxH3ReferenceToVideo는 Autogrow.Input(id="ref_images", prefix="ref_image_")이므로
  // API 프롬프트 키는 "ref_images.ref_image_0"이 된다. 인덱스는 0-based.
  // (프롬프트 본문에서 지목하는 <Picture N> 태그만 1-based다 — 헷갈리지 말 것.)
  // "ref_image_0"으로 평평하게 넣으면
  //   TypeError: execute() got an unexpected keyword argument 'ref_image_0'
  // 로 죽는다 (2026-08-27 실측).
  const refKey = (i) => `ref_images.ref_image_${i}`;

  // LoadImage 슬롯: 30 → ref_image_0, 32 → ref_image_1
  const slots = ["30", "32"];
  if (list.length > slots.length) {
    throw new Error(`이 패키지는 레퍼런스 이미지를 최대 ${slots.length}장까지 받습니다 (요청: ${list.length}장).`);
  }

  slots.forEach((nodeId, i) => {
    const key = refKey(i);
    if (i < list.length) {
      wf[nodeId].inputs.image = list[i];
      wf["104"].inputs[key] = [nodeId, 0];
    } else {
      delete wf["104"].inputs[key];
      delete wf[nodeId];
    }
  });

  // (2026-09-30) turbo=true → minimax-h3-video-turbo와 같은 전용 노드 2종을 ref2va UNET에 물린다.
  if (params?.turbo === true || params?.turbo === "true") {
    wf["200"] = {
      class_type: "MiniMaxH3TurboLoRA",
      inputs: {
        model: ["6", 0],
        lora_name: "minimax_h3_turbo_v4_step600_ema.safetensors",
        strength: typeof params?.turbo_strength === "number" ? params.turbo_strength : 1.0,
        low_vram: false,
      },
    };
    wf["17"] = { class_type: "MiniMaxH3TurboSampler", inputs: {} };
    wf["9"].inputs.model = ["200", 0];
    wf["16"].inputs.model = ["200", 0];
    if (params?.steps === undefined) wf["9"].inputs.steps = 8;
  }

  // (2026-09-30) minimax-h3-video의 style_loras 체인을 그대로 이식. 노드 id 6/9/16 구성이 동일하다.
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
        `[minimax-h3-ref2v] 터보 distill LoRA는 이 패키지에 얹지 마라: ${turbo
          .map((t) => t.name)
          .join(", ")} — 전용 샘플러가 함께 필요하다. ref2v용 터보는 지원하지 않는다.`
      );
    }

    // 조용한 무시 방지 — 없는 파일이면 생성 자체를 실패시킨다.
    const available = context?.models?.loras;
    if (Array.isArray(available) && available.length > 0) {
      const missing = entries.filter((e) => !available.includes(e.name));
      if (missing.length > 0) {
        throw new Error(
          `[minimax-h3-ref2v] 존재하지 않는 LoRA: ${missing.map((m) => m.name).join(", ")}`
        );
      }
    }

    let src = wf["200"] ? ["200", 0] : ["6", 0];
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
