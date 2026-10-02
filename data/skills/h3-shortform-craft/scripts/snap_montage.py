# 착착착 스냅 몬타주 — 서로 다른 순간의 스틸(이미지 또는 짧은 클립의 한 프레임)을 길게→짧게 넘기며 장마다 틸트.
# 사용: python snap_montage.py <출력.mp4> <holds JSON> <angles JSON> <소스1> <소스2> …   (소스 수 = holds 길이)
#   소스: .png/.jpg 이미지 또는 .mp4(가운데 프레임 사용). holds는 24fps 프레임 수(예 [14,12,11,10,9,8,7,6]), angles는 도(마지막 0 권장).
#   stdout: 장이 바뀌는 시각(초) JSON — 셔터 틱 효과음 배치에 쓴다.
import json, subprocess, sys
import numpy as np
from PIL import Image

out, holds, angs, srcs = sys.argv[1], json.loads(sys.argv[2]), json.loads(sys.argv[3]), sys.argv[4:]
assert len(srcs) == len(holds) == len(angs), "소스·holds·angles 개수가 같아야 한다"

def frame(p):
    if p.lower().endswith(('.png', '.jpg', '.jpeg', '.webp')): return Image.open(p).convert('RGB')
    n = int(subprocess.run(['ffprobe', '-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', p],
                           capture_output=True, text=True).stdout.strip() or 1)
    raw = subprocess.run(['ffmpeg', '-loglevel', 'error', '-i', p, '-vf', f"select='eq(n\\,{n // 2})'", '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-'], capture_output=True).stdout
    from io import BytesIO
    return Image.open(BytesIO(raw)).convert('RGB')

first = frame(srcs[0]); W, H = first.size; W -= W % 2; H -= H % 2
SH = [(-10, 6), (12, -8), (-6, -10), (8, 10), (-12, 4), (6, -6), (-8, 8), (10, 4), (-4, -6), (6, 6), (-6, 2), (4, -4)]
p = subprocess.Popen(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', '24', '-i', '-',
                      '-c:v', 'libx264', '-crf', '14', '-pix_fmt', 'yuv420p', out], stdin=subprocess.PIPE)
t, changes = 0, []
for k, (src, h, a) in enumerate(zip(srcs, holds, angs)):
    im = (first if k == 0 else frame(src)).resize((W, H)); changes.append(round(t / 24, 4))
    s = 1.14; dx, dy = SH[k % len(SH)] if a else (0, 0)            # 4.5° 틸트에도 모서리가 비지 않는 배율
    im = im.resize((int(W * s), int(H * s)), Image.LANCZOS).rotate(a, resample=Image.BICUBIC, center=(W * s / 2 + dx, H * s / 2 + dy))
    L, T = (im.width - W) // 2, (im.height - H) // 2; b = im.crop((L, T, L + W, T + H)).tobytes()
    for _ in range(h): p.stdin.write(b)
    t += h
p.stdin.close(); p.wait()
print(json.dumps(changes))
