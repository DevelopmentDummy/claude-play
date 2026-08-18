// minimax-h3-video-turbo resolver
// first_frame / last_frame 파라미터 유무에 따라 t2v / i2v / FLF2V(키프레임 보간)를 자동 분기한다.
//
// last_frame을 함께 주면 클립이 그 이미지로 수렴한다(FLF2V). 시작 프레임만 주고 15초를
// 방치하면 후반부가 드리프트하는데, 양 끝을 고정하면 그 표류가 구조적으로 줄고
// "어디로 끝날지"를 샷 단위로 지정할 수 있다. 체이닝 시 다음 세그먼트의 시작 프레임을
// 이번 세그먼트의 last_frame으로 주면 이음새도 함께 잡힌다.
export default function resolve(workflow, params, context) {
  const wf = context.defaultResolve(workflow, params, context);

  const pick = (v) => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);
  const ff = pick(params?.first_frame);
  const lf = pick(params?.last_frame);

  const w = wf["104"].inputs.width;
  const h = wf["104"].inputs.height;

  if (ff) {
    // i2v — LoadImage에 파일명을 넣고, ImageScale을 생성 해상도에 맞춘다
    wf["30"].inputs.image = ff;
    wf["31"].inputs.width = w;
    wf["31"].inputs.height = h;
    wf["104"].inputs.first_frame = ["31", 0];
  } else {
    // t2v — 시작 프레임 로더 계열 노드를 통째로 제거한다
    delete wf["104"].inputs.first_frame;
    delete wf["30"];
    delete wf["31"];
  }

  if (lf) {
    // FLF2V — 끝 프레임 고정. first_frame 없이 last_frame만 줘도 노드는 받아준다.
    wf["32"].inputs.image = lf;
    wf["33"].inputs.width = w;
    wf["33"].inputs.height = h;
    wf["104"].inputs.last_frame = ["33", 0];
  } else {
    delete wf["104"].inputs.last_frame;
    delete wf["32"];
    delete wf["33"];
  }

  // Turbo LoRA 옵션
  if (typeof params?.turbo_strength === 'number' && wf['200']) wf['200'].inputs.strength = params.turbo_strength;
  if (typeof params?.turbo_low_vram === 'boolean' && wf['200']) wf['200'].inputs.low_vram = params.turbo_low_vram;

  return wf;
}
