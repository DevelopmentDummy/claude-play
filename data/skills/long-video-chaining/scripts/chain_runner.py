#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
WAN i2v 장편 체이닝 러너 — last-frame 체이닝으로 30초 이상 생성 + 열화 측정

핵심 2가지 (SKILL.md 참조):
  1) 세그먼트마다 프롬프트를 진행시킨다 — 동일 프롬프트 반복은 seg2부터 포즈를 얼린다
  2) VAEDecode 뒤에 ColorMatch(kjnodes)를 물려 고정 앵커로 팔레트를 되돌린다
     → 대비(std) 단조 증가를 매 세그먼트 리셋. 이게 있고 없고가 결정적이다

variant C : 진행형 프롬프트만          (대비 누적 남음)
variant D : 진행형 + ColorMatch 앵커   ★ 정답 레시피
variant E : D + SVI Pro LoRA           ✗ lightning과 충돌해 화면 붕괴. 실패 재현용

사전 준비:
  - ComfyUI 구동 (127.0.0.1:8188)
  - input/longvid/anchor.png       팔레트 기준 프레임(1세그 첫 프레임)
  - input/longvid/seg01_last.png   체이닝 시작 프레임
  - 아래 SCRIPT 리스트를 장면에 맞게 교체
"""
import json, os, sys, time, uuid, urllib.request, urllib.parse, io

COMFY = "http://127.0.0.1:8188"
INPUT_DIR = r"F:\repositories\comfyui\comfyui_submodule\input\longvid"
BASE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(BASE, "runs")
os.makedirs(OUT_DIR, exist_ok=True)
os.makedirs(INPUT_DIR, exist_ok=True)

# 세그먼트별 진행형 모션 — 같은 동작을 반복시키지 않는 것이 핵심
SCRIPT = [
    "she lifts the mug with both hands and takes a slow sip, steam curling upward, eyes lowered",
    "she lowers the mug onto the table and rests her chin on her hand, turning her gaze out the window",
    "she smiles faintly and brushes a strand of hair behind her ear, shoulders relaxing",
    "she turns her head back toward the camera and leans forward slightly, blinking once",
    "she picks up the mug again and cradles it against her chest, looking down thoughtfully",
    "she straightens up and stretches her neck to one side, sunlight sweeping across her face",
]
NEG = ("blurry, distorted, deformed, low quality, worst quality, jpeg artifacts, watermark, "
       "extra limbs, mutated, bad hands, static, still image, frozen pose, motionless")

SEED = 77777
LENGTH = 81
W, H = 832, 480
STEPS = 6
ANCHOR = "longvid/anchor.png"          # 팔레트 기준 프레임
SVI_HIGH = "SVI_v20pro_high_noise_comfy.safetensors"   # convert_svi.py 변환본 필수
SVI_LOW = "SVI_v20pro_low_noise_comfy.safetensors"


def build(start_name, motion, use_cm, use_svi, cm_strength=1.0, svi_strength=1.0):
    half = max(1, STEPS // 2)
    wf = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors", "weight_dtype": "default"}},
        "2": {"class_type": "UNETLoader", "inputs": {"unet_name": "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors", "weight_dtype": "default"}},
        "3": {"class_type": "LoraLoaderModelOnly", "inputs": {"lora_name": "wan22-lightning-i2v-high_noise.safetensors", "strength_model": 1, "model": ["1", 0]}},
        "4": {"class_type": "LoraLoaderModelOnly", "inputs": {"lora_name": "wan22-lightning-i2v-low_noise.safetensors", "strength_model": 1, "model": ["2", 0]}},
        "5": {"class_type": "CLIPLoader", "inputs": {"clip_name": "umt5_xxl_fp8_e4m3fn_scaled.safetensors", "type": "wan"}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"text": motion, "clip": ["5", 0]}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"text": NEG, "clip": ["5", 0]}},
        "8": {"class_type": "LoadImage", "inputs": {"image": start_name}},
        "9": {"class_type": "VAELoader", "inputs": {"vae_name": "wan_2.1_vae.safetensors"}},
        "10": {"class_type": "WanFirstLastFrameToVideo", "inputs": {
            "width": W, "height": H, "length": LENGTH, "batch_size": 1,
            "positive": ["6", 0], "negative": ["7", 0], "vae": ["9", 0], "start_image": ["8", 0]}},
        "11": {"class_type": "KSamplerAdvanced", "inputs": {
            "add_noise": "enable", "noise_seed": SEED, "steps": STEPS, "cfg": 1,
            "sampler_name": "euler", "scheduler": "simple", "start_at_step": 0, "end_at_step": half,
            "return_with_leftover_noise": "enable",
            "model": ["3", 0], "positive": ["10", 0], "negative": ["10", 1], "latent_image": ["10", 2]}},
        "12": {"class_type": "KSamplerAdvanced", "inputs": {
            "add_noise": "disable", "noise_seed": SEED, "steps": STEPS, "cfg": 1,
            "sampler_name": "euler", "scheduler": "simple", "start_at_step": half, "end_at_step": 10000,
            "return_with_leftover_noise": "disable",
            "model": ["4", 0], "positive": ["10", 0], "negative": ["10", 1], "latent_image": ["11", 0]}},
        "13": {"class_type": "VAEDecode", "inputs": {"samples": ["12", 0], "vae": ["9", 0]}},
        "14": {"class_type": "SaveAnimatedWEBP", "inputs": {
            "images": ["13", 0], "filename_prefix": "chain2", "fps": 16,
            "lossless": False, "quality": 95, "method": "default"}},
    }
    if use_svi:
        wf["31"] = {"class_type": "LoraLoaderModelOnly", "inputs": {"lora_name": SVI_HIGH, "strength_model": svi_strength, "model": ["3", 0]}}
        wf["41"] = {"class_type": "LoraLoaderModelOnly", "inputs": {"lora_name": SVI_LOW, "strength_model": svi_strength, "model": ["4", 0]}}
        wf["11"]["inputs"]["model"] = ["31", 0]
        wf["12"]["inputs"]["model"] = ["41", 0]
    if use_cm:
        wf["20"] = {"class_type": "LoadImage", "inputs": {"image": ANCHOR}}
        wf["21"] = {"class_type": "ColorMatch", "inputs": {
            "image_ref": ["20", 0], "image_target": ["13", 0],
            "method": "mkl", "strength": cm_strength}}
        wf["14"]["inputs"]["images"] = ["21", 0]
    return wf


def queue(wf, cid):
    data = json.dumps({"prompt": wf, "client_id": cid}).encode()
    req = urllib.request.Request(COMFY + "/prompt", data=data, headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=60).read())["prompt_id"]


def wait(pid, timeout=1800):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            h = json.loads(urllib.request.urlopen(COMFY + "/history/" + pid, timeout=30).read())
            if pid in h:
                st = h[pid].get("status", {})
                if st.get("status_str") == "error":
                    raise RuntimeError(json.dumps(st)[:600])
                return h[pid]
        except urllib.error.URLError:
            pass
        time.sleep(3)
    raise TimeoutError("prompt %s timed out" % pid)


def fetch_webp(info):
    for node in info.get("outputs", {}).values():
        for f in node.get("images", []):
            q = urllib.parse.urlencode({"filename": f["filename"], "subfolder": f.get("subfolder", ""), "type": f.get("type", "output")})
            return urllib.request.urlopen(COMFY + "/view?" + q, timeout=120).read()
    return None


def stats(img):
    from PIL import ImageStat
    st = ImageStat.Stat(img.convert("RGB"))
    return {"mean": [round(v, 2) for v in st.mean],
            "std": [round(v, 2) for v in st.stddev],
            "lum": round(0.299 * st.mean[0] + 0.587 * st.mean[1] + 0.114 * st.mean[2], 2)}


def motion_energy(a, b):
    """연속 프레임 간 평균 절대차 — 값이 낮으면 화면이 멈춘 것"""
    from PIL import ImageChops, ImageStat
    d = ImageChops.difference(a.convert("RGB"), b.convert("RGB"))
    return round(sum(ImageStat.Stat(d).mean) / 3, 3)


def run(variant, n_seg, seed_frame, use_cm, use_svi, cm_strength=1.0, svi_strength=1.0):
    from PIL import Image, ImageSequence
    cid = str(uuid.uuid4())
    cur, rows, ref = seed_frame, [], None
    for i in range(1, n_seg + 1):
        motion = SCRIPT[(i - 1) % len(SCRIPT)]
        t0 = time.time()
        try:
            info = wait(queue(build(cur, motion, use_cm, use_svi, cm_strength, svi_strength), cid))
        except Exception as e:
            print("[%s] seg%02d FAILED: %s" % (variant, i, str(e)[:300]), flush=True)
            break
        elapsed = round(time.time() - t0, 1)
        raw = fetch_webp(info)
        if raw is None:
            print("[%s] seg%02d: no output" % (variant, i), flush=True); break
        open(os.path.join(OUT_DIR, "%s_seg%02d.webp" % (variant, i)), "wb").write(raw)
        frames = [f.copy().convert("RGB") for f in ImageSequence.Iterator(Image.open(io.BytesIO(raw)))]
        if ref is None:
            ref = stats(frames[0])
        s = stats(frames[-1])
        # 세그먼트 내부 모션 총량 — 데드락 탐지용
        me = round(sum(motion_energy(frames[k], frames[k + 1]) for k in range(0, len(frames) - 1, 8)) / max(1, len(range(0, len(frames) - 1, 8))), 3)
        # 시작프레임 대비 최종프레임 변화량 — 포즈가 실제로 바뀌었는가
        pose_delta = motion_energy(frames[0], frames[-1])
        rows.append({"seg": i, "sec": elapsed, "lum": s["lum"], "lum_drift": round(s["lum"] - ref["lum"], 2),
                     "std": s["std"], "motion": me, "pose_delta": pose_delta, "prompt": motion[:48]})
        print("[%s] seg%02d %5.1fs lum=%6.2f drift=%+5.2f stdR=%5.2f motion=%6.3f pose%s=%6.3f" %
              (variant, i, elapsed, s["lum"], s["lum"] - ref["lum"], s["std"][0], me, "Δ", pose_delta), flush=True)
        nxt = "%s_seg%02d_last.png" % (variant, i)
        frames[-1].save(os.path.join(INPUT_DIR, nxt))
        cur = "longvid/" + nxt
    json.dump(rows, open(os.path.join(OUT_DIR, "%s_stats.json" % variant), "w"), indent=2)
    return rows


PRESETS = {
    "C": dict(use_cm=False, use_svi=False),
    "D": dict(use_cm=True, use_svi=False),
    "E": dict(use_cm=True, use_svi=True),
}

if __name__ == "__main__":
    v = sys.argv[1] if len(sys.argv) > 1 else "C"
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 6
    cfg = PRESETS.get(v.upper(), PRESETS["C"])
    print("=== variant %s | segments=%d | %s ===" % (v, n, cfg), flush=True)
    run(v, n, "longvid/seg01_last.png", **cfg)
