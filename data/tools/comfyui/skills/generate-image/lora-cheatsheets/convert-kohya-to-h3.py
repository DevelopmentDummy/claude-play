# -*- coding: utf-8 -*-
"""kohya 포맷 H3 LoRA -> H3 네이티브(diffusers) 포맷 변환기.

MiniMaxH3TurboLoRA 노드는 `blocks.0.attn.out_proj.lora_A.weight` 형식만 읽는다.
kohya(sd-scripts/musubi) 산출물은 `lora_unet_blocks_0_attn_out_proj.lora_down.weight`
형식이라 모듈이 0개 매칭되고, 에러 없이 조용히 무시된다.

언더스코어를 점으로 되돌리는 건 모호하므로(out_proj 안의 _ 와 구분자 _ 가 같다),
이미 네이티브 포맷인 LoRA(터보 등)의 모듈 목록을 역맵 정답지로 쓴다.

사용법:
    python convert-kohya-to-h3.py <src.safetensors> [ref.safetensors] [dst.safetensors]
"""
import sys, os
from safetensors.torch import load_file, save_file
from safetensors import safe_open

LORA_DIR = os.environ.get("COMFYUI_LORA_DIR", r"F:\repositories\comfyui\models\loras")
DEFAULT_REF = "minimax_h3_turbo_v4_step600_ema.safetensors"


def resolve(p):
    return p if os.path.isabs(p) else os.path.join(LORA_DIR, p)


def main():
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(1)
    src = resolve(sys.argv[1])
    ref = resolve(sys.argv[2] if len(sys.argv) > 2 else DEFAULT_REF)
    dst = resolve(sys.argv[3]) if len(sys.argv) > 3 else src.replace(".safetensors", "_h3fmt.safetensors")

    with safe_open(ref, framework="pt") as f:
        ref_mods = {k.rsplit(".lora_", 1)[0] for k in f.keys()}
    rev = {m.replace(".", "_"): m for m in ref_mods}

    with safe_open(src, framework="pt") as f:
        meta = f.metadata() or {}
    sd = load_file(src)

    out, alphas, unmapped = {}, {}, []
    for k, v in sd.items():
        if k.endswith(".alpha"):
            alphas[k[: -len(".alpha")]] = float(v.item()); continue
        mod, _, tail = k.rpartition(".lora_")
        flat = mod[len("lora_unet_"):] if mod.startswith("lora_unet_") else mod
        dotted = rev.get(flat)
        if dotted is None:
            unmapped.append(k); continue
        if tail == "down.weight":
            out[dotted + ".lora_A.weight"] = v
        elif tail == "up.weight":
            out[dotted + ".lora_B.weight"] = (mod, v)  # alpha 스케일 적용 후 확정
        else:
            unmapped.append(k)

    if unmapped:
        print("UNMAPPED:", len(unmapped), unmapped[:5]); sys.exit(1)

    # alpha != dim 이면 lora_B에 alpha/dim 을 곱해 흡수한다(네이티브 포맷엔 alpha가 없다).
    scaled = 0
    for key, val in list(out.items()):
        if not isinstance(val, tuple):
            continue
        mod, v = val
        a = alphas.get(mod)
        dim = out[key.replace(".lora_B.", ".lora_A.")].shape[0]
        if a is not None and abs(a - dim) > 1e-6:
            v = v * (a / dim); scaled += 1
        out[key] = v

    meta2 = {k: v for k, v in meta.items() if isinstance(v, str)}
    meta2["converted_from"] = "kohya (lora_unet_*/lora_down/lora_up) -> H3 native (dotted/lora_A/lora_B)"
    meta2["converted_ref"] = os.path.basename(ref)
    save_file(out, dst, metadata=meta2)
    print(f"OK: {len(sd)} keys -> {len(out)} keys / 모듈 {len(out)//2}개"
          f" / alpha 스케일 흡수 {scaled}개\n  -> {dst}")


if __name__ == "__main__":
    main()
