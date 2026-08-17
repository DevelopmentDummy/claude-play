// 로케이션 시트 7장 일괄 정제 (Illustrious img2img denoise 0.50)
import fs from "node:fs";
import path from "node:path";

const REFS = "C:/repository/claude bridge/data/personas/comfyui연구/research/projects/harbor-vlog-trial/refs";
const INPUT = "F:/repositories/comfyui/input";
const OUT = "F:/repositories/comfyui/output";
const SESS = "C:/repository/claude bridge/data/sessions/comfyui연구-2026-08-12T19-17-30/images";
const API = "http://127.0.0.1:8188";
const DENOISE = 0.5;

const NEG = "bad quality, worst quality, worst detail, sketch, watermark, signature, text, 1girl, 1boy, people, person, crowd, film grain, grain, noise, speckle, stippling, dithering, dotted texture, halftone, crosshatch, jpeg artifacts, chromatic aberration";
const BASE = "masterpiece, best quality, absurdres, no humans, scenery, anime background art, painterly background, seaside village, cream plaster houses, orange tile roofs, smooth shading, clean surfaces";

const LOCS = [
  ["pier",        "ferry pier, wooden dock, mooring bollard, rope, small ferry ship, lighthouse, stone breakwater, hillside town, curved bay, fishing boats, blue sky, clouds, afternoon sunlight"],
  ["alley",       "stone stairway alley, stone steps, low stone wall, potted plants, laundry line, calm bay, fishing boats, lighthouse, afternoon sunlight, long shadows"],
  ["promenade",   "waterfront promenade, stone quay, metal railing, moored fishing boats, hillside houses, lighthouse, sunset, orange sky, sun reflection on water"],
  ["market",      "narrow market street, paper lanterns, market stalls, cloth awnings, fruit crates, cobblestone street, sunset, orange sky, harbor at street end"],
  ["breakwater",  "stone breakwater, metal railing, tumbled rocks, open sea, white lighthouse, deep sunset, sun on horizon, orange path on water, distant village lights"],
  ["stall_night", "outdoor food stall, wooden stall, cloth awning, hanging lamp, steaming pot, wooden stools, harbor quay, moored boats, evening, deep blue sky, lit windows on hillside"],
  ["pier_night",  "ferry pier at night, wooden dock, mooring bollard, docked ferry, lighthouse with light, village lights on hillside, night sky, stars, light reflections on dark water"],
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitQ() {
  for (;;) { await sleep(6000);
    try { const j = await (await fetch(API + "/prompt")).json(); if (j.exec_info.queue_remaining === 0) return; } catch {}
  }
}

for (const [name, tags] of LOCS) {
  const src = path.join(REFS, `loc_${name}.png`);
  if (!fs.existsSync(src)) { console.log(`[miss] ${name}`); continue; }
  const inName = `deg_src_${name}.png`;
  fs.copyFileSync(src, path.join(INPUT, inName));
  const prefix = `degfinal_${name}`;
  const g = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "waiIllustriousSDXL_v160.safetensors" } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: `${BASE}, ${tags}`, clip: ["1", 1] } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: NEG, clip: ["1", 1] } },
    "20": { class_type: "LoadImage", inputs: { image: inName } },
    "21": { class_type: "ImageScale", inputs: { image: ["20", 0], upscale_method: "lanczos", width: 1536, height: 1024, crop: "disabled" } },
    "22": { class_type: "VAEEncode", inputs: { pixels: ["21", 0], vae: ["1", 2] } },
    "5": { class_type: "KSampler", inputs: { seed: 24680, steps: 30, cfg: 5.5, sampler_name: "euler_ancestral", scheduler: "karras", denoise: DENOISE, model: ["1", 0], positive: ["2", 0], negative: ["3", 0], latent_image: ["22", 0] } },
    "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
    "7": { class_type: "SaveImage", inputs: { filename_prefix: prefix, images: ["6", 0] } },
  };
  const r = await fetch(API + "/prompt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: g, client_id: "degrain-batch" }) });
  if (r.status !== 200) { console.log(`[FAIL] ${name}`, r.status, (await r.text()).slice(0, 200)); continue; }
  await waitQ();
  const cand = fs.readdirSync(OUT).filter(n => n.startsWith(prefix) && n.endsWith(".png"))
    .map(n => ({ n, m: fs.statSync(path.join(OUT, n)).mtimeMs })).sort((a, b) => b.m - a.m);
  if (!cand.length) { console.log(`[NO-OUT] ${name}`); continue; }
  fs.copyFileSync(path.join(OUT, cand[0].n), path.join(REFS, `loc_${name}.png`));
  fs.copyFileSync(path.join(OUT, cand[0].n), path.join(SESS, `locf_${name}.png`));
  console.log(`[ok] ${name}`);
}
console.log("degrain batch done");
