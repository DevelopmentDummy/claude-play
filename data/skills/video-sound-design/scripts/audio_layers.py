# -*- coding: utf-8 -*-
"""레이어 분리 사운드 파이프라인 — 배경(앰비언스) + 효과음(폴리)을 따로 만들어 믹스한다.

단일 패스의 한계:
  MMAudioSampler는 프롬프트를 하나만 받는다 → 시간대별 지시가 구조적으로 불가능하고,
  특정 소리가 과하게 나와도 줄일 방법이 없다.

레이어 분리로 얻는 것:
  1) 구간마다 다른 프롬프트를 줄 수 있다 (폴리를 구간별로 생성)
  2) 게인으로 소리 크기를 조절할 수 있다 (믹스 단계에서)
  3) 배경은 8초 스위트스팟에서 생성해 크로스페이드로 늘린다 (학습 길이 = 8초)

프롬프트 원칙 (조사 확인분):
  - CLIP 77토큰, 실효 20토큰 이하 → 짧은 캡션체
  - negative는 uncond 분기를 통째로 대체 → 1~3단어
  - soft/faint는 볼륨이 아니라 음원 클래스 선택자 → 줄이려면 단어를 빼라
  - mask_away_clip=True → 화면이 유도하는 음원을 끊고 텍스트로만 음색 지정 (앰비언스용)
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request
import uuid

import numpy as np
import soundfile as sf

COMFY = "http://127.0.0.1:8188"
BASE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(BASE, "audio")
os.makedirs(OUT, exist_ok=True)
INPUT_ROOT = os.path.join("F:", os.sep, "repositories", "comfyui", "comfyui_submodule", "input")

SR = 44100
TOTAL = 30.08          # 영상 전체 길이
AMB_LEN = 8.0          # 앰비언스 1개 길이 (= 학습 길이)
AMB_N = 4              # 앰비언스 개수


def build(folder, prompt, neg, duration, mask_away_clip, seed, steps=25, cfg=4.5):
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
            "mask_away_clip": mask_away_clip, "force_offload": True, "images": ["3", 0]}},
        "5": {"class_type": "SaveAudio", "inputs": {"audio": ["4", 0], "filename_prefix": "layer"}},
    }


def queue(wf, cid):
    data = json.dumps({"prompt": wf, "client_id": cid}).encode()
    req = urllib.request.Request(COMFY + "/prompt", data=data,
                                 headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=60).read())["prompt_id"]


def wait(pid, timeout=1200):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            h = json.loads(urllib.request.urlopen(COMFY + "/history/" + pid, timeout=30).read())
            if pid in h:
                st = h[pid].get("status", {})
                if st.get("status_str") == "error":
                    raise RuntimeError(json.dumps(st, ensure_ascii=False)[:700])
                return h[pid]
        except urllib.error.URLError:
            pass
        time.sleep(2)
    raise TimeoutError(pid)


def fetch(info, name):
    for node in info.get("outputs", {}).values():
        for f in node.get("audio", []):
            q = urllib.parse.urlencode({"filename": f["filename"],
                                        "subfolder": f.get("subfolder", ""),
                                        "type": f.get("type", "output")})
            raw = urllib.request.urlopen(COMFY + "/view?" + q, timeout=120).read()
            p = os.path.join(OUT, name + os.path.splitext(f["filename"])[1])
            open(p, "wb").write(raw)
            return p
    return None


def gen(folder, prompt, neg, dur, mask, seed, name, cid):
    t0 = time.time()
    info = wait(queue(build(folder, prompt, neg, dur, mask, seed), cid))
    p = fetch(info, name)
    d, _ = sf.read(p)
    if d.ndim > 1:
        d = d.mean(axis=1)
    print("  %-16s %5.1fs  %.2f초  RMS=%.4f" % (name, time.time() - t0, len(d) / SR,
                                                float(np.sqrt((d ** 2).mean()))), flush=True)
    return d


def mono(x):
    return x if x.ndim == 1 else x.mean(axis=1)


def crossfade_chain(clips, total_samples):
    """8초 클립 여러 개를 등간격 크로스페이드로 이어 total 길이를 채운다."""
    n = len(clips)
    lens = [len(c) for c in clips]
    overlap = max(1, int((sum(lens) - total_samples) / max(1, n - 1)))
    out = np.zeros(total_samples + overlap * n, dtype=np.float64)
    pos = 0
    for i, c in enumerate(clips):
        seg = c.astype(np.float64).copy()
        if i > 0:
            f = np.linspace(0.0, 1.0, overlap)
            seg[:overlap] *= f
            out[pos:pos + overlap] *= (1.0 - f)
        end = min(len(out), pos + len(seg))
        out[pos:end] += seg[:end - pos]
        pos += len(seg) - overlap
    return out[:total_samples]


def place(base, clip, start_sec, gain, fade=0.15):
    """폴리 클립을 base 트랙의 특정 시각에 게인 적용해 얹는다."""
    s = int(start_sec * SR)
    c = clip.astype(np.float64) * gain
    f = int(fade * SR)
    if len(c) > 2 * f:
        c[:f] *= np.linspace(0, 1, f)
        c[-f:] *= np.linspace(1, 0, f)
    e = min(len(base), s + len(c))
    base[s:e] += c[:e - s]
    return base


# ── 프롬프트: 짧게, 캡션체로 ──────────────────────────────────────────
AMB_PROMPT = "cafe ambience, murmuring crowd"
AMB_NEG = "music"

# 폴리는 구간별로 이벤트 하나씩. 여기가 시간대별 지시가 가능해지는 지점이다.
# ⚠ gain 출발점은 1.0~2.0. 배경 RMS가 0.10~0.14인데 폴리 원본은 0.009~0.017이라
#   게인 0.3을 곱하면 배경보다 30배 작아져 완전히 묻힌다(실측).
FOLEY = [
    {"seg": 2, "at": 5.06, "prompt": "ceramic cup set down on wooden table", "gain": 1.2},
    {"seg": 5, "at": 20.24, "prompt": "ceramic cup picked up from table", "gain": 1.0},
]

if __name__ == "__main__":
    cid = str(uuid.uuid4())
    amb_folder = os.path.join(INPUT_ROOT, "mmamb")
    print("=== 1) 앰비언스 레이어 (mask_away_clip=ON, %d x %.0f초) ===" % (AMB_N, AMB_LEN), flush=True)
    amb_clips = []
    for i in range(AMB_N):
        amb_clips.append(gen(amb_folder, AMB_PROMPT, AMB_NEG, AMB_LEN, True,
                             4200 + i * 37, "amb_%d" % i, cid))

    total_samples = int(TOTAL * SR)
    bed = crossfade_chain(amb_clips, total_samples)

    print("=== 2) 폴리 레이어 (구간별, mask_away_clip=OFF) ===", flush=True)
    for f in FOLEY:
        folder = os.path.join(INPUT_ROOT, "mmseg%02d" % f["seg"])
        if not os.path.isdir(folder):
            print("  (skip seg%02d — 프레임 폴더 없음)" % f["seg"], flush=True)
            continue
        clip = gen(folder, f["prompt"], AMB_NEG, 5.08, False, 9100 + f["seg"], "foley_s%02d" % f["seg"], cid)
        bed = place(bed, clip, f["at"], f["gain"])

    peak = float(np.max(np.abs(bed))) or 1.0
    bed = bed / peak * 0.89
    out = os.path.join(OUT, "mix30.flac")
    sf.write(out, bed.astype(np.float32), SR)
    a = np.abs(bed)
    k = 15
    rms = [float(np.sqrt((a[i * len(a) // k:(i + 1) * len(a) // k] ** 2).mean())) for i in range(k)]
    print("=== 믹스 완료 %s  %.2f초 ===" % (out, len(bed) / SR))
    print("2초 RMS:", " ".join("%.3f" % r for r in rms))
    print("변동폭 %.2f배" % (max(rms) / max(1e-6, min(rms))))
