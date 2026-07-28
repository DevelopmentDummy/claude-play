#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
교정-확정 2패스 체이닝 (희명 제안 방식)

기존 체이닝의 결함:
  세그먼트 마지막 프레임 B를 교정해 B'를 만들고 다음 세그먼트를 B'에서 시작하면,
  세그먼트 N은 B로 끝나고 세그먼트 N+1은 B'에서 시작한다 → 이음새에서 화면이 튄다.

해결:
  1) 탐색 패스  A → (자유 생성) → B          end_image 없음
  2) 교정       B → ColorMatch(anchor) → B'
  3) 확정 패스  A → B' (FLF2V, end_image=B') ← 이 클립을 채택
  4) B'가 다음 구간의 A가 된다

세그먼트가 B'로 끝나고 다음이 B'에서 시작하므로 이음새가 원리적으로 사라진다.
비용은 구간당 생성 2회(약 2.1배).

측정:
  seam        = 직전 클립 마지막 프레임 vs 현재 클립 첫 프레임 차이 (0에 가까울수록 좋음)
  target_miss = 확정 클립의 마지막 프레임이 목표 B'에서 얼마나 벗어났는가
"""
import io
import json
import os
import sys
import time
import urllib.parse
import urllib.request
import uuid

COMFY = "http://127.0.0.1:8188"
INPUT_DIR = r"F:\repositories\comfyui\comfyui_submodule\input\longvid"
BASE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(BASE, "runs")
os.makedirs(OUT_DIR, exist_ok=True)

SCRIPT = [
    "she lifts the mug with both hands and takes a slow sip, steam curling upward",
    "she lowers the mug onto the table and rests her chin on her hand, gazing out the window",
    "she smiles faintly and brushes a strand of hair behind her ear",
    "she turns her head back toward the camera and leans forward slightly",
]
NEG = ("blurry, distorted, deformed, low quality, worst quality, jpeg artifacts, watermark, "
       "extra limbs, mutated, bad hands, static, still image, frozen pose, motionless")

SEED = 77777
LENGTH = 81
W, H = 832, 480
STEPS = 6
ANCHOR = "longvid/anchor.png"
START = "longvid/seg01_last.png"


def wan(start_name, motion, end_name=None):
    """end_name을 주면 FLF2V로 그 프레임에 수렴시킨다."""
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
            "images": ["13", 0], "filename_prefix": "chainK", "fps": 16,
            "lossless": False, "quality": 95, "method": "default"}},
    }
    if end_name:
        wf["18"] = {"class_type": "LoadImage", "inputs": {"image": end_name}}
        wf["10"]["inputs"]["end_image"] = ["18", 0]
    return wf


def colorfix(target_name):
    """B → ColorMatch(anchor) → B'  (디퓨전 없음, 수초)"""
    return {
        "1": {"class_type": "LoadImage", "inputs": {"image": ANCHOR}},
        "2": {"class_type": "LoadImage", "inputs": {"image": target_name}},
        "3": {"class_type": "ColorMatch", "inputs": {
            "image_ref": ["1", 0], "image_target": ["2", 0], "method": "mkl", "strength": 1.0}},
        "4": {"class_type": "SaveImage", "inputs": {"images": ["3", 0], "filename_prefix": "corrected"}},
    }


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
                    raise RuntimeError(json.dumps(st)[:500])
                return h[pid]
        except urllib.error.URLError:
            pass
        time.sleep(2)
    raise TimeoutError(pid)


def fetch(info):
    for node in info.get("outputs", {}).values():
        for f in node.get("images", []):
            q = urllib.parse.urlencode({"filename": f["filename"], "subfolder": f.get("subfolder", ""), "type": f.get("type", "output")})
            return urllib.request.urlopen(COMFY + "/view?" + q, timeout=120).read()
    return None


def diff(a, b):
    from PIL import ImageChops, ImageStat
    d = ImageChops.difference(a.convert("RGB"), b.convert("RGB"))
    return round(sum(ImageStat.Stat(d).mean) / 3, 3)


def lum(img):
    from PIL import ImageStat
    m = ImageStat.Stat(img.convert("RGB")).mean
    return round(0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2], 2)


def frames_of(raw):
    from PIL import Image, ImageSequence
    return [f.copy().convert("RGB") for f in ImageSequence.Iterator(Image.open(io.BytesIO(raw)))]


def run(n_seg):
    from PIL import Image
    cid = str(uuid.uuid4())
    cur = START
    rows, prev_last = [], None
    for i in range(1, n_seg + 1):
        motion = SCRIPT[(i - 1) % len(SCRIPT)]
        t0 = time.time()

        # --- 1) 탐색 패스: 자유 생성 ---
        raw = fetch(wait(queue(wan(cur, motion), cid)))
        probe = frames_of(raw)
        B = probe[-1]
        b_name = "K_probe%02d.png" % i
        B.save(os.path.join(INPUT_DIR, b_name))

        # --- 2) 교정: ColorMatch로 B' ---
        raw_fix = fetch(wait(queue(colorfix("longvid/" + b_name), cid)))
        Bp = Image.open(io.BytesIO(raw_fix)).convert("RGB")
        bp_name = "K_target%02d.png" % i
        Bp.save(os.path.join(INPUT_DIR, bp_name))
        fix_amount = diff(B, Bp)

        # --- 3) 확정 패스: A → B' ---
        raw2 = fetch(wait(queue(wan(cur, motion, end_name="longvid/" + bp_name), cid)))
        final = frames_of(raw2)
        open(os.path.join(OUT_DIR, "K_seg%02d.webp" % i), "wb").write(raw2)

        el = round(time.time() - t0, 1)
        seam = diff(prev_last, final[0]) if prev_last is not None else 0.0
        target_miss = diff(final[-1], Bp)
        rows.append({"seg": i, "sec": el, "lum_probe": lum(B), "lum_target": lum(Bp),
                     "lum_final": lum(final[-1]), "fix_amount": fix_amount,
                     "seam": seam, "target_miss": target_miss})
        print("[K] seg%02d %5.1fs  lum %6.2f→%6.2f(교정) 최종%6.2f  교정량=%5.2f  이음새=%6.3f  목표이탈=%6.3f"
              % (i, el, lum(B), lum(Bp), lum(final[-1]), fix_amount, seam, target_miss), flush=True)

        prev_last = final[-1]
        nxt = "K_seg%02d_last.png" % i
        final[-1].save(os.path.join(INPUT_DIR, nxt))
        cur = "longvid/" + nxt

    json.dump(rows, open(os.path.join(OUT_DIR, "K_stats.json"), "w"), indent=2)


if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 2
    print("=== 교정-확정 2패스 체이닝 | segments=%d ===" % n, flush=True)
    run(n)
