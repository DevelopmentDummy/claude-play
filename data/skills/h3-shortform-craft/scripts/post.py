# 타임라인 전체 후처리 — 컷마다 따로 입히지 않고 완성 드래프트 위에 한 번에.
# 톤(그레이딩·그레인·비네트)은 전 구간 동일, 강조 효과는 포인트에서만 "슈욱(0.15s) 들어왔다 후욱(0.4s) 빠지는" 엔벌로프로.
# 자막은 후처리 뒤에 얹는다(자막이 할레이션에 번지지 않게). 렌더는 sub_burn=false 로 뽑은 것을 입력으로 쓴다.
# 사용: python scripts/post.py <cfg.json>   (세션 루트 cwd)
#   cfg = { src, out, srt, ass, accents:[{t, hold?, burn?:'left'|'right'|'top', flare?:y비율, bokeh?:개수, ca?:true}],
#           bgm?, bgm_db?(기본 -16), width?(1080), height?(1920), fps?(30), sub_size?(84), sub_outline?(6), sub_bold?(true), sub_mv?(420), bw?(false, 흑백 필름), grain?(6), titles?:[{text,start,end,size?}], styles?:[ASS Style 줄], events?:[ASS Dialogue 줄] }
#   src = render.mjs(sub_burn=false) 결과, srt = 그 렌더의 사이드카 자막, ass = 변환한 자막을 쓸 경로(세션 기준 상대경로, ':' '\' 없이).
#   stdout: {"ok": true, "out": …, "dur": …}
import json, math, random, re, subprocess, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

OW, OH, FPS = 540, 960, 30  # 오버레이는 출력의 반 해상도로 그리고 올려서 합성(어차피 흐린 빛). cfg width/height/fps 로 바뀐다
ATK, REL = 0.15, 0.4

def dur(p): return float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p], capture_output=True, text=True).stdout)
def smooth(x): x = min(1, max(0, x)); return x * x * (3 - 2 * x)
def env(t, t0, hold):
    if t < t0 - ATK or t > t0 + hold + REL: return 0.0
    if t < t0: return smooth((t - (t0 - ATK)) / ATK)
    if t <= t0 + hold: return 1.0
    return 1 - smooth((t - t0 - hold) / REL)
def env_expr(accs, gain):
    if not accs: return '0'
    parts = []
    for a in accs:
        t0, h = a['t'], a.get('hold', 0.5)
        parts.append(f"if(between(T,{t0-ATK:.3f},{t0:.3f}),(T-{t0-ATK:.3f})/{ATK},if(between(T,{t0:.3f},{t0+h:.3f}),1,if(between(T,{t0+h:.3f},{t0+h+REL:.3f}),1-(T-{t0+h:.3f})/{REL},0)))")
    e = parts[0]
    for p in parts[1:]: e = f"max({e},{p})"
    return f"({e})*{gain}"

def overlay(accs, D, seed=5):
    rnd = random.Random(seed); n = round(D * FPS); frames = []
    boks = {i: [(rnd.uniform(-0.1, 1.1) * OW, rnd.uniform(0, 1) * OH, rnd.uniform(34, 80), rnd.uniform(-12, 12), rnd.uniform(-20, -8),
                 rnd.choice([(255, 214, 190), (255, 196, 214), (236, 226, 255)])) for _ in range(a.get('bokeh', 0))] for i, a in enumerate(accs)}
    for f in range(n):
        t = f / FPS; layer = np.zeros((OH, OW, 3), np.float32)
        for i, a in enumerate(accs):
            k = env(t, a['t'], a.get('hold', 0.5))
            if k <= 0: continue
            if boks[i]:
                img = Image.new('RGB', (OW, OH)); d = ImageDraw.Draw(img)
                for (x, y, r, vx, vy, c) in boks[i]:
                    cx, cy = x + vx * t, (y + vy * t * 3) % OH; al = 0.2 * k
                    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=tuple(int(v * al) for v in c), outline=tuple(int(v * al * 1.6) for v in c), width=2)
                layer += np.asarray(img.filter(ImageFilter.GaussianBlur(3)), np.float32)
            if a.get('flare'):
                y0 = int(a['flare'] * OH); x0 = 0.5 * OW + 25 * math.sin(t * 1.3); kk = 0.85 * k
                xs = np.arange(OW, dtype=np.float32); prof = np.exp(-((xs - x0) / (OW * 0.6)) ** 2)
                for dy, w in [(0, 1), (1, .6), (-1, .6), (2, .25), (-2, .25)]:
                    if 0 <= y0 + dy < OH: layer[y0 + dy] += np.stack([150 * prof, 185 * prof, 255 * prof], -1) * kk * w
                core = Image.new('L', (OW, OH)); ImageDraw.Draw(core).ellipse([x0 - 22, y0 - 12, x0 + 22, y0 + 12], fill=int(255 * kk))
                layer += np.asarray(core.filter(ImageFilter.GaussianBlur(11)), np.float32)[..., None] * np.array([.8, .85, 1.], np.float32)
            if a.get('burn'):
                x = min(1, max(0, (t - (a['t'] - ATK)) / (ATK + a.get('hold', 0.5) + REL))); side = a['burn']
                g = Image.new('RGB', (OW, OH)); gd = ImageDraw.Draw(g); reach = smooth(x) * 1.1
                if side == 'left': cx, cy = -OW * .3 + reach * OW * .9, OH * .35
                elif side == 'right': cx, cy = OW * 1.3 - reach * OW * .9, OH * .6
                else: cx, cy = OW * .5, -OH * .3 + reach * OH * .7
                for rr, col in [(OW * .9, (255, 120, 60)), (OW * .55, (255, 175, 110)), (OW * .3, (255, 235, 200))]:
                    gd.ellipse([cx - rr, cy - rr * 1.4, cx + rr, cy + rr * 1.4], fill=tuple(int(v * k * .5 * .45) for v in col))
                layer += np.asarray(g.filter(ImageFilter.GaussianBlur(50)), np.float32)
        frames.append(np.clip(layer, 0, 255).astype(np.uint8))
    return frames

def srt_to_ass(srt, ass, W=1080, H=1920, size=84, outline=6, bold=-1, mv=420):
    txt = open(srt, encoding='utf-8-sig').read().strip()
    ev = []
    for blk in re.split(r'\n\s*\n', txt):
        ls = blk.strip().splitlines()
        if len(ls) < 3: continue
        a, b = [x.strip().replace(',', '.')[:-1] for x in ls[1].split('-->')]
        ev.append(f"Dialogue: 0,{a[1:] if a.startswith('0') and len(a)>10 else a},{b[1:] if b.startswith('0') and len(b)>10 else b},Cap,,0,0,0,,{'\\N'.join(ls[2:])}")
    head = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {W}
PlayResY: {H}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Malgun Gothic,{size},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,{bold},0,0,0,100,100,0,0,1,{outline},2,2,90,90,{mv},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    open(ass, 'w', encoding='utf-8').write(head + '\n'.join(ev) + '\n')

if __name__ == '__main__':
    j = json.load(open(sys.argv[1], encoding='utf-8'))
    src, out, accs = j['src'], j['out'], j['accents']
    VW, VH = int(j.get('width', 1080)), int(j.get('height', 1920))
    OW, OH, FPS = VW // 2, VH // 2, int(j.get('fps', 30))
    D = dur(src)
    srt_to_ass(j['srt'], j['ass'], size=j.get('sub_size', 84), outline=j.get('sub_outline', 6), bold=-1 if j.get('sub_bold', True) else 0, mv=j.get('sub_mv', 420))
    if j.get('titles'):  # 상단 타이틀(훅 문구 등): [{text, start, end, size?}]
        A = open(j['ass'], encoding='utf-8').read()
        sty = f"Style: Title,Malgun Gothic,{j['titles'][0].get('size', 76)},&H00FFFFFF,&H000000FF,&H00000000,&H90000000,-1,0,0,0,100,100,0,0,3,14,0,8,60,60,260,1\n"
        A = A.replace('\n[Events]', '\n' + sty + '\n[Events]', 1)
        fmt = lambda x: f"{int(x//3600)}:{int(x%3600//60):02d}:{x%60:05.2f}"
        A += ''.join(f"Dialogue: 1,{fmt(t['start'])},{fmt(t['end'])},Title,,0,0,0,,{t['text']}\n" for t in j['titles'])
        open(j['ass'], 'w', encoding='utf-8').write(A)
    if j.get('styles') or j.get('events'):  # 커스텀 ASS 스타일/이벤트(잡지 타이포 등): styles=["Style: …"], events=["Dialogue: …"]
        A = open(j['ass'], encoding='utf-8').read()
        if j.get('styles'): A = A.replace('\n[Events]', '\n' + '\n'.join(j['styles']) + '\n\n[Events]', 1)
        if j.get('events'): A += '\n'.join(j['events']) + '\n'
        open(j['ass'], 'w', encoding='utf-8').write(A)
    hal = env_expr(accs, 0.28)
    fc = [
        ("[0:v]hue=s=0,eq=contrast=1.12,curves=all='0/0.04 0.5/0.5 1/0.96',format=gbrp,split=2[b0][h0]" if j.get('bw') else
         "[0:v]colorbalance=rs=-0.03:bs=0.04:rh=0.05:gh=0.02:bh=-0.02,curves=all='0/0.035 0.5/0.52 1/0.97',eq=saturation=0.93,format=gbrp,split=2[b0][h0]"),
        "[h0]curves=all='0/0 0.82/0 1/1',gblur=sigma=26,colorchannelmixer=rr=1:gg=0.9:bb=0.8[h1]",
        f"[b0][h1]blend=all_expr='A+((255-(255-A)*(255-B)/255)-A)*{hal}'[g1]",
    ]
    cur = '[g1]'
    for i, a in enumerate([a for a in accs if a.get('ca')]):
        fc.append(f"{cur}rgbashift=rh=-5:bh=5:enable='between(t\\,{a['t']:.3f}\\,{a['t']+0.1:.3f})'[ca{i}]"); cur = f'[ca{i}]'
    fc.append(f"[1:v]scale={VW}:{VH},format=gbrp[ov];{cur}[ov]blend=all_mode=screen:shortest=1,noise=alls={int(j.get('grain', 6))}:allf=t,vignette=angle=PI/5,format=yuv420p,subtitles='{j['ass']}'[v]")
    frames = overlay(accs, D)
    extra_in, amap, acodec = [], ['-map', '0:a'], ['-c:a', 'copy']
    if j.get('bgm'):  # BGM: 반복·페이드 후 대사(원음)를 사이드체인으로 덕킹, 최종 -14 LUFS
        bdb = j.get('bgm_db', -16)
        extra_in = ['-stream_loop', '-1', '-i', j['bgm']]
        fc.append(f"[2:a]atrim=0:{D:.3f},asetpts=PTS-STARTPTS,acompressor=threshold=-24dB:ratio=4:attack=5:release=120:makeup=6,volume={bdb}dB,afade=t=in:st=0:d=0.3,afade=t=out:st={max(0, D-1.5):.3f}:d=1.5,aformat=channel_layouts=stereo:sample_rates=48000[bg]")
        fc.append("[0:a]aformat=channel_layouts=stereo:sample_rates=48000,asplit=2[dl][sc]")
        fc.append("[bg][sc]sidechaincompress=threshold=0.02:ratio=8:attack=15:release=350:makeup=1[bgd]")
        fc.append("[dl][bgd]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[a]")
        amap, acodec = ['-map', '[a]'], ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000']
    p = subprocess.Popen(['ffmpeg', '-loglevel', 'error', '-y', '-i', src, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{OW}x{OH}', '-r', str(FPS), '-i', '-'] + extra_in + [
                          '-filter_complex', ';'.join(fc), '-map', '[v]'] + amap + ['-c:v', 'libx264', '-crf', '18', '-preset', 'medium'] + acodec + ['-t', f'{D:.3f}', out], stdin=subprocess.PIPE)
    for fr in frames: p.stdin.write(fr.tobytes())
    p.stdin.close(); p.wait()
    if p.returncode: raise SystemExit('ffmpeg 실패')
    print(json.dumps({'ok': True, 'out': out, 'dur': dur(out)}))
