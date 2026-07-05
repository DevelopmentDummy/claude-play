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
  return patched;
}
