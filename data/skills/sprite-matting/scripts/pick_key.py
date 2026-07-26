"""레퍼런스 이미지에서 크로마 키 색을 자동 선정한다.

캐릭터가 쓰지 않는 색상 구간을 찾아 그 한가운데를 키 컬러로 잡는다.
반환값은 (hex, 색상각, 리포트) — hex는 Qwen 배경 교체 프롬프트와
ChromaKeyUnmix의 key_color_hex에 그대로 넣으면 된다.
"""
import numpy as np, colorsys
from PIL import Image

def pick(path, bins=72, sat_min=0.22, val_min=0.15, band=5):
    im = Image.open(path).convert('RGB')
    im.thumbnail((512, 512))
    a = np.array(im).astype(np.float32) / 255
    # 흰/무채 배경 제외
    mask = ~((a.min(axis=2) > 0.92) & ((a.max(axis=2) - a.min(axis=2)) < 0.06))
    px = a[mask]
    hsv = np.array([colorsys.rgb_to_hsv(*p) for p in px])
    h, s, v = hsv[:, 0] * 360, hsv[:, 1], hsv[:, 2]
    sel = (s > sat_min) & (v > val_min)
    hist, edges = np.histogram(h[sel], bins=bins, range=(0, 360))
    # 원형이므로 wrap 하여 band 폭 윈도우 합이 최소인 지점
    ext = np.concatenate([hist, hist[:band]])
    sums = np.array([ext[i:i + band].sum() for i in range(bins)])
    i = int(sums.argmin())
    center = (edges[i] + band * (360 / bins) / 2) % 360
    r, g, b = colorsys.hsv_to_rgb(center / 360, 1.0, 1.0)
    hexs = '%02X%02X%02X' % (int(r * 255), int(g * 255), int(b * 255))
    top = np.argsort(sums)[:3]
    report = {
        'hue': round(float(center), 1),
        'hex': hexs,
        'occupied_px': int(sums[i]),
        'total_saturated_px': int(sel.sum()),
        'runner_ups': [(round(float((edges[j] + band * (360 / bins) / 2) % 360), 1), int(sums[j])) for j in top[1:]],
    }
    return hexs, center, report

def prompt(hexs):
    return (f"Replace the background with a completely flat, uniform, solid #{hexs} color. "
            "Keep the character exactly as she is - same pose, same colors, same outfit, "
            "same hair colors, same lineart, same proportions. Do not tint the character. "
            "The background must be a single flat color with no gradient, no shading, "
            "no shadow under her feet.")

if __name__ == '__main__':
    import sys
    hexs, hue, rep = pick(sys.argv[1])
    print(rep)
    print()
    print(prompt(hexs))
