export default function resolve(workflow, params, context) {
  const patched = context.defaultResolve(workflow, params, context);

  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  const bool = (v, d) => (v === undefined || v === null ? d : Boolean(v));

  // seed — 두 스테이지 동일, -1이면 랜덤
  let seed = num(params.seed, -1);
  if (seed < 0) seed = Math.floor(Math.random() * 1e15);
  if (patched["11"]?.inputs) patched["11"].inputs.noise_seed = seed;
  if (patched["12"]?.inputs) patched["12"].inputs.noise_seed = seed;

  // steps + high/low 분할
  const steps = Math.max(2, num(params.steps, 6));
  const half = Math.max(1, Math.floor(steps / 2));
  if (patched["11"]?.inputs) { patched["11"].inputs.steps = steps; patched["11"].inputs.end_at_step = half; }
  if (patched["12"]?.inputs) { patched["12"].inputs.steps = steps; patched["12"].inputs.start_at_step = half; }

  // cfg
  const cfg = num(params.cfg, 1);
  if (patched["11"]?.inputs) patched["11"].inputs.cfg = cfg;
  if (patched["12"]?.inputs) patched["12"].inputs.cfg = cfg;

  // end_image — 임의 끝 프레임(FLF2V 키프레임 체이닝). loop보다 우선.
  const loop = bool(params.loop, false);
  if (params.end_image) {
    if (patched["18"]?.inputs) patched["18"].inputs.image = String(params.end_image);
    if (patched["10"]?.inputs) patched["10"].inputs.end_image = ["18", 0];
  } else {
    delete patched["18"];
    if (patched["10"]?.inputs) {
      if (loop) patched["10"].inputs.end_image = ["8", 0];
      else delete patched["10"].inputs.end_image;
    }
  }

  // upscale on/off — sink rewire
  const upscale = bool(params.upscale, true);
  if (patched["14"]?.inputs) {
    if (upscale) {
      patched["14"].inputs.images = ["17", 0];
    } else {
      patched["14"].inputs.images = ["13", 0];
      delete patched["15"]; delete patched["16"]; delete patched["17"];
    }
  }

  return patched;
}
