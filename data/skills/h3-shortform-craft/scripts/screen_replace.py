# 고정 캠 화면(모니터·TV·폰) 합성 — 사각형 안의 '꺼진 검은 화면'·'밤의 파란 화면' 픽셀만 루마 키로 골라 영상/이미지를 원근 변환해 얹는다.
# 사람(밝은 색)은 키에 안 걸리므로 화면 앞을 지나가는 팔·머리가 그대로 위에 남는다.
# 사용: python screen_replace.py <설정.json> <입력.mp4> <출력.mp4>
# 설정 예:
# {"plate_size": [640, 1152],                      # 사각형 좌표의 기준 해상도(보통 생성 해상도). 입력이 크면 자동 배율
#  "range": [3.5, 49.7],                            # 적용 구간(초). 생략하면 전체
#  "screens": [{"quad": [[80,538],[190,499],[192,553],[96,598]],   # TL, TR, BR, BL
#               "source": "images/renders/ep5.mp4",  # .mp4(반복 재생) 또는 이미지
#               "opacity": 0.92}],
#  "dark_luma": 48, "blue_margin": 25}
import json, subprocess, sys
import numpy as np, cv2

cfg, SRC, OUT = json.load(open(sys.argv[1], encoding='utf-8')), sys.argv[2], sys.argv[3]
probe = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'csv=p=0', SRC], capture_output=True, text=True).stdout.strip().split(',')
W, H = int(probe[0]), int(probe[1]); num, den = probe[2].split('/'); FPS = float(num) / float(den)
pw, ph = cfg.get('plate_size', [W, H]); kx, ky = W / pw, H / ph
T0, T1 = cfg.get('range', [0, 1e9]); DL, BM = cfg.get('dark_luma', 48), cfg.get('blue_margin', 25)

screens = []
for s in cfg['screens']:
    q = np.float32([[x * kx, y * ky] for x, y in s['quad']])
    src = s['source']; frames = None; img = None
    if src.lower().endswith(('.mp4', '.mov', '.webm')):
        raw = subprocess.run(['ffmpeg', '-loglevel', 'error', '-i', src, '-vf', 'fps=15,scale=480:-2', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'], capture_output=True).stdout
        sh = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', src], capture_output=True, text=True).stdout.strip().split(',')
        h480 = int(round(480 * int(sh[1]) / int(sh[0]) / 2) * 2); frames = np.frombuffer(raw, np.uint8).reshape(-1, h480, 480, 3)
    else:
        img = cv2.imread(src)
    m = np.zeros((H, W), np.uint8); cv2.fillConvexPoly(m, q.astype(np.int32), 255); m = cv2.erode(m, np.ones((5, 5), np.uint8))
    screens.append({'q': q, 'frames': frames, 'img': img, 'mask': m, 'op': s.get('opacity', 0.92)})

dec = subprocess.Popen(['ffmpeg', '-loglevel', 'error', '-i', SRC, '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'], stdout=subprocess.PIPE)
enc = subprocess.Popen(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{W}x{H}', '-r', f'{FPS}', '-i', '-', '-i', SRC,
                        '-map', '0:v', '-map', '1:a?', '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p', '-c:a', 'copy', OUT], stdin=subprocess.PIPE)
n = 0
while True:
    buf = dec.stdout.read(W * H * 3)
    if len(buf) < W * H * 3: break
    fr = np.frombuffer(buf, np.uint8).reshape(H, W, 3).copy(); t = n / FPS; n += 1
    if T0 <= t <= T1:
        g = cv2.cvtColor(fr, cv2.COLOR_BGR2GRAY); b, r = fr[..., 0].astype(int), fr[..., 2].astype(int)
        key = cv2.morphologyEx(((g < DL) | ((b > r + BM) & (b > 60))).astype(np.uint8) * 255, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        fade = min(1.0, (t - T0) / 0.25, (T1 - t) / 0.25)
        for s in screens:
            content = s['frames'][int(t * 15) % len(s['frames'])] if s['frames'] is not None else s['img']
            ch, cw = content.shape[:2]
            M = cv2.getPerspectiveTransform(np.float32([[0, 0], [cw, 0], [cw, ch], [0, ch]]), s['q'])
            warped = cv2.warpPerspective(content, M, (W, H))
            mask = cv2.GaussianBlur(cv2.bitwise_and(s['mask'], key), (5, 5), 0).astype(np.float32)[..., None] / 255 * s['op'] * fade
            fr = (fr * (1 - mask) + warped * mask).astype(np.uint8)
    enc.stdin.write(fr.tobytes())
enc.stdin.close(); enc.wait(); dec.wait()
print(json.dumps({'ok': True, 'frames': n, 'out': OUT}))
