// minimax-h3-latent-upscale resolver
// first/last frame 분기 + latent/conditioning 동시 확대 파라미터를 처리한다.
export default function resolve(workflow, params, context) {
  const wf = context.defaultResolve(workflow, params, context);
  const pick = (v) => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);
  const ff = pick(params?.first_frame);
  const lf = pick(params?.last_frame);
  const w = wf["104"].inputs.width;
  const h = wf["104"].inputs.height;

  if (ff) {
    wf["30"].inputs.image = ff;
    wf["31"].inputs.width = w;
    wf["31"].inputs.height = h;
    wf["104"].inputs.first_frame = ["31", 0];
  } else {
    delete wf["104"].inputs.first_frame;
    delete wf["30"];
    delete wf["31"];
  }

  if (lf) {
    wf["32"].inputs.image = lf;
    wf["33"].inputs.width = w;
    wf["33"].inputs.height = h;
    wf["104"].inputs.last_frame = ["33", 0];
  } else {
    delete wf["104"].inputs.last_frame;
    delete wf["32"];
    delete wf["33"];
  }

  const scale = Number.isFinite(Number(params?.scale_by)) ? Number(params.scale_by) : 1.5;
  const method = typeof params?.upscale_method === "string" ? params.upscale_method : "bilinear";
  wf["126"].inputs.scale_by = scale;
  wf["128"].inputs.scale_by = scale;
  wf["126"].inputs.upscale_method = method;
  wf["128"].inputs.upscale_method = method;
  return wf;
}
