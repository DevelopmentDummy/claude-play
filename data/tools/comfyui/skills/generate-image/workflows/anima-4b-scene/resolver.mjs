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
  };

  const clean = (value) => String(value ?? "").trim();
  const joinPrompt = (...parts) => parts.map(clean).filter(Boolean).join(", ");

  const requestedProfile = clean(params.model_profile || "auto").toLowerCase();
  const diffusionModel = clean(params.diffusion_model || patched?.["1"]?.inputs?.unet_name).toLowerCase();

  let activeProfileKey = "official_preview3";
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
    throw new Error("anima-4b-scene expects nodes 4, 5, 7, 8 to exist");
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
