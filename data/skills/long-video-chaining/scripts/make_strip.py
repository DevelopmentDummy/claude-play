#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""세그먼트별 마지막 프레임을 가로로 이어 붙인 비교 스트립 생성.

수치만으로는 "대비 std 급락"이 안정화인지 붕괴인지 구분할 수 없다.
반드시 이 스트립을 눈으로 확인하고 판정하라.

usage:
    python make_strip.py <runs_dir> <out.png> [variant:label ...]

예:
    python make_strip.py ./runs compare.png A:반복프롬프트 C:진행형 D:진행형+색앵커
"""
import os
import sys

from PIL import Image, ImageDraw, ImageSequence

SCALE = 0.30
LABEL_W = 140


def load_lasts(runs_dir, prefix, max_seg=12):
    out = []
    for i in range(1, max_seg + 1):
        p = os.path.join(runs_dir, "%s_seg%02d.webp" % (prefix, i))
        if not os.path.exists(p):
            continue
        frames = [f.copy().convert("RGB") for f in ImageSequence.Iterator(Image.open(p))]
        if frames:
            out.append(frames[-1])
    return out


def main():
    if len(sys.argv) < 4:
        print(__doc__)
        return 1
    runs_dir, out_path = sys.argv[1], sys.argv[2]
    specs = []
    for arg in sys.argv[3:]:
        prefix, _, label = arg.partition(":")
        specs.append((prefix, label or prefix))

    rows = []
    for prefix, label in specs:
        tiles = load_lasts(runs_dir, prefix)
        if tiles:
            rows.append((label, tiles))
        else:
            print("  (skip: no clips for %s)" % prefix)
    if not rows:
        print("no clips found in %s" % runs_dir)
        return 1

    w, h = rows[0][1][0].size
    tw, th = int(w * SCALE), int(h * SCALE)
    cols = max(len(t) for _, t in rows)
    canvas = Image.new("RGB", (LABEL_W + tw * cols, len(rows) * (th + 18) + 8), (16, 18, 24))
    d = ImageDraw.Draw(canvas)

    y = 6
    for label, tiles in rows:
        d.text((6, y + th // 2 - 4), label, fill=(130, 235, 225))
        for i, img in enumerate(tiles):
            canvas.paste(img.resize((tw, th), Image.LANCZOS), (LABEL_W + i * tw, y))
            d.text((LABEL_W + i * tw + 4, y + 2), "seg%d" % (i + 1), fill=(255, 235, 140))
        y += th + 18

    canvas.save(out_path)
    print("saved %s  %s" % (out_path, canvas.size))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
