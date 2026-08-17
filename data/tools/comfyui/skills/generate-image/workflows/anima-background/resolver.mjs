export default function resolve(workflow, params, context) {
  const patched = context.defaultResolve(workflow, params, context);

  const profiles = {
    official_preview3: {
      matches: ["anima-preview3-base.safetensors"],
      qualityMap: {
        plain: "best quality",
        standard: "masterpiece, best quality, amazing quality",
        polished: "masterpiece, best quality, amazing quality, very aesthetic, absurdres, high detail",
      },
      sampler: "euler_ancestral",
      scheduler: "simple",
      cfgByPreset: { plain: 3.6, standard: 4.0, polished: 4.1 },
      shiftByPreset: { plain: 2.8, standard: 3.0, polished: 3.1 },
      stepsByPreset: { plain: 28, standard: 36, polished: 40 },
      extraMeta: "",
      systemPrefix:
        "You are an assistant designed to generate superior images with the superior degree of image-text alignment based on textual prompts or user prompts. <Prompt Start> ",
    },
    cat_tower: {
      matches: ["animacattower_v05.safetensors", "animaCatTower_v05.safetensors"],
      qualityMap: {
        plain: "best quality",
        standard: "masterpiece, best quality, amazing quality, aesthetic",
        polished: "masterpiece, best quality, amazing quality, very aesthetic, high detail, refined shading",
      },
      sampler: "euler_ancestral",
      scheduler: "simple",
      cfgByPreset: { plain: 3.4, standard: 3.8, polished: 3.9 },
      shiftByPreset: { plain: 2.9, standard: 3.0, polished: 3.2 },
      stepsByPreset: { plain: 28, standard: 36, polished: 40 },
      extraMeta: "cat tower model aesthetic, polished anime rendering",
      systemPrefix:
        "You are an illustrator composing a polished anime image with elegant shading, clean structure, and strong visual appeal. <Prompt Start> ",
    },
    pornmaster: {
      matches: ["pornmasteranima", "pornmaster"],
      qualityMap: {
        plain: "best quality",
        standard: "masterpiece, best quality, amazing quality",
        polished: "masterpiece, best quality, amazing quality, very aesthetic, absurdres, high detail",
      },
      sampler: "er_sde",
      scheduler: "simple",
      cfgByPreset: { plain: 3.6, standard: 4.0, polished: 4.1 },
      shiftByPreset: { plain: 2.8, standard: 3.0, polished: 3.1 },
      stepsByPreset: { plain: 28, standard: 36, polished: 40 },
      extraMeta: "",
      systemPrefix:
        "You are an assistant designed to generate superior images with the superior degree of image-text alignment based on textual prompts or user prompts. <Prompt Start> ",
    },
    wai_anima: {
      matches: ["waianima_v10.safetensors", "waiANIMA_v10.safetensors", "waianima"],
      qualityMap: {
        plain: "best quality",
        standard: "masterpiece, best quality, amazing quality",
        polished: "masterpiece, best quality, amazing quality, very aesthetic, absurdres, high detail",
      },
      sampler: "euler_ancestral",
      scheduler: "simple",
      cfgByPreset: { plain: 3.4, standard: 3.8, polished: 4.0 },
      shiftByPreset: { plain: 2.8, standard: 3.0, polished: 3.1 },
      stepsByPreset: { plain: 28, standard: 36, polished: 40 },
      extraMeta: "",
      systemPrefix:
        "You are an illustrator composing a polished anime image with elegant shading, clean structure, and strong visual appeal. <Prompt Start> ",
    },
    animaika: {
      matches: ["animaika_v30.safetensors", "animaika_v3", "animaika"],
      qualityMap: {
        plain: "best quality",
        standard: "masterpiece, best quality, amazing quality",
        polished: "masterpiece, best quality, amazing quality, very aesthetic, absurdres, high detail",
      },
      sampler: "er_sde",
      scheduler: "simple",
      cfgByPreset: { plain: 3.0, standard: 3.8, polished: 4.2 },
      shiftByPreset: { plain: 2.8, standard: 3.0, polished: 3.1 },
      stepsByPreset: { plain: 25, standard: 30, polished: 35 },
      extraMeta: "",
      defaultNegative: "worst quality, bad quality, bad anatomy",
      systemPrefix:
        "You are an assistant designed to generate superior images with the superior degree of image-text alignment based on textual prompts or user prompts. <Prompt Start> ",
    },
    anima_29b: {
      // Anima-2.9B preview v1 — transformer 28층 → 40층 확장판.
      // 코어 네이티브 지원(comfy/ldm/anima/model.py + text_encoders/anima.py) 경로를 쓴다.
      // ⚠️ anima-4b-scene(LoadQwen35AnimaCLIP + qwen35_4b) 조합은 회색 단색만 나온다 —
      //    4B 인코더 alignment가 확장 레이어의 cross-attn과 맞지 않는다. 반드시 이 패키지를 쓸 것.
      // 2026-08-15 A/B (seed 880126, 1152x1536, 50step, cfg 3.5, 동일 프롬프트):
      //   euler + sgm_uniform      → 부드럽지만 선이 뭉개지고 배경이 흐릿하게 뭉침
      //   res_multistep + linear_quadratic → 선이 또렷, 창밖 도시 실루엣까지 형태가 살아남 ✅ 채택
      // 고노이즈 구간에 스텝을 더 쓰는 linear_quadratic이 구도·디테일 양쪽에서 이겼다(작가 주장과 일치).
      // ⚠️ 이 모델은 **아티스트 태그 유무로 품질이 갈린다**. @작가명을 2~4개 앞쪽에 넣을 것.
      // ⚠️ 832x1216은 눈에 띄게 밋밋하다. 1152x1536 이상 네이티브로 뽑아라.
      matches: ["anima29b_v10.safetensors", "anima29b"],
      qualityMap: {
        plain: "best quality, highres",
        standard: "masterpiece, best quality, amazing quality, highres, absurdres",
        polished: "masterpiece, best quality, amazing quality, very aesthetic, highres, absurdres, high detail",
      },
      sampler: "res_multistep",
      scheduler: "linear_quadratic",
      cfgByPreset: { plain: 4.0, standard: 3.8, polished: 3.5 },
      shiftByPreset: { plain: 2.8, standard: 3.0, polished: 3.1 },
      stepsByPreset: { plain: 28, standard: 36, polished: 50 },
      extraMeta: "",
      systemPrefix:
        "You are an assistant designed to generate superior images with the superior degree of image-text alignment based on textual prompts or user prompts. <Prompt Start> ",
    },
    tekito_29b: {
      // Tekito-2.9 preview-v1 — tekitoMix 화풍을 Anima-2.9B(40블록) 베이스로 옮긴 판.
      // 2.9B 계열이므로 res_multistep + linear_quadratic 채택(2026-08-15 A/B 근거).
      // ⚠️ custom_nodes/ComfyUI-Anima-2.9B 없으면 회색 단색만 나온다.
      matches: ["tekito29_previewv1.safetensors", "tekito29"],
      qualityMap: {
        plain: "best quality, highres",
        standard: "masterpiece, best quality, amazing quality, highres, absurdres",
        polished: "masterpiece, best quality, amazing quality, very aesthetic, highres, absurdres, high detail",
      },
      sampler: "res_multistep",
      scheduler: "linear_quadratic",
      cfgByPreset: { plain: 4.0, standard: 3.8, polished: 3.5 },
      shiftByPreset: { plain: 2.8, standard: 3.0, polished: 3.1 },
      stepsByPreset: { plain: 28, standard: 36, polished: 50 },
      extraMeta: "",
      systemPrefix:
        "You are an assistant designed to generate superior images with the superior degree of image-text alignment based on textual prompts or user prompts. <Prompt Start> ",
    },
    wondermix: {
      // The A WonderMix V1 — Anima Turbo 베이스.
      // 2026-08-03 A/B 검증: steps 12 / cfg 1.0(작가 권장) vs steps 36 / cfg 3.8(구 기본).
      // 육안 품질차 미미, 픽셀 차이도 얼굴/배경에 균등 분산 = 디테일 증가가 아닌 구도 미세 이동.
      // 3배 빠른 12스텝을 기본으로 확정.
      // ⚠️ cfg 1.0 구간에서는 negative prompt가 사실상 무효다. 네거티브로 뭘 빼야 하면 cfg를 올려라.
      matches: ["theawondermix_v1.safetensors", "theawondermix", "wondermix"],
      qualityMap: {
        plain: "best quality",
        standard: "masterpiece, best quality, amazing quality, aesthetic",
        polished: "masterpiece, best quality, amazing quality, very aesthetic, absurdres, high detail",
      },
      sampler: "euler_ancestral",
      scheduler: "normal",
      cfgByPreset: { plain: 1.0, standard: 1.0, polished: 1.2 },
      shiftByPreset: { plain: 2.9, standard: 3.0, polished: 3.1 },
      stepsByPreset: { plain: 8, standard: 12, polished: 16 },
      extraMeta: "clean vivid colors, round soft face",
      systemPrefix:
        "You are an illustrator composing a polished anime image with elegant shading, clean structure, and strong visual appeal. <Prompt Start> ",
    },
  };

  const clean = (value) => String(value ?? "").trim();
  const joinPrompt = (...parts) => parts.map(clean).filter(Boolean).join(", ");

  const requestedProfile = clean(params.model_profile || "auto").toLowerCase();
  const diffusionModel = clean(params.diffusion_model || patched?.["1"]?.inputs?.unet_name).toLowerCase();

  let activeProfileKey = "cat_tower";
  if (requestedProfile !== "auto" && profiles[requestedProfile]) {
    activeProfileKey = requestedProfile;
  } else {
    for (const [key, profile] of Object.entries(profiles)) {
      if (profile.matches.some((name) => diffusionModel.includes(name.toLowerCase()))) {
        activeProfileKey = key;
        break;
      }
    }
  }

  const profile = profiles[activeProfileKey];
  const qualityPreset = clean(params.quality_preset || "standard").toLowerCase();
  const safePreset = profile.qualityMap[qualityPreset] ? qualityPreset : "standard";

  const meta = clean(params.meta_tags);
  const subject = clean(params.subject_tags);
  const scene = clean(params.scene_prompt);
  const systemPrefix = clean(params.system_prefix) || profile.systemPrefix;
  const quality = profile.qualityMap[safePreset] || profile.qualityMap.standard;
  const profileMeta = clean(profile.extraMeta);

  const positiveCore = joinPrompt(quality, profileMeta, meta, subject);
  const positive = [positiveCore, scene].filter(Boolean).join(". ");
  const finalPositive = `${systemPrefix}${positive}`.trim();

  const defaultNegative = profile.defaultNegative ||
    "worst quality, low quality, score_1, score_2, score_3, blurry, jpeg artifacts, bad anatomy, bad hands, extra fingers, fused fingers, watermark, signature, text";
  const finalNegative = clean(params.negative_prompt) || defaultNegative;

  if (!patched["4"]?.inputs || !patched["5"]?.inputs || !patched["7"]?.inputs || !patched["8"]?.inputs) {
    throw new Error("anima-mixed-scene expects nodes 4, 5, 7, 8 to exist");
  }

  patched["4"].inputs.text = finalPositive;
  patched["5"].inputs.text = finalNegative;

  const width = Number(params.width ?? patched["6"]?.inputs?.width ?? 1024);
  const height = Number(params.height ?? patched["6"]?.inputs?.height ?? 1024);
  const megapixels = (width * height) / 1000000;

  patched["8"].inputs.sampler_name = clean(params.sampler_name) || profile.sampler;
  patched["8"].inputs.scheduler = clean(params.scheduler) || profile.scheduler;

  if (params.cfg === undefined || params.cfg === null) {
    patched["8"].inputs.cfg = profile.cfgByPreset[safePreset] ?? profile.cfgByPreset.standard;
  }

  if (params.steps === undefined || params.steps === null) {
    const profileSteps = profile.stepsByPreset?.[safePreset];
    if (profileSteps) {
      patched["8"].inputs.steps = profileSteps;
    }
  }

  if (params.quality_preset === "plain") {
    patched["7"].inputs.shift = profile.shiftByPreset.plain;
  } else if (params.quality_preset === "polished") {
    const baseShift = profile.shiftByPreset.polished;
    patched["7"].inputs.shift = megapixels > 1.05 ? baseShift + 0.1 : baseShift;
  } else {
    patched["7"].inputs.shift = profile.shiftByPreset.standard;
  }

  return patched;
}
