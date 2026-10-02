# 배경 플레이트 대비 구도 오차 측정 — SIFT + RANSAC 닮음변환. 인물은 이상치로 빠진다.
# 사용: python align_check.py <플레이트.png> <영상.mp4 또는 이미지> [초 간격=1.0]
#   출력: 시각별 배율·이동(px). 배율 1±0.01, 이동 3px 이내면 "삼각대 고정"으로 본다.
import sys, json
import numpy as np, cv2

plate, src = sys.argv[1], sys.argv[2]; step = float(sys.argv[3]) if len(sys.argv) > 3 else 1.0
P = cv2.imread(plate, 0); sift = cv2.SIFT_create(3000); k1, d1 = sift.detectAndCompute(P, None)

def measure(g):
    if g.shape != P.shape: g = cv2.resize(g, (P.shape[1], P.shape[0]))
    k2, d2 = sift.detectAndCompute(g, None)
    m = [a for a, b in cv2.BFMatcher().knnMatch(d2, d1, k=2) if a.distance < 0.75 * b.distance]
    if len(m) < 8: return None
    A, inl = cv2.estimateAffinePartial2D(np.float32([k2[a.queryIdx].pt for a in m]), np.float32([k1[a.trainIdx].pt for a in m]), method=cv2.RANSAC)
    if A is None: return None
    return {'scale': round(float(np.hypot(A[0, 0], A[1, 0])), 4), 'dx': round(float(A[0, 2]), 1), 'dy': round(float(A[1, 2]), 1), 'inliers': int(inl.sum())}

out = []
if src.lower().endswith(('.png', '.jpg', '.jpeg')):
    out.append({'t': 0, **(measure(cv2.imread(src, 0)) or {'error': 'match fail'})})
else:
    cap = cv2.VideoCapture(src); fps = cap.get(cv2.CAP_PROP_FPS) or 24; i = 0; every = max(1, int(round(fps * step)))
    while True:
        ok, f = cap.read()
        if not ok: break
        if i % every == 0: out.append({'t': round(i / fps, 2), **(measure(cv2.cvtColor(f, cv2.COLOR_BGR2GRAY)) or {'error': 'match fail'})})
        i += 1
print(json.dumps(out, ensure_ascii=False))
