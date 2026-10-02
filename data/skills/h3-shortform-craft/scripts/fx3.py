# 고급 화보 룩 — 카메라는 현란하게, 효과는 절제된 광학 효과로.
#  카메라: push(단방향 푸시인) · hit(포인트 스냅인 유지) · shake · whip(컷 진입 방향 모션블러)
#  광학/그레이딩: 하이라이트만 번지는 할레이션 · 크림톤 스플릿 그레이딩 · 필름 그레인 · 비네트 · 미세 색수차(hit 순간만)
#  애니메이션 오버레이(numpy): anamorphic(가로 플레어 스트릭) · bokeh(큰 원형 디포커스 보케) · burn(필름 번 라이트릭이 번져 들어옴)
# 사용: python scripts/fx3.py <cfg.json>   (세션 루트 cwd)
#   cfg = [[shot_id, src, out, {옵션}], …]  → stdout: [[shot_id, out, dur], …]
#   옵션: push(비율) · hit([t0, 배율, cx, cy]) · shake([a, b, amp]) · whip(1) · flash_in/flash_out(초) ·
#         halation · ca([[a, b, px]]) · anamorphic([{y, x, a, t0}]) · bokeh(개수) · burn([{t, d, side, a}]) · camera_only
#   camera_only:true → 카메라(push/hit/shake/whip)와 flash 만 적용. 톤·광학 효과는 post.py 가 타임라인 전체에 입힌다(현행 파이프라인).
#   작업 해상도 W×H 는 소스 해상도를 ffprobe 로 읽어 정한다(480×832 드래프트, 640×1152 파이널 모두 그대로). 환경변수 FX_SIZE=640x1152 로 강제할 수 있다.
import json, math, os, random, subprocess, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

W, H, FPS = 480, 832, 24

def probe_size(p):
    if os.environ.get('FX_SIZE'):
        w, h = os.environ['FX_SIZE'].lower().split('x'); return int(w), int(h)
    s = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', p], capture_output=True, text=True).stdout.strip().split(',')
    return int(s[0]), int(s[1])

def dur(p):
    return float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p], capture_output=True, text=True).stdout)

def smooth(x): x = min(1, max(0, x)); return x * x * (3 - 2 * x)

def overlay_frames(o, D, seed):
    rnd = random.Random(seed)
    n = max(1, round(D * FPS))
    bok = [(rnd.uniform(-0.1, 1.1) * W, rnd.uniform(0, 1) * H, rnd.uniform(28, 70), rnd.uniform(-10, 10), rnd.uniform(-18, -6),
            rnd.choice([(255, 214, 190), (255, 190, 210), (240, 225, 255)])) for _ in range(o.get('bokeh', 0))]
    out = []
    for f in range(n):
        t = f / FPS
        img = Image.new('RGB', (W, H)); d = ImageDraw.Draw(img)
        for (x, y, r, vx, vy, c) in bok:  # 보케: 크고 흐린 원, 천천히 흐름, 가장자리가 약간 밝은 렌즈 디스크
            cx, cy = x + vx * t, (y + vy * t * 3) % H
            a = 0.16 + 0.06 * math.sin(t * 2 + x)
            d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=tuple(int(v * a) for v in c), outline=tuple(int(v * a * 1.6) for v in c), width=2)
        img = img.filter(ImageFilter.GaussianBlur(3))
        layer = np.asarray(img, np.float32)
        for fl in o.get('anamorphic', []):  # 가로 플레어: 광원 높이에 얇고 긴 스트릭, 천천히 숨쉬듯
            y0 = int(fl.get('y', 0.2) * H); x0 = fl.get('x', 0.5) * W + 20 * math.sin(t * 1.3)
            k = fl.get('a', 0.55) * (0.75 + 0.25 * math.sin(t * 3.1)) * smooth((t - fl.get('t0', 0)) / 0.25)
            if k <= 0: continue
            xs = np.arange(W, dtype=np.float32)
            prof = np.exp(-((xs - x0) / (W * 0.55)) ** 2)
            for dy, w in [(0, 1.0), (1, 0.6), (-1, 0.6), (2, 0.25), (-2, 0.25)]:
                yy = y0 + dy
                if 0 <= yy < H:
                    layer[yy, :, 0] += 150 * k * w * prof; layer[yy, :, 1] += 185 * k * w * prof; layer[yy, :, 2] += 255 * k * w * prof
            core = Image.new('L', (W, H)); ImageDraw.Draw(core).ellipse([x0 - 18, y0 - 10, x0 + 18, y0 + 10], fill=int(255 * k))
            core = np.asarray(core.filter(ImageFilter.GaussianBlur(9)), np.float32)[..., None]
            layer += core * np.array([0.8, 0.85, 1.0], np.float32)
        for b in o.get('burn', []):  # 필름 번: 따뜻한 빛 덩어리가 화면 가장자리에서 번져 들어왔다가 빠짐
            x = (t - b['t']) / b.get('d', 0.6)
            if 0 <= x <= 1:
                a = math.sin(math.pi * x) * b.get('a', 0.8)
                side = b.get('side', 'left')
                g = Image.new('RGB', (W, H)); gd = ImageDraw.Draw(g)
                reach = smooth(x) * 1.1
                if side == 'left': cx, cy = -W * 0.3 + reach * W * 0.9, H * 0.35
                elif side == 'right': cx, cy = W * 1.3 - reach * W * 0.9, H * 0.6
                else: cx, cy = W * 0.5, -H * 0.3 + reach * H * 0.7
                for rr, col in [(W * 0.9, (255, 120, 60)), (W * 0.55, (255, 175, 110)), (W * 0.3, (255, 235, 200))]:
                    gd.ellipse([cx - rr, cy - rr * 1.4, cx + rr, cy + rr * 1.4], fill=tuple(int(v * a * 0.45) for v in col))
                layer += np.asarray(g.filter(ImageFilter.GaussianBlur(45)), np.float32)
        out.append(np.clip(layer, 0, 255).astype(np.uint8))
    return out

def build(src, out, o, seed):
    global W, H
    W, H = probe_size(src)
    D = dur(src); fc = []; cur = '[0:v]'
    if o.get('push'):
        p = o['push']
        fc.append(f"{cur}scale=w='trunc({W}*(1+{p}*t/{D:.3f})/2)*2':h='trunc({H}*(1+{p}*t/{D:.3f})/2)*2':eval=frame,crop={W}:{H}[c1]"); cur = '[c1]'
    if o.get('hit'):
        t0, z, cx, cy = o['hit']; cw = int(W / z) // 2 * 2; ch = int(H / z) // 2 * 2
        x = max(0, min(W - cw, int(cx * W - cw / 2))); y = max(0, min(H - ch, int(cy * H - ch / 2)))
        fc.append(f"{cur}split=2[h0][h1];[h0]trim=0:{t0},setpts=PTS-STARTPTS[ha];[h1]trim={t0},setpts=PTS-STARTPTS,crop={cw}:{ch}:{x}:{y},scale={W}:{H}:flags=lanczos,setsar=1[hb];[ha][hb]concat=n=2:v=1:a=0[c2]"); cur = '[c2]'
    if o.get('shake'):
        a, b, amp = o['shake']
        fc.append(f"{cur}scale={int(W*1.06)//2*2}:{int(H*1.06)//2*2},crop={W}:{H}:x='(iw-ow)/2+{amp}*sin(t*61)*between(t\\,{a}\\,{b})':y='(ih-oh)/2+{amp}*cos(t*47)*between(t\\,{a}\\,{b})'[c3]"); cur = '[c3]'
    if o.get('whip'):  # 컷 진입 0.12초 가로 모션블러 → 휙 들어오는 느낌
        fc.append(f"{cur}avgblur=sizeX=36:sizeY=1:enable='lt(t\\,0.08)',avgblur=sizeX=14:sizeY=1:enable='between(t\\,0.08\\,0.14)'[c4]"); cur = '[c4]'
    if not o.get('camera_only'):
        # 그레이딩: 크림톤 하이라이트 + 살짝 푸른 섀도 + 블랙 살짝 들어올림
        fc.append(f"{cur}colorbalance=rs=-0.03:bs=0.04:rh=0.05:gh=0.02:bh=-0.02,curves=all='0/0.035 0.5/0.52 1/0.97',eq=saturation=0.93[g0]"); cur = '[g0]'
        # 할레이션: 밝은 부분만 뽑아서 크게 번지게
        hv = o.get('halation', 0)
        if hv: fc.append(f"{cur}split=2[hb0][hl0];[hl0]curves=all='0/0 0.82/0 1/1',gblur=sigma=14,colorchannelmixer=rr=1:gg=0.9:bb=0.8[hl1];[hb0][hl1]blend=all_mode=screen:all_opacity={hv}[g1]"); cur = '[g1]' if hv else cur
        for i, (a, b, s) in enumerate(o.get('ca', [])):
            fc.append(f"{cur}rgbashift=rh=-{s}:bh={s}:enable='between(t\\,{a}\\,{b})'[ca{i}]"); cur = f'[ca{i}]'
        fc.append(f"{cur}fps=24,format=gbrp[base];[1:v]format=gbrp[ov];[base][ov]blend=all_mode=screen:shortest=1[g2]"); cur = '[g2]'
        fc.append(f"{cur}noise=alls=5:allf=t,vignette=angle=PI/5[g3]"); cur = '[g3]'
    if o.get('flash_in'): fc.append(f"{cur}fade=t=in:st=0:d={o['flash_in']}:color=white[fi]"); cur = '[fi]'
    if o.get('flash_out'): fc.append(f"{cur}fade=t=out:st={D-o['flash_out']:.3f}:d={o['flash_out']}:color=white[fo]"); cur = '[fo]'
    fc.append(f"{cur}format=yuv420p[v]")
    co = o.get('camera_only')
    frames = [] if co else overlay_frames(o, D, seed)
    extra = [] if co else ['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-']
    p = subprocess.Popen(['ffmpeg', '-loglevel', 'error', '-y', '-i', src] + extra + [
                          '-filter_complex', ';'.join(fc), '-map', '[v]', '-map', '0:a?', '-c:v', 'libx264', '-crf', '15', '-preset', 'fast', '-c:a', 'copy', '-t', f'{D:.3f}', out], stdin=subprocess.PIPE)
    for fr in frames: p.stdin.write(fr.tobytes())
    p.stdin.close(); p.wait()
    if p.returncode: raise SystemExit(f'ffmpeg 실패: {src}')
    return dur(out)

if __name__ == '__main__':
    cfg = json.load(open(sys.argv[1], encoding='utf-8'))
    print(json.dumps([[sid, out, round(build(src, out, o, k + 11), 3)] for k, (sid, src, out, o) in enumerate(cfg)]))
