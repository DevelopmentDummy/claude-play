// minimax-h3-video resolver
// first_frame 파라미터 유무에 따라 i2v / t2v를 자동 분기한다.
export default function resolve(workflow, params, context) {
  const wf = context.defaultResolve(workflow, params, context);

  const ff = params?.first_frame;
  const hasFirstFrame = typeof ff === "string" && ff.trim().length > 0;

  if (hasFirstFrame) {
    // i2v — LoadImage에 파일명을 넣고, ImageScale을 생성 해상도에 맞춘다
    wf["30"].inputs.image = ff.trim();
    wf["31"].inputs.width = wf["104"].inputs.width;
    wf["31"].inputs.height = wf["104"].inputs.height;
    wf["104"].inputs.first_frame = ["31", 0];
  } else {
    // t2v — 이미지 로더 계열 노드를 통째로 제거한다
    delete wf["104"].inputs.first_frame;
    delete wf["30"];
    delete wf["31"];
  }

  return wf;
}
