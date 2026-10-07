export default function resolve(workflow, params, context) {
  const patched = context.defaultResolve(workflow, params, context);
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  const bool = (v, d) => (v === undefined || v === null ? d : Boolean(v));

  // seed (-1 random)
  let seed = num(params.seed, -1);
  if (seed < 0) seed = Math.floor(Math.random() * 1e15);
  if (patched["8"]?.inputs) patched["8"].inputs.seed = seed;

  // upscale on/off — sink rewire
  const upscale = bool(params.upscale, false);
  if (patched["10"]?.inputs) {
    if (upscale) {
      patched["10"].inputs.images = ["13", 0];
    } else {
      patched["10"].inputs.images = ["9", 0];
      delete patched["11"]; delete patched["12"]; delete patched["13"];
    }
  }
  // (2026-10-04) Z-Image LoRA 체인 — params.loras: [{name, strength}] 또는 문자열.
  // UNETLoader(1) → LoraLoaderModelOnly × N → ModelSamplingAuraFlow(7).
  // 최상위 loras는 features.lora_injection=false라 Illustrious baseLoras 오염 방지를 위해 닫아둠 — 반드시 params.loras로.
  const rawLoras = params?.loras;
  const loraEntries = (Array.isArray(rawLoras) ? rawLoras : [])
    .map((e) => (typeof e === "string" ? { name: e, strength: 1.0 } : e))
    .filter((e) => e && typeof e.name === "string" && e.name.trim().length > 0)
    .map((e) => ({ name: e.name.trim(), strength: typeof e.strength === "number" ? e.strength : 1.0 }))
    .filter((e) => e.strength !== 0);
  if (loraEntries.length > 0) {
    const available = context?.models?.loras;
    if (Array.isArray(available) && available.length > 0) {
      const missing = loraEntries.filter((e) => !available.includes(e.name));
      if (missing.length > 0) throw new Error(`[z-image] 존재하지 않는 LoRA: ${missing.map((m) => m.name).join(", ")}`);
    }
    let src = ["1", 0];
    let nextId = 100;
    for (const e of loraEntries) {
      const nid = String(nextId++);
      patched[nid] = { class_type: "LoraLoaderModelOnly", inputs: { model: src, lora_name: e.name, strength_model: e.strength } };
      src = [nid, 0];
    }
    if (patched["7"]?.inputs) patched["7"].inputs.model = src;
  }

  return patched;
}
