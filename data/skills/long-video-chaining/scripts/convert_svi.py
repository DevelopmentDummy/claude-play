# -*- coding: utf-8 -*-
"""SVI LoRA(PEFT 포맷) → ComfyUI 네이티브 LoRA 포맷 변환

SVI      : blocks.0.cross_attn.k.lora_A.default.weight
네이티브 : diffusion_model.blocks.0.cross_attn.k.lora_down.weight

lora_A=down, lora_B=up. alpha 키는 SVI에 없으므로 rank 값으로 생성해
scale = alpha/rank = 1.0 이 되도록 맞춘다.
"""
import os, torch
from safetensors.torch import load_file, save_file

LORA_DIR = r"F:\repositories\comfyui\comfyui_submodule\models\loras"
SRC = os.path.join(LORA_DIR, "version-2.0")

for tag in ("high", "low"):
    src = os.path.join(SRC, "SVI_Wan2.2-I2V-A14B_%s_noise_lora_v2.0_pro.safetensors" % tag)
    dst = os.path.join(LORA_DIR, "SVI_v20pro_%s_noise_comfy.safetensors" % tag)
    sd = load_file(src)
    out, ranks = {}, {}
    for k, v in sd.items():
        base = k
        if base.endswith(".lora_A.default.weight"):
            nk = "diffusion_model." + base[:-len(".lora_A.default.weight")] + ".lora_down.weight"
            ranks["diffusion_model." + base[:-len(".lora_A.default.weight")]] = v.shape[0]
        elif base.endswith(".lora_B.default.weight"):
            nk = "diffusion_model." + base[:-len(".lora_B.default.weight")] + ".lora_up.weight"
        else:
            print("  skip unexpected key:", k[:70]); continue
        out[nk] = v.contiguous()
    for prefix, r in ranks.items():
        out[prefix + ".alpha"] = torch.tensor(float(r))
    save_file(out, dst)
    print("%s: %d -> %d keys, rank=%s, %.2f GB" %
          (os.path.basename(dst), len(sd), len(out),
           sorted(set(ranks.values())), os.path.getsize(dst) / 1e9))
