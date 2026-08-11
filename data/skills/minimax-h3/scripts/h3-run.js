// MiniMax H3 NVFP4 첫 스모크 테스트 — API 포맷 그래프 직접 구성
const LEN=Number(process.argv[6]||124);
const WIDTH=Number(process.argv[4]||1344), HEIGHT=Number(process.argv[5]||768);
const SEED = Number(process.argv[2] || 556589502035082);
const PROMPT = process.argv[3] || "Cinematic close-up of a glass of water on a wooden desk in a dim laboratory, teal monitor light reflecting on the surface, slow push-in, subtle ripples, ambient hum of cooling fans";

const g = {
  "6":  { class_type: "UNETLoader", inputs: { unet_name: "MiniMax_H3_FL2VA_pruned_nvfp4.safetensors", weight_dtype: "default" } },
  "13": { class_type: "CLIPLoader", inputs: { clip_name: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", type: "minimax", device: "default" } },
  "11": { class_type: "VAELoader", inputs: { vae_name: "minimax_h3_video_vae_fp16.safetensors" } },
  "24": { class_type: "VAELoader", inputs: { vae_name: "minimax_h3_audio_vae_fp32.safetensors" } },
  "104": { class_type: "MiniMaxH3ImageToVideo", inputs: { clip: ["13", 0], vae: ["11", 0], prompt: PROMPT, width: WIDTH, height: HEIGHT, length: LEN } },
  "16": { class_type: "BasicGuider", inputs: { model: ["6", 0], conditioning: ["104", 0] } },
  "9":  { class_type: "BasicScheduler", inputs: { model: ["6", 0], scheduler: "simple", steps: 20, denoise: 1 } },
  "17": { class_type: "KSamplerSelect", inputs: { sampler_name: "res_multistep" } },
  "15": { class_type: "RandomNoise", inputs: { noise_seed: SEED } },
  "14": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["15", 0], guider: ["16", 0], sampler: ["17", 0], sigmas: ["9", 0], latent_image: ["104", 1] } },
  "10": { class_type: "VAEDecode", inputs: { samples: ["14", 0], vae: ["11", 0] } },
  "23": { class_type: "VAEDecodeAudio", inputs: { samples: ["14", 0], vae: ["24", 0] } },
  "91": { class_type: "CreateVideo", inputs: { images: ["10", 0], audio: ["23", 0], fps: 24, bit_depth: 8 } },
  "92": { class_type: "SaveVideo", inputs: { video: ["91", 0], filename_prefix: `video/h3_nvfp4_${WIDTH}x${HEIGHT}_L${LEN}`, format: "auto", codec: "auto" } },
};

(async () => {
  const r = await fetch("http://127.0.0.1:8188/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: g, client_id: "h3-smoke" }),
  });
  const t = await r.text();
  console.log("HTTP", r.status);
  console.log(t.slice(0, 3000));
})();
