// 임베딩 코어 라이브 스모크 — 실행 중인 임베딩 서버(embed_server.py)로 runVectorAction 전 액션을 돈다.
// 사용자 데이터는 건드리지 않는다: 임시 DATA_DIR에 세션/페르소나 폴더를 만들고, 이미지는 data/에서 몇 장 복사만 한다.
//   npx tsx scripts/smoke-embedding.ts            (기본 포트 PORT+3 = 3343)
//   EMBED_PORT=3399 npx tsx scripts/smoke-embedding.ts
// 설계: docs/specs/2026-10-07-embedding-core-design.md
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const realData = path.resolve(process.env.DATA_DIR || "data");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vec-smoke-"));
process.env.DATA_DIR = tmp;

/** data/personas/*\/images에서 미리보기(_*)가 아닌 png를 최대 n장 찾는다. 없으면 이미지 단계는 건너뛴다. */
function findSampleImages(n: number): string[] {
  const personas = path.join(realData, "personas");
  if (!fs.existsSync(personas)) return [];
  for (const p of fs.readdirSync(personas)) {
    const dir = path.join(personas, p, "images");
    if (!fs.existsSync(dir)) continue;
    const pngs = fs.readdirSync(dir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f) && !f.startsWith("_")).slice(0, n);
    if (pngs.length >= 3) return pngs.map((f) => path.join(dir, f));
  }
  return [];
}

async function main() {
  const { runVectorAction } = await import("../src/lib/vector-index");
  const sessionDir = path.join(tmp, "sessions", "s1");
  const personaDir = path.join(tmp, "personas", "p1");
  fs.mkdirSync(path.join(personaDir, "images"), { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "memory.md"),
    "# 사용자 프로파일\n\n희명은 반말을 쓰고 짧게 말한다. 모험을 좋아한다.\n\n" +
    "## 사건 기록\n\n3일차 밤, 옥상에서 비를 맞으며 유나와 첫 키스를 했다.\n\n" +
    "5일차, 시장에서 붉은 리본을 사서 미연 언니에게 선물했다.\n\n" +
    "7일차, 던전 입구에서 고블린 무리와 싸워 왼팔을 다쳤다.\n");
  const ctx = { sessionDir, personaDir };
  let fails = 0;
  const step = async (label: string, action: string, params: Record<string, unknown>, expectError?: RegExp) => {
    const t0 = Date.now();
    try {
      const r = await runVectorAction(ctx, action, params);
      if (expectError) { fails++; console.log(`  ✘ ${label}: expected error, got`, JSON.stringify(r).slice(0, 200)); return null; }
      console.log(`  ✓ ${label} (${Date.now() - t0}ms)`, JSON.stringify(r).slice(0, 220));
      return r as Record<string, unknown>;
    } catch (e) {
      const msg = (e as Error).message;
      if (expectError?.test(msg)) { console.log(`  ✓ ${label} → rejected: ${msg.slice(0, 120)}`); return null; }
      fails++;
      console.log(`  ✘ ${label} (${Date.now() - t0}ms)`, msg);
      return null;
    }
  };
  const top = (r: Record<string, unknown> | null) => ((r?.hits as Array<{ id: string; text?: string }>) ?? [])[0];

  await step("warmup", "warmup", {});
  await step("index_file memory.md", "index_file", { collection: "memory", file: "memory.md", chunkChars: 200 });
  await step("index_file unchanged", "index_file", { collection: "memory", file: "memory.md" });
  const hurt = await step("search 한→한", "search", { collection: "memory", query: "주인공이 부상당한 일", topK: 2 });
  if (!top(hurt)?.text?.includes("고블린")) { fails++; console.log("  ✘ 한→한 정답(고블린) 미포함"); }
  const gift = await step("search 영→한", "search", { collection: "memory", query: "what present did he give?", topK: 1 });
  if (!top(gift)?.text?.includes("리본")) { fails++; console.log("  ✘ 영→한 정답(리본) 미포함"); }
  await step("upsert dim 256", "upsert", { collection: "notes", dim: 256, items: [
    { id: "n1", text: "유나는 고양이를 무서워한다", meta: { npc: "유나" } },
    { id: "n2", text: "미연은 매운 음식을 좋아한다", meta: { npc: "미연" } },
  ] });
  await step("search filter", "search", { collection: "notes", query: "유나가 싫어하는 동물", filter: { npc: "유나" } });
  await step("dim 충돌 거부", "upsert", { collection: "notes", dim: 512, items: [{ id: "x", text: "y" }] }, /dim/);
  await step("경로 탈출 거부", "index_file", { collection: "x", file: "../../../../Windows/win.ini" }, /escapes/);
  await step("unknown action 거부", "nope", {}, /unknown action/);

  const imgs = findSampleImages(5);
  if (imgs.length) {
    const names = imgs.map((src) => { const n = path.basename(src); fs.copyFileSync(src, path.join(personaDir, "images", n)); return n; });
    await step("index_dir persona", "index_dir", { scope: "persona", collection: "gallery", dir: "images" });
    await step("caption upsert", "upsert", { scope: "persona", collection: "gallery", items: [
      { id: `images/${names[0]}#caption`, text: "테스트 캡션", source: `images/${names[0]}` },
    ] });
    await step("index_dir 증분", "index_dir", { scope: "persona", collection: "gallery", dir: "images" });
    fs.unlinkSync(path.join(personaDir, "images", names[0]));
    const pr = await step("index_dir prune(캡션 포함)", "index_dir", { scope: "persona", collection: "gallery", dir: "images" });
    if (pr && pr.pruned !== 2) { fails++; console.log(`  ✘ prune 기대 2(이미지+캡션), 실제 ${pr.pruned}`); }
    await step("search 텍스트→이미지", "search", { scope: "persona", collection: "gallery", query: "a character portrait", topK: 3 });
    await step("search 이미지→이미지", "search", { scope: "persona", collection: "gallery", image: `images/${names[1]}`, topK: 2 });
  } else {
    console.log("  - 이미지 샘플 없음: 이미지 단계 건너뜀");
  }
  await step("list", "list", {});
  await step("drop", "drop", { collection: "notes" });
  console.log(fails ? `\n✘ ${fails} failure(s)` : "\n✓ embedding smoke passed");
  process.exitCode = fails ? 1 : 0;
}

main().finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
