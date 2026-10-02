# -*- coding: utf-8 -*-
"""완성된 mp4를 ESRGAN 계열 모델로 프레임 단위 업스케일한다(오디오 보존).

사용법 (ComfyUI venv 파이썬으로):
    python video_esrgan_upscale.py <in.mp4> <out.mp4> [model=4x-UltraSharp.pth] [target_w=2304] [target_h=1280]

- 모델 배율로 확대 후 target 해상도로 lanczos 축소(4x 모델의 과선예를 눌러줌).
- ffmpeg 파이프로 raw RGB를 주고받아 중간 PNG를 만들지 않는다.
- 원본 오디오 트랙은 무재인코딩 복사.
"""
import sys, subprocess, json, os
import numpy as np, torch
import torch.nn.functional as F
from spandrel import ModelLoader

src, dst = sys.argv[1], sys.argv[2]
model_name = sys.argv[3] if len(sys.argv) > 3 else "4x-UltraSharp.pth"
tw = int(sys.argv[4]) if len(sys.argv) > 4 else 2304
th = int(sys.argv[5]) if len(sys.argv) > 5 else 1280
MODEL_DIR = os.environ.get("COMFYUI_UPSCALE_DIR", r"F:\repositories\comfyui\models\upscale_models")

info = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                                            "stream=width,height,r_frame_rate", "-of", "json", src]))["streams"][0]
w, h, fps = info["width"], info["height"], info["r_frame_rate"]

model = ModelLoader().load_from_file(os.path.join(MODEL_DIR, model_name)).cuda().eval().half()

dec = subprocess.Popen(["ffmpeg", "-v", "error", "-i", src, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{tw}x{th}", "-r", fps,
                        "-i", "-", "-i", src, "-map", "0:v", "-map", "1:a?", "-c:v", "libx264", "-crf", "16", "-preset", "slow",
                        "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart", dst], stdin=subprocess.PIPE)
n, fsz = 0, w * h * 3
with torch.inference_mode():
    while True:
        buf = dec.stdout.read(fsz)
        if len(buf) < fsz:
            break
        x = torch.from_numpy(np.frombuffer(buf, np.uint8).reshape(h, w, 3).copy()).cuda().permute(2, 0, 1)[None].half() / 255
        y = model(x)
        y = F.interpolate(y.float(), size=(th, tw), mode="bicubic", antialias=True).clamp(0, 1)
        enc.stdin.write((y[0].permute(1, 2, 0) * 255).round().byte().cpu().numpy().tobytes())
        n += 1
enc.stdin.close(); enc.wait(); dec.wait()
print(f"OK {n} frames {w}x{h} -> {tw}x{th} model={model_name} -> {dst}")
