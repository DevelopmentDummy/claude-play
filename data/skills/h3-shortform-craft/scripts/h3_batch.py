# H3 ref2v 일괄 생성 — ComfyUI /prompt 직접 호출(스틸 여러 장을 토큰 낭비 없이 한 번에). GPU 매니저 큐를 거치지 않으므로 GPU가 비었을 때만 돌린다.
# 사용: python scripts/h3_batch.py <잡 스크립트> <출력 폴더> <id> [id …]   (세션 루트 cwd)
#   잡 스크립트는 `python <잡> <id>` 가 comfyui_generate params JSON(prompt, ref_images, seed, width, height, length, steps, ref_image_size)을 출력해야 한다.
#   결과: <출력 폴더>/<id>.mp4, 줄마다 {"id", "ok", "sec", "path"} JSON.
import json, os, subprocess, sys, time, urllib.parse, urllib.request, uuid

API = "http://127.0.0.1:8188"
def upload(path):
    name = f"sfs_{os.path.basename(path)}"
    boundary = uuid.uuid4().hex; data = open(path, "rb").read()
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{name}\"\r\nContent-Type: image/png\r\n\r\n").encode() + data + \
           (f"\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n--{boundary}--\r\n").encode()
    req = urllib.request.Request(f"{API}/upload/image", data=body, headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    return json.load(urllib.request.urlopen(req))["name"]

def workflow(p, refs, prefix):
    wf = {
     "6": {"class_type": "UNETLoader", "inputs": {"unet_name": "minimax_h3_ref2va_pruned_w4a8_mixed.safetensors", "weight_dtype": "default"}},
     "9": {"class_type": "BasicScheduler", "inputs": {"model": ["6", 0], "scheduler": "simple", "steps": p.get("steps", 25), "denoise": 1}},
     "10": {"class_type": "VAEDecode", "inputs": {"samples": ["14", 0], "vae": ["11", 0]}},
     "11": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_video_vae_int8_convrot.safetensors"}},
     "13": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "type": "minimax", "device": "default"}},
     "14": {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["15", 0], "guider": ["16", 0], "sampler": ["17", 0], "sigmas": ["9", 0], "latent_image": ["104", 1]}},
     "15": {"class_type": "RandomNoise", "inputs": {"noise_seed": p["seed"]}},
     "16": {"class_type": "BasicGuider", "inputs": {"model": ["6", 0], "conditioning": ["104", 0]}},
     "17": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "res_multistep"}},
     "23": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["14", 0], "vae": ["24", 0]}},
     "24": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_audio_vae_fp32.safetensors"}},
     "25": {"class_type": "NormalizeAudioLoudness", "inputs": {"audio": ["23", 0], "lufs": -20}},
     "91": {"class_type": "CreateVideo", "inputs": {"images": ["10", 0], "audio": ["25", 0], "fps": 24, "bit_depth": 8}},
     "92": {"class_type": "SaveVideo", "inputs": {"video": ["91", 0], "filename_prefix": prefix, "format": "auto", "codec": "auto"}},
     "104": {"class_type": "MiniMaxH3ReferenceToVideo", "inputs": {"clip": ["13", 0], "vae": ["11", 0], "audio_vae": ["24", 0], "prompt": p["prompt"],
             "width": p["width"], "height": p["height"], "length": p["length"], "ref_image_size": p.get("ref_image_size", "match")}},
    }
    for i, (nid, name) in enumerate(zip(["30", "32"], refs)):
        wf[nid] = {"class_type": "LoadImage", "inputs": {"image": name, "upload": "image"}}
        wf["104"]["inputs"][f"ref_images.ref_image_{i}"] = [nid, 0]
    return wf

job, outdir, ids = sys.argv[1], sys.argv[2], sys.argv[3:]
os.makedirs(outdir, exist_ok=True); cache = {}
for k in ids:
    t0 = time.time()
    try:
        p = json.loads(subprocess.run([sys.executable, job, k], capture_output=True, text=True, encoding="utf-8", check=True).stdout)
        refs = []
        for r in p["ref_images"]:
            if r not in cache: cache[r] = upload(r)
            refs.append(cache[r])
        prefix = f"video/sfs_{k}_{int(t0)}"
        req = urllib.request.Request(f"{API}/prompt", data=json.dumps({"prompt": workflow(p, refs, prefix)}).encode(), headers={"Content-Type": "application/json"})
        pid = json.load(urllib.request.urlopen(req))["prompt_id"]
        while True:
            time.sleep(2)
            h = json.load(urllib.request.urlopen(f"{API}/history/{pid}"))
            if pid not in h: continue
            st = h[pid]["status"]
            if st.get("status_str") == "error": raise RuntimeError(str(st.get("messages"))[-600:])
            if st.get("completed"): break
            if time.time() - t0 > 1500: raise TimeoutError("timeout")
        files = [a for o in h[pid]["outputs"].values() for key in ("images", "videos", "gifs") for a in o.get(key, [])]
        a = files[0]; q = urllib.parse.urlencode({"filename": a["filename"], "subfolder": a.get("subfolder", ""), "type": a.get("type", "output")})
        dst = os.path.join(outdir, f"{k}.mp4")
        with urllib.request.urlopen(f"{API}/view?{q}") as r, open(dst, "wb") as f: f.write(r.read())
        print(json.dumps({"id": k, "ok": True, "sec": round(time.time() - t0), "path": dst.replace(os.sep, "/")}), flush=True)
    except Exception as e:
        print(json.dumps({"id": k, "ok": False, "error": str(e)[-400:]}), flush=True)
