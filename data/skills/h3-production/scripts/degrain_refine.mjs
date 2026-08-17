// GPT 배경 점묘 제거 — Illustrious 저노이즈 img2img 정제
// usage: node degrain_refine.mjs <denoise> <outPrefix>
const DENOISE = Number(process.argv[2] || 0.3);
const PREFIX = process.argv[3] || `degrain_d${String(DENOISE).replace(".", "")}`;

const POS = "masterpiece, best quality, absurdres, no humans, scenery, anime background art, painterly background, seaside village, stone stairway alley, stone steps, cream plaster houses, orange tile roofs, potted plants, laundry line, calm bay, fishing boats, lighthouse, stone breakwater, afternoon sunlight, warm lighting, smooth shading, clean surfaces";
const NEG = "bad quality, worst quality, worst detail, sketch, watermark, signature, text, 1girl, 1boy, people, person, film grain, grain, noise, speckle, stippling, dithering, dotted texture, halftone, crosshatch, jpeg artifacts, chromatic aberration";

const g = {
  "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "waiIllustriousSDXL_v160.safetensors" } },
  "2": { class_type: "CLIPTextEncode", inputs: { text: POS, clip: ["1", 1] } },
  "3": { class_type: "CLIPTextEncode", inputs: { text: NEG, clip: ["1", 1] } },
  "20": { class_type: "LoadImage", inputs: { image: "gpt_alley_src.png" } },
  "21": { class_type: "ImageScale", inputs: { image: ["20", 0], upscale_method: "lanczos", width: 1536, height: 1024, crop: "disabled" } },
  "22": { class_type: "VAEEncode", inputs: { pixels: ["21", 0], vae: ["1", 2] } },
  "5": { class_type: "KSampler", inputs: { seed: 12345, steps: 30, cfg: 5.5, sampler_name: "euler_ancestral", scheduler: "karras", denoise: DENOISE, model: ["1", 0], positive: ["2", 0], negative: ["3", 0], latent_image: ["22", 0] } },
  "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
  "7": { class_type: "SaveImage", inputs: { filename_prefix: PREFIX, images: ["6", 0] } },
};
const r = await fetch("http://127.0.0.1:8188/prompt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: g, client_id: "degrain" }) });
console.log("HTTP", r.status, "denoise", DENOISE, (await r.text()).slice(0, 200));
