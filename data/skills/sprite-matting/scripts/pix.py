from PIL import Image
import numpy as np

def downscale(rgba, f):
    h, w = rgba.shape[0]//f, rgba.shape[1]//f
    a = rgba[:h*f, :w*f].reshape(h, f, w, f, 4)
    al = a[...,3].mean(axis=(1,3))
    pm = a[...,:3]*a[...,3:4]
    rgb = pm.sum(axis=(1,3)) / np.maximum(a[...,3].sum(axis=(1,3))[...,None], 1e-4)
    return np.clip(rgb,0,1), (al>0.5).astype(np.float32)

def srgb_to_oklab(c):
    c = np.where(c<=0.04045, c/12.92, ((c+0.055)/1.055)**2.4)
    m = np.array([[0.4122214708,0.5363325363,0.0514459929],
                  [0.2119034982,0.6806995451,0.1073969566],
                  [0.0883024619,0.2817188376,0.6299787005]])
    lms = np.cbrt(np.maximum(c @ m.T, 0))
    m2 = np.array([[0.2104542553,0.7936177850,-0.0040720468],
                   [1.9779984951,-2.4285922050,0.4505937099],
                   [0.0259040371,0.7827717662,-0.8086757660]])
    return lms @ m2.T

def kmeans_oklab(pix, k, iters=20):
    lab = srgb_to_oklab(pix)
    rng = np.random.default_rng(7)
    C = lab[rng.choice(len(lab), k, replace=False)].copy()
    for _ in range(iters):
        lb = ((lab[:,None,:]-C[None,:,:])**2).sum(-1).argmin(1)
        for j in range(k):
            s = lb==j
            if s.any(): C[j] = lab[s].mean(0)
    d = ((lab[:,None,:]-C[None,:,:])**2).sum(-1)
    return np.array([pix[d[:,j].argmin()] for j in range(k)])

def map_to_palette(rgb, pal):
    flat = rgb.reshape(-1,3)
    A = srgb_to_oklab(flat); B = srgb_to_oklab(pal)
    out = np.empty_like(flat); step = 20000
    for i in range(0, len(flat), step):
        d = ((A[i:i+step,None,:]-B[None,:,:])**2).sum(-1)
        out[i:i+step] = pal[d.argmin(1)]
    return out.reshape(rgb.shape)

def pil_palette(pix, n, method):
    u8 = (np.clip(pix,0,1)*255).astype(np.uint8)
    im = Image.fromarray(u8.reshape(1,-1,3), 'RGB')
    q = im.quantize(colors=n, method=method, dither=Image.Dither.NONE)
    return np.array(q.getpalette()[:n*3]).reshape(-1,3)/255.0

DB32 = np.array([int(h[i:i+2],16) for h in
"""000000 222034 45283c 663931 8f563b df7126 d9a066 eec39a fbf236 99e550 6abe30 37946e
4b692f 524b24 323c39 3f3f74 306082 5b6ee1 639bff 5fcde4 cbdbfc ffffff 9badb7 847e87
696a6a 595652 76428a ac3232 d95763 d77bba 8f974a 8a6f30""".split() for i in (0,2,4)]).reshape(-1,3)/255.0

def to_img(rgb, al, zoom=1):
    arr = np.dstack([(np.clip(rgb,0,1)*255).astype(np.uint8), (al*255).astype(np.uint8)])
    im = Image.fromarray(arr,'RGBA')
    if zoom>1: im = im.resize((im.width*zoom, im.height*zoom), Image.NEAREST)
    return im

def board(w,h,s=8):
    b=np.zeros((h,w,3),np.uint8)
    yy,xx=np.mgrid[0:h,0:w]
    b[...]=np.where((((xx//s)+(yy//s))%2==0)[...,None],160,210)
    return Image.fromarray(b,'RGB').convert('RGBA')
