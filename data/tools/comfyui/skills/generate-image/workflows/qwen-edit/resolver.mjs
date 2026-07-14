export default function resolve(workflow, params, context) {
  const patched = context.defaultResolve(workflow, params, context);
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

  // seed — -1이면 랜덤
  let seed = num(params.seed, -1);
  if (seed < 0) seed = Math.floor(Math.random() * 1e15);
  if (patched["11"]?.inputs) patched["11"].inputs.seed = seed;

  // reference_image — 있으면 node 14를 image2로 배선, 없으면 노드 제거
  if (params.reference_image) {
    if (patched["14"]?.inputs) patched["14"].inputs.image = String(params.reference_image);
    if (patched["8"]?.inputs) patched["8"].inputs.image2 = ["14", 0];
  } else {
    delete patched["14"];
    if (patched["8"]?.inputs) delete patched["8"].inputs.image2;
  }

  return patched;
}
