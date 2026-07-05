export default function resolve(workflow, params, context) {
  const patched = context.defaultResolve(workflow, params, context);
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  const bool = (v, d) => (v === undefined || v === null ? d : Boolean(v));

  if (patched["1"]?.inputs && params.checkpoint) patched["1"].inputs.ckpt_name = params.checkpoint;

  if (patched["2"]?.inputs) {
    if (params.lora_name) patched["2"].inputs.lora_name = params.lora_name;
    const ls = num(params.lora_strength, 0.8);
    patched["2"].inputs.strength_model = ls;
    patched["2"].inputs.strength_clip = ls;
  }

  if (patched["5"]?.inputs && params.ip_preset) patched["5"].inputs.preset = params.ip_preset;

  if (patched["6"]?.inputs) {
    patched["6"].inputs.weight = num(params.ip_weight, 0.75);
    if (params.ip_weight_type) patched["6"].inputs.weight_type = params.ip_weight_type;
    if (params.ip_combine) patched["6"].inputs.combine_embeds = params.ip_combine;
  }

  const refNodes = ["20", "21", "22", "23", "24", "25"];
  const batchNodes = ["40", "41", "42", "43", "44"];
  let refs = Array.isArray(params.references) ? params.references.filter(Boolean) : null;
  if (refs && refs.length) {
    refs = refs.slice(0, 6);
    refs.forEach((fn, i) => { if (patched[refNodes[i]]?.inputs) patched[refNodes[i]].inputs.image = fn; });
    for (let i = refs.length; i < 6; i++) delete patched[refNodes[i]];
    batchNodes.forEach(id => delete patched[id]);
    let imgLink = [refNodes[0], 0];
    if (refs.length > 1) {
      let prev = [refNodes[0], 0];
      for (let i = 1; i < refs.length; i++) {
        const bid = batchNodes[i - 1];
        patched[bid] = { class_type: "ImageBatch", inputs: { image1: prev, image2: [refNodes[i], 0] }, _meta: { title: "batch" } };
        prev = [bid, 0];
      }
      imgLink = prev;
    }
    if (patched["6"]?.inputs) patched["6"].inputs.image = imgLink;
  }

  let seed = num(params.seed, -1);
  if (seed < 0) seed = Math.floor(Math.random() * 1e15);
  if (patched["8"]?.inputs) patched["8"].inputs.seed = seed;

  const upscale = bool(params.upscale, false);
  if (patched["10"]?.inputs) {
    if (upscale) {
      patched["10"].inputs.images = ["13", 0];
    } else {
      patched["10"].inputs.images = ["9", 0];
      delete patched["11"]; delete patched["12"]; delete patched["13"];
    }
  }
  return patched;
}