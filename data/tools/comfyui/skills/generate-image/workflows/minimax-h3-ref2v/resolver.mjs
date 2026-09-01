// minimax-h3-ref2v resolver
//
// ref2va: 첫 프레임을 고정하는 i2v와 달리, 레퍼런스 이미지를 <Picture N> 태그로 제시하고
// 모델이 그 정체성/스타일만 가져다 새 장면을 그린다. 구도는 프롬프트가 결정한다.
//
// ⚠️ 레퍼런스는 ImageScale로 사전 리사이즈하지 않는다.
// 노드가 내부적으로 처리하기 때문이다:
//   - ref_image_size="match" → 생성 픽셀 면적에 맞춰 **축소만**, 종횡비 보존
//   - ref_image_size="max"   → 짧은변 2048px, 정체성 충실도 최상 (레퍼런스 토큰이 매 샘플링
//                              스텝을 타고 흐르므로 몇 배 느려질 수 있다)
// i2v 패키지처럼 crop:center로 미리 잘라 넣으면 레퍼런스의 위아래가 날아간다.
export default function resolve(workflow, params, context) {
  const wf = context.defaultResolve(workflow, params, context);

  const pick = (v) => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);

  // ref_images: 문자열 하나 또는 파일명 배열
  const raw = params?.ref_images ?? params?.ref_image;
  const list = (Array.isArray(raw) ? raw : [raw]).map(pick).filter(Boolean);

  if (list.length === 0) {
    throw new Error(
      "minimax-h3-ref2v에는 ref_images가 최소 1장 필요합니다. " +
      "(t2v가 필요하면 minimax-h3-video를 쓰세요)"
    );
  }

  // ⚠️ Autogrow 입력 키는 점(.)으로 이어붙인 경로다: "<입력 id>.<prefix><i>".
  // MiniMaxH3ReferenceToVideo는 Autogrow.Input(id="ref_images", prefix="ref_image_")이므로
  // API 프롬프트 키는 "ref_images.ref_image_0"이 된다. 인덱스는 0-based.
  // (프롬프트 본문에서 지목하는 <Picture N> 태그만 1-based다 — 헷갈리지 말 것.)
  // "ref_image_0"으로 평평하게 넣으면
  //   TypeError: execute() got an unexpected keyword argument 'ref_image_0'
  // 로 죽는다 (2026-08-27 실측).
  const refKey = (i) => `ref_images.ref_image_${i}`;

  // LoadImage 슬롯: 30 → ref_image_0, 32 → ref_image_1
  const slots = ["30", "32"];
  if (list.length > slots.length) {
    throw new Error(`이 패키지는 레퍼런스 이미지를 최대 ${slots.length}장까지 받습니다 (요청: ${list.length}장).`);
  }

  slots.forEach((nodeId, i) => {
    const key = refKey(i);
    if (i < list.length) {
      wf[nodeId].inputs.image = list[i];
      wf["104"].inputs[key] = [nodeId, 0];
    } else {
      delete wf["104"].inputs[key];
      delete wf[nodeId];
    }
  });

  return wf;
}
