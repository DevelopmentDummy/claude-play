# -*- coding: utf-8 -*-
"""MMAudio 효과음 생성 — 영상 프레임을 보고 동기화된 소리를 만든다.

⚠ VHS_LoadVideo는 animated webp를 못 읽는다(OpenCV 미지원).
   프레임을 PNG로 풀어 LoadImagesFromFolderKJ로 넣을 것.
⚠ MMAudio는 8fps 샘플링 전제. 16fps 소스는 2프레임마다 하나씩 골라 넣는다.
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request
import uuid

COMFY = "http://127.0.0.1:8188"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "audio")
os.makedirs(OUT, exist_ok=True)
FOLDER_NAME = os.environ.get("MM_FOLDER", "mmframes")
FRAMES = os.path.join("F:", os.sep, "repositories", "comfyui", "comfyui_submodule", "input", FOLDER_NAME)


def build(folder, prompt, neg, duration, seed=7777, steps=25, cfg=4.5):
    return {
        "1": {"class_type": "MMAudioModelLoader", "inputs": {
            "mmaudio_model": "mmaudio_large_44k_v2_fp16.safetensors", "base_precision": "fp16"}},
        "2": {"class_type": "MMAudioFeatureUtilsLoader", "inputs": {
            "vae_model": "mmaudio_vae_44k_fp16.safetensors",
            "synchformer_model": "mmaudio_synchformer_fp16.safetensors",
            "clip_model": "apple_DFN5B-CLIP-ViT-H-14-384_fp16.safetensors",
            "mode": "44k", "precision": "fp16"}},
        "3": {"class_type": "LoadImagesFromFolderKJ", "inputs": {
            "folder": folder, "width": 832, "height": 480, "keep_aspect_ratio": "crop",
            "image_load_cap": 0, "start_index": 0, "include_subfolders": False}},
        "4": {"class_type": "MMAudioSampler", "inputs": {
            "mmaudio_model": ["1", 0], "feature_utils": ["2", 0],
            "duration": duration, "steps": steps, "cfg": cfg, "seed": seed,
            "prompt": prompt, "negative_prompt": neg,
            "mask_away_clip": False, "force_offload": True, "images": ["3", 0]}},
        "5": {"class_type": "SaveAudio", "inputs": {"audio": ["4", 0], "filename_prefix": "mmaudio"}},
    }


def queue(wf, cid):
    data = json.dumps({"prompt": wf, "client_id": cid}).encode()
    req = urllib.request.Request(COMFY + "/prompt", data=data,
                                 headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=60).read())["prompt_id"]


def wait(pid, timeout=900):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            h = json.loads(urllib.request.urlopen(COMFY + "/history/" + pid, timeout=30).read())
            if pid in h:
                st = h[pid].get("status", {})
                if st.get("status_str") == "error":
                    raise RuntimeError(json.dumps(st, ensure_ascii=False)[:900])
                return h[pid]
        except urllib.error.URLError:
            pass
        time.sleep(2)
    raise TimeoutError(pid)


def fetch(info, name):
    for node in info.get("outputs", {}).values():
        for key in ("audio", "images"):
            for f in node.get(key, []):
                q = urllib.parse.urlencode({"filename": f["filename"],
                                            "subfolder": f.get("subfolder", ""),
                                            "type": f.get("type", "output")})
                raw = urllib.request.urlopen(COMFY + "/view?" + q, timeout=120).read()
                p = os.path.join(OUT, name + os.path.splitext(f["filename"])[1])
                open(p, "wb").write(raw)
                return p
    return None


# ⚠ 1차 실패에서 배운 것:
#  - negative에 music/speech를 넣으면 카페의 핵심 요소(재즈 BGM·손님 웅성거림)가 전부 제거되고
#    남는 게 광대역 잡음뿐이라 "바람 부는 야외"처럼 들린다. 카페는 music/speech를 **넣어야** 한다.
#  - 화이트 노이즈는 negative로 직접 눌러야 한다(wind, hiss, static, white noise).
PROMPT = ("cozy indoor coffee shop, soft mellow jazz playing quietly from ceiling speakers, "
          "warm murmur of people chatting at nearby tables, occasional ceramic cup and saucer clink, "
          "espresso machine steam hiss in the distance, muffled and roomy, close indoor reverb")
NEG = ("wind, white noise, hiss, static, tape noise, outdoor, open field, rain, traffic, "
       "loud, harsh, distorted, clipping")

if __name__ == "__main__":
    name = sys.argv[1] if len(sys.argv) > 1 else "seg01_foley"
    dur = float(sys.argv[2]) if len(sys.argv) > 2 else 5.1
    cid = str(uuid.uuid4())
    t0 = time.time()
    try:
        info = wait(queue(build(FRAMES, PROMPT, NEG, dur), cid))
    except Exception as e:
        print("FAILED:", str(e)[:700])
        sys.exit(1)
    p = fetch(info, name)
    print("OK %.1fs -> %s (%.0f KB)" % (time.time() - t0, p, os.path.getsize(p) / 1024))
