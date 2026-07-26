import numpy as np
from PIL import Image, ImageFilter

def _luma(x): return 0.299*x[...,0]+0.587*x[...,1]+0.114*x[...,2]

def unsharp(x,r=1.5,a=1.2):
    im=Image.fromarray((np.clip(x[...,:3],0,1)*255).astype(np.uint8))
    s=im.filter(ImageFilter.UnsharpMask(radius=r,percent=int(a*100),threshold=2))
    y=x.copy(); y[...,:3]=np.asarray(s).astype(np.float32)/255; return y

def weber(x,f,sigma=0.12):
    h,w=x.shape[0]//f,x.shape[1]//f
    a=x[:h*f,:w*f].reshape(h,f,w,f,4); rgb=a[...,:3]; al=a[...,3]
    mean=(rgb*al[...,None]).sum(axis=(1,3),keepdims=True)/np.maximum(al[...,None].sum(axis=(1,3),keepdims=True),1e-4)
    diff=np.sqrt(((rgb-mean)**2).sum(-1))
    wgt=((1-np.exp(-(diff**2)/(2*sigma**2)))+0.15)*al
    out=(rgb*wgt[...,None]).sum(axis=(1,3))/np.maximum(wgt[...,None].sum(axis=(1,3)),1e-4)
    return np.clip(out,0,1),(al.mean(axis=(1,3))>0.5).astype(np.float32)

def line_mask(x, thresh=0.13, blur=2.5):
    """고해상도에서 라인아트 검출: 로컬 평균보다 눈에 띄게 어두운 픽셀."""
    y=_luma(x[...,:3])
    im=Image.fromarray((y*255).astype(np.uint8))
    lo=np.asarray(im.filter(ImageFilter.GaussianBlur(blur))).astype(np.float32)/255
    m=(lo-y)>thresh
    return (m & (x[...,3]>0.5))

def line_aware_downscale(x, f, strength=1.0, thresh=0.13):
    """색은 Weber로, 라인은 커버리지 가중으로 따로 합성. 커버리지가 곧 안티에일리어싱."""
    base,al = weber(unsharp(x), f)
    lm = line_mask(x, thresh)
    h,w = base.shape[:2]
    lm_b = lm[:h*f,:w*f].reshape(h,f,w,f)
    cov  = lm_b.mean(axis=(1,3))                      # 0~1 커버리지
    rgb_b = x[:h*f,:w*f,:3].reshape(h,f,w,f,3)
    wsum = lm_b[...,None].sum(axis=(1,3))
    lcol = (rgb_b*lm_b[...,None]).sum(axis=(1,3))/np.maximum(wsum,1e-4)
    lcol = np.where(wsum>0, lcol, base)
    k = np.clip(cov*strength,0,1)[...,None]
    return np.clip(base*(1-k)+lcol*k,0,1), al, cov

def selout(rgb, al, amount=0.45, pure_black=False):
    """실루엣 최외곽 1px을 어둡게. amount=0이면 변화 없음."""
    a=(al>0.5)
    pad=np.pad(a,1,constant_values=False)
    inner = pad[:-2,1:-1]&pad[2:,1:-1]&pad[1:-1,:-2]&pad[1:-1,2:]
    edge = a & ~inner
    out=rgb.copy()
    if pure_black:
        out[edge]=0.0
    else:
        out[edge]=np.clip(rgb[edge]*(1-amount),0,1)
    return out
