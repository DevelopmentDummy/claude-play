export default function resolve(workflow, params, context) {
  const patched = context.defaultResolve(workflow, params, context);

  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  const bool = (v, d) => (v === undefined || v === null ? d : Boolean(v));

  // base seed (z-image t2i)
  let bseed = num(params.base_seed, -1);
  if (bseed < 0) bseed = Math.floor(Math.random() * 1e15);
  if (patched["8"]?.inputs) patched["8"].inputs.seed = bseed;

  // motion seed (wan i2v, 두 스테이지 동일)
  let mseed = num(params.motion_seed, -1);
  if (mseed < 0) mseed = Math.floor(Math.random() * 1e15);
  if (patched["30"]?.inputs) patched["30"].inputs.noise_seed = mseed;
  if (patched["31"]?.inputs) patched["31"].inputs.noise_seed = mseed;

  // motion steps + high/low 분할
  const msteps = Math.max(2, num(params.motion_steps, 8));
  const half = Math.max(1, Math.floor(msteps / 2));
  if (patched["30"]?.inputs) { patched["30"].inputs.steps = msteps; patched["30"].inputs.end_at_step = half; }
  if (patched["31"]?.inputs) { patched["31"].inputs.steps = msteps; patched["31"].inputs.start_at_step = half; }

  // loop — FLF2V: end_image = t2i 출력(노드 9)
  const loop = bool(params.loop, false);
  if (patched["29"]?.inputs) {
    if (loop) patched["29"].inputs.end_image = ["9", 0];
    else delete patched["29"].inputs.end_image;
  }

  // upscale on/off — sink rewire
  const upscale = bool(params.upscale, true);
  if (patched["33"]?.inputs) {
    if (upscale) {
      patched["33"].inputs.images = ["36", 0];
    } else {
      patched["33"].inputs.images = ["32", 0];
      delete patched["34"]; delete patched["35"]; delete patched["36"];
    }
  }

  return patched;
}
