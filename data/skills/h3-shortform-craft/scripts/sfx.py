# 효과음 합성 라이브러리(numpy). import 해서 쓰거나 CLI로 단발 wav를 만든다.
# CLI: python sfx.py <종류> <출력.wav> [게인]   종류: shutter tick squeak knock ding whoosh scratch boom
# 라이브러리: from sfx import place; place(track, 'shutter', t=1.35, gain=0.5, sr=48000)  (track: (N,) 또는 (N,2) float 배열)
import sys
import numpy as np
SR = 48000; rng = np.random.default_rng(7)
def _t(d, sr): return np.arange(int(d * sr)) / sr
def make(kind, gain=0.5, sr=SR):
    if kind == 'shutter':  # 찰-칵(두 번)
        n = int(0.03 * sr); q = np.arange(n) / sr; one = rng.standard_normal(n) * np.exp(-q * 170) + np.sin(2 * np.pi * 2200 * q) * np.exp(-q * 230) * 0.6
        s = np.zeros(int(0.1 * sr)); s[:n] += one; k = int(0.065 * sr); s[k:k + n] += one * 0.75; return s * gain
    if kind == 'tick':  # 타임랩스용 짧은 셔터
        q = _t(0.02, sr); return (rng.standard_normal(len(q)) * np.exp(-q * 300) * 0.7 + np.sin(2 * np.pi * 2600 * q) * np.exp(-q * 400) * 0.4) * gain
    if kind == 'squeak':  # 의자 바퀴 끼익
        q = _t(0.38, sr); f = 900 + 500 * q / 0.38 + 60 * np.sin(2 * np.pi * 23 * q); return np.sin(2 * np.pi * np.cumsum(f) / sr) * np.sin(np.pi * q / 0.38) ** 0.5 * gain * 0.7
    if kind == 'knock':  # 이마 콩 '딱'
        q = _t(0.12, sr); return (np.sin(2 * np.pi * 420 * q) * 0.6 + rng.standard_normal(len(q)) * 0.5) * np.exp(-q * 55) * gain
    if kind == 'ding':  # 잔 '팅'
        q = _t(0.5, sr); return (np.sin(2 * np.pi * 2650 * q) + 0.5 * np.sin(2 * np.pi * 5310 * q)) * np.exp(-q * 9) * gain * 0.5
    if kind == 'whoosh':  # 대역 제한 노이즈 휙
        q = _t(0.32, sr); x = rng.standard_normal(len(q)); F = np.fft.rfftfreq(len(q), 1 / sr)
        return np.fft.irfft(np.fft.rfft(x) * np.exp(-((F - 3000) / 2500) ** 2), len(q)) * np.sin(np.pi * q / 0.32) ** 2 * gain * 0.3
    if kind == 'scratch':  # 레코드 스크래치
        q = _t(0.32, sr); fr = np.interp(q, [0, 0.16, 0.32], [300, 1400, 200]); return (np.sin(2 * np.pi * np.cumsum(fr) / sr) * 0.5 + rng.standard_normal(len(q)) * 0.25) * np.exp(-q * 4) * gain
    if kind == 'boom':  # 드롭 서브 임팩트
        q = _t(0.7, sr); fq = 50 + 60 * np.exp(-q * 20); return np.sin(2 * np.pi * np.cumsum(fq) / sr) * np.exp(-q * 5) * gain
    raise ValueError(kind)
def place(track, kind, t, gain=0.5, sr=SR):
    s = make(kind, gain, sr); i = int(t * sr); j = min(len(track), i + len(s))
    if j <= i: return track
    if track.ndim == 2: track[i:j] += s[:j - i, None]
    else: track[i:j] += s[:j - i]
    return track
if __name__ == '__main__':
    import soundfile as sf
    kind, out = sys.argv[1], sys.argv[2]; g = float(sys.argv[3]) if len(sys.argv) > 3 else 0.5
    s = make(kind, g); sf.write(out, np.stack([s, s], 1), SR); print(out, round(len(s) / SR, 3))
