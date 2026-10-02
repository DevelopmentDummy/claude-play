// seedvr2-video-upscale resolver (2026-10-01)
// video 파라미터를 실제 파일 경로로 풀어 VHS_LoadVideoPath에 넣는다.
import fs from "node:fs";
import path from "node:path";

export default function resolve(workflow, params, context) {
  const wf = context.defaultResolve(workflow, params, context);
  const raw = typeof params?.video === "string" ? params.video.trim() : "";
  if (!raw) throw new Error("seedvr2-video-upscale: video 파라미터(파일명 또는 절대경로)가 필요합니다.");

  let name = raw.startsWith("persona:") ? raw.slice("persona:".length) : raw;
  name = path.basename(name);
  const candidates = [];
  if (path.isAbsolute(raw)) candidates.push(raw);
  if (context.sessionDir) {
    candidates.push(path.join(context.sessionDir, "images", name));
    const personasRoot = path.resolve(context.sessionDir, "..", "..", "personas");
    if (fs.existsSync(personasRoot)) {
      for (const p of fs.readdirSync(personasRoot)) candidates.push(path.join(personasRoot, p, "images", name));
    }
  }
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) throw new Error(`seedvr2-video-upscale: 영상을 찾지 못했습니다: ${raw}`);

  wf["1"].inputs.video = found.split(path.sep).join("/");
  // 3B 모델은 스왑 없이도 들어간다.
  if (/_3b/.test(String(wf["2"].inputs.model)) && params?.blocks_to_swap === undefined) wf["2"].inputs.blocks_to_swap = 0;
  return wf;
}
