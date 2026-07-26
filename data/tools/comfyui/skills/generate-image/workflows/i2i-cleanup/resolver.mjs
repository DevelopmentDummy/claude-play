export default function resolve(workflow, params, context) {
  const patched = context.defaultResolve(workflow, params, context);
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

  // seed
  let seed = num(params.seed, -1);
  if (seed < 0) seed = Math.floor(Math.random() * 1e15);
  if (patched["3"]?.inputs) patched["3"].inputs.seed = seed;

  // LoRA optional
  if (params.lora_name) {
    if (patched["10"]?.inputs) {
      patched["10"].inputs.lora_name = String(params.lora_name);
      const s = num(params.lora_strength, 0.8);
      patched["10"].inputs.strength_model = s;
      patched["10"].inputs.strength_clip = s;
    }
  } else {
    delete patched["10"];
    if (patched["3"]?.inputs) patched["3"].inputs.model = ["4", 0];
    if (patched["6"]?.inputs) patched["6"].inputs.clip = ["4", 1];
    if (patched["7"]?.inputs) patched["7"].inputs.clip = ["4", 1];
  }

  // ColorMatch reference optional
  if (params.reference_image) {
    if (patched["15"]?.inputs) patched["15"].inputs.image = String(params.reference_image);
  } else {
    delete patched["15"];
    delete patched["16"];
    if (patched["13"]?.inputs) patched["13"].inputs.image = ["8", 0];
  }

  return patched;
}
