// 본편 드래프트 러너 — shots-main/ 전용
// 샷의 render.engine + location에 따라 캐릭터 3장 + 공간 1장을 자동 바인딩
import fs from "node:fs";
import path from "node:path";

const PROJ = "C:/repository/claude bridge/data/personas/comfyui연구/research/projects/harbor-vlog-trial";
const REFS = path.join(PROJ, "refs");
const INPUT = "F:/repositories/comfyui/input";
const OUTDIR = "F:/repositories/comfyui/output/video";
const API = "http://127.0.0.1:8188";
const ONLY_SCENE = process.argv[2] ? Number(process.argv[2]) : null;

const CHAR_REFS = ["gj_front.png", "gj_profile.png", "gj_face.png"];

function stageRef(name) {
  const src = path.join(REFS, name);
  const dst = path.join(INPUT, name);
  if (!fs.existsSync(dst) || fs.statSync(src).mtimeMs > fs.statSync(dst).mtimeMs) fs.copyFileSync(src, dst);
  return name;
}

function buildGraph(s) {
  const steps = s.render?.steps ?? 20;
  const w = s.draft.width, h = s.draft.height;
  const common = {
    "13": { class_type: "CLIPLoader", inputs: { clip_name: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", type: "minimax", device: "default" } },
    "11": { class_type: "VAELoader", inputs: { vae_name: "minimax_h3_video_vae_fp16.safetensors" } },
    "24": { class_type: "VAELoader", inputs: { vae_name: "minimax_h3_audio_vae_fp32.safetensors" } },
    "15": { class_type: "RandomNoise", inputs: { noise_seed: s.seed } },
    "14": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["15", 0], guider: ["16", 0], sampler: ["17", 0], sigmas: ["9", 0], latent_image: ["104", 1] } },
    "10": { class_type: "VAEDecode", inputs: { samples: ["14", 0], vae: ["11", 0] } },
    "23": { class_type: "VAEDecodeAudio", inputs: { samples: ["14", 0], vae: ["24", 0] } },
    "25": { class_type: "NormalizeAudioLoudness", inputs: { audio: ["23", 0], lufs: -16 } },
    "91": { class_type: "CreateVideo", inputs: { images: ["10", 0], audio: ["25", 0], fps: 24, bit_depth: 8 } },
    "92": { class_type: "SaveVideo", inputs: { video: ["91", 0], filename_prefix: `video/main_${s.id}`, format: "auto", codec: "auto" } },
  };
  const engine = s.render?.engine ?? "ref2va";

  if (engine === "ref2va") {
    // 인물 샷: 캐릭터 3장 + 공간 1장 / 무인 샷(hasCharacter=false): 공간 1장만
    const list = (s.has_character === false) ? [] : CHAR_REFS.slice();
    if (s.location) list.push(`loc_${s.location}.png`);
    const g = { ...common,
      "6": { class_type: "UNETLoader", inputs: { unet_name: "minimax_h3_ref2va_pruned_w4a8_mixed.safetensors", weight_dtype: "default" } },
      "104": { class_type: "MiniMaxH3ReferenceToVideo", inputs: {
        clip: ["13", 0], vae: ["11", 0], audio_vae: ["24", 0], prompt: s.prompt,
        width: w, height: h, length: s.length, ref_image_size: "match" } },
      "16": { class_type: "BasicGuider", inputs: { model: ["6", 0], conditioning: ["104", 0] } },
      "9": { class_type: "BasicScheduler", inputs: { model: ["6", 0], scheduler: "simple", steps, denoise: 1 } },
      "17": { class_type: "KSamplerSelect", inputs: { sampler_name: "res_multistep" } },
    };
    list.forEach((name, i) => {
      const nid = String(30 + i);
      g[nid] = { class_type: "LoadImage", inputs: { image: stageRef(name) } };
      g["104"].inputs[`ref_images.ref_image_${i}`] = [nid, 0];
    });
    return g;
  }

  const base = { ...common,
    "6": { class_type: "UNETLoader", inputs: { unet_name: "MiniMax_H3_FL2VA_pruned_nvfp4.safetensors", weight_dtype: "default" } },
    "104": { class_type: "MiniMaxH3ImageToVideo", inputs: { clip: ["13", 0], vae: ["11", 0], prompt: s.prompt, width: w, height: h, length: s.length } },
  };
  if (engine === "fl2va-turbo") {
    return { ...base,
      "7": { class_type: "MiniMaxH3TurboLoRA", inputs: { model: ["6", 0], lora_name: "minimax_h3_turbo_v4_step600_ema.safetensors", strength: 1.0, low_vram: false } },
      "16": { class_type: "BasicGuider", inputs: { model: ["7", 0], conditioning: ["104", 0] } },
      "9": { class_type: "BasicScheduler", inputs: { model: ["7", 0], scheduler: "simple", steps, denoise: 1 } },
      "17": { class_type: "MiniMaxH3TurboSampler", inputs: {} },
    };
  }
  return { ...base,
    "16": { class_type: "BasicGuider", inputs: { model: ["6", 0], conditioning: ["104", 0] } },
    "9": { class_type: "BasicScheduler", inputs: { model: ["6", 0], scheduler: "simple", steps, denoise: 1 } },
    "17": { class_type: "KSamplerSelect", inputs: { sampler_name: "res_multistep" } },
  };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitQ() {
  for (;;) { await sleep(12000);
    try { const j = await (await fetch(API + "/prompt")).json(); if (j.exec_info.queue_remaining === 0) return; } catch {}
  }
}

const dir = path.join(PROJ, "shots-main");
fs.mkdirSync(path.join(PROJ, "renders/draft-main"), { recursive: true });
const files = fs.readdirSync(dir).filter(f => f.endsWith(".json")).sort();
for (const f of files) {
  const p = path.join(dir, f);
  const s = JSON.parse(fs.readFileSync(p, "utf-8"));
  if (ONLY_SCENE !== null && s.scene !== ONLY_SCENE) continue;
  if (s.status !== "draft_pending") { console.log(`[skip] ${s.id} ${s.status}`); continue; }
  const t0 = Date.now();
  const res = await fetch(API + "/prompt", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: buildGraph(s), client_id: "main-runner" }) });
  const body = await res.json();
  if (res.status !== 200 || (body.node_errors && Object.keys(body.node_errors).length)) {
    console.log(`[FAIL-QUEUE] ${s.id}`, res.status, JSON.stringify(body).slice(0, 400)); break;
  }
  await waitQ();
  const secs = Math.round((Date.now() - t0) / 1000);
  const cand = fs.readdirSync(OUTDIR).filter(n => n.startsWith(`main_${s.id}`) && n.endsWith(".mp4"))
    .map(n => ({ n, m: fs.statSync(path.join(OUTDIR, n)).mtimeMs })).sort((a, b) => b.m - a.m);
  if (!cand.length) { console.log(`[NO-OUT] ${s.id} — check /history`); break; }
  fs.copyFileSync(path.join(OUTDIR, cand[0].n), path.join(PROJ, "renders/draft-main", `${s.id}.mp4`));
  s.status = "draft_rendered"; s.draft_seconds = secs;
  fs.writeFileSync(p, JSON.stringify(s, null, 2), "utf-8");
  console.log(`[ok] ${s.id} ${secs}s (${s.render?.engine})`);
}
console.log("main draft batch done");
