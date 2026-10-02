# 앰비언트 독립 채널 — 여러 클립의 앰비언트(빗소리·거리 소음 등) 구간을 크로스페이드로 이어 붙여 하나의 베드로 만든다(같은 소리 반복 없음).
# 사용: python ambient_bed.py <출력.wav> <총 길이초> <클립[:시작초]> [클립[:시작초] …] [--xfade 1.0] [--rms 0.05] [--fade 1.2,2.0]
#   예: python ambient_bed.py bgm/rain_bed.wav 28.5 images/p007/w1.mp4:0.2 images/p007/w2.mp4:0.2 images/p007/w3.mp4:0.2
#   대사가 섞인 구간은 넣지 않는다. 대사는 따로 잘라 믹스에 얹는다.
import subprocess, sys
import numpy as np, soundfile as sf

SR = 48000; args = sys.argv[1:]; opts = {'--xfade': '1.0', '--rms': '0.05', '--fade': '1.2,2.0'}
for k in list(opts):
    if k in args: i = args.index(k); opts[k] = args[i + 1]; del args[i:i + 2]
out, D, clips = args[0], float(args[1]), args[2:]
def aud(spec):
    p, a = (spec.rsplit(':', 1) + ['0'])[:2] if ':' in spec[2:] else (spec, '0')
    raw = subprocess.run(['ffmpeg', '-loglevel', 'error', '-ss', a, '-i', p, '-vn', '-ac', '2', '-ar', str(SR), '-f', 'f32le', '-'], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32).reshape(-1, 2).copy()
X = int(float(opts['--xfade']) * SR); parts = [aud(c) for c in clips]; bed = parts[0]
while len(bed) < int(D * SR) and len(parts) > 1:
    for p in parts[1:] + parts:  # 모자라면 처음부터 다시(그래도 시작점이 달라 반복감이 적다)
        f = np.linspace(0, 1, X)[:, None]; bed = np.concatenate([bed[:-X], bed[-X:] * (1 - f) + p[:X] * f, p[X:]])
        if len(bed) >= int(D * SR): break
N = int(D * SR); bed = bed[:N] if len(bed) >= N else np.pad(bed, ((0, N - len(bed)), (0, 0)))
bed = bed / max(float(np.sqrt((bed ** 2).mean())), 1e-6) * float(opts['--rms'])
fi, fo = [int(float(x) * SR) for x in opts['--fade'].split(',')]
env = np.ones(N); env[:fi] = np.linspace(0, 1, fi); env[-fo:] = np.linspace(1, 0, fo); bed *= env[:, None]
sf.write(out, bed, SR); print(out, round(N / SR, 3))
