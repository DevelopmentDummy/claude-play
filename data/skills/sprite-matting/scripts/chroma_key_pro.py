"""ChromaKeyPro — 색차(color-difference) 기반 크로마 키 + 언믹싱 디스필.

애니 스타일 라인아트가 있는 소스에서 유클리드 거리 키가 실패하는 문제를 해결한다.
검정 외곽선과 배경의 안티에일리어싱 혼합 픽셀은 키 컬러에서 '멀기' 때문에
거리 기반 알파는 그것을 완전 불투명 전경으로 오판하고, 어두운 배경색이 테두리에 남는다.

색차 키는 배경 색상의 채널 관계(마젠타 = R,B 높고 G 낮음)를 이용하므로
밝기와 무관하게 혼합 비율을 그대로 복원한다.
"""

import torch


def _sample_key(img):
    """네 모서리 20px 패치 평균으로 배경색 추정. img: (H,W,3) float 0..1"""
    h, w, _ = img.shape
    s = max(4, min(20, h // 8, w // 8))
    patches = torch.cat([
        img[:s, :s].reshape(-1, 3),
        img[:s, -s:].reshape(-1, 3),
        img[-s:, :s].reshape(-1, 3),
        img[-s:, -s:].reshape(-1, 3),
    ], dim=0)
    return patches.mean(dim=0)


def _hex_to_rgb(text):
    t = text.strip().lstrip("#")
    if len(t) != 6:
        return None
    try:
        return torch.tensor([int(t[i:i + 2], 16) / 255.0 for i in (0, 2, 4)])
    except ValueError:
        return None


def _difference(img, axis, key=None, off_axis_penalty=1.5):
    """배경색 축에 따른 색차값. 값이 클수록 배경에 가깝다."""
    r, g, b = img[..., 0], img[..., 1], img[..., 2]
    if axis == "magenta (R,B high / G low)":
        return torch.minimum(r, b) - g
    if axis == "green (G high / R,B low)":
        return g - torch.maximum(r, b)
    if axis == "blue (B high / R,G low)":
        return b - torch.maximum(r, g)
    if axis == "cyan (G,B high / R low)":
        return torch.minimum(g, b) - r

    # auto — 키 컬러의 실제 색상 방향에 투영한다.
    # 회색 성분을 제거한 채도 벡터끼리 비교하므로 밝기와 무관하고,
    # 축에서 벗어난 색상(예: 치마의 무지개 트림)은 perp 항으로 감점되어 살아남는다.
    if key is None:
        return torch.minimum(r, b) - g
    c = img - img.min(dim=-1, keepdim=True).values          # 픽셀 채도 벡터
    k = key - key.min()                                      # 키 채도 벡터
    kn = torch.linalg.norm(k) + 1e-6
    khat = k / kn
    proj = (c * khat.view(1, 1, 3)).sum(dim=-1)              # 축 방향 성분
    perp = torch.linalg.norm(c - proj.unsqueeze(-1) * khat.view(1, 1, 3), dim=-1)
    return proj - perp * off_axis_penalty


def _key_scale(axis, key):
    if axis.startswith("auto"):
        return float(torch.linalg.norm(key - key.min()))
    return float(_difference(key.reshape(1, 1, 3), axis)[0, 0])


class ChromaKeyUnmix:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "key_axis": ([
                    "auto (project onto key color)",
                    "magenta (R,B high / G low)",
                    "green (G high / R,B low)",
                    "blue (B high / R,G low)",
                    "cyan (G,B high / R low)",
                ], {"default": "auto (project onto key color)"}),
                "tolerance": ("FLOAT", {
                    "default": 0.92, "min": 0.50, "max": 1.20, "step": 0.01,
                    "tooltip": "낮출수록 배경을 더 공격적으로 제거(실루엣이 깎일 수 있음). 0.92 권장",
                }),
                "edge_softness": ("FLOAT", {
                    "default": 0.0, "min": 0.0, "max": 0.5, "step": 0.01,
                    "tooltip": "알파 전이 구간 폭. 0이면 색차값 그대로(권장)",
                }),
                "unmix": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "경계 픽셀의 원래 색을 역산해 배경색 오염 제거",
                }),
            },
            "optional": {
                "off_axis_penalty": ("FLOAT", {
                    "default": 1.5, "min": 0.0, "max": 5.0, "step": 0.1,
                    "tooltip": "auto 축 전용. 키 색상에서 벗어난 색을 지키는 강도. 올리면 무지개 트림 같은 인접 색이 덜 뚫린다",
                }),
                "key_color_hex": ("STRING", {
                    "default": "",
                    "tooltip": "비우면 네 모서리에서 자동 샘플링. 예: FF00FF",
                }),
                "alpha_expand": ("INT", {
                    "default": 0, "min": -8, "max": 8,
                    "tooltip": "알파 경계 확장(+)/침식(-) 근사. 잔상이 남으면 -1~-2",
                }),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK", "IMAGE")
    RETURN_NAMES = ("rgba", "alpha", "rgb_unmixed")
    FUNCTION = "run"
    CATEGORY = "image/matting"

    def run(self, image, key_axis, tolerance, edge_softness, unmix,
            key_color_hex="", alpha_expand=0, off_axis_penalty=1.5):
        outs, masks, rgbs = [], [], []
        manual = _hex_to_rgb(key_color_hex) if key_color_hex else None

        for i in range(image.shape[0]):
            img = image[i, ..., :3].float()
            key = manual.to(img.device) if manual is not None else _sample_key(img)

            s_key = _key_scale(key_axis, key)
            if abs(s_key) < 1e-4:
                # 배경이 무채색이라 색차 키를 쓸 수 없음 — 원본 통과
                alpha = torch.ones(img.shape[:2], device=img.device)
                fg = img
            else:
                s = _difference(img, key_axis, key, off_axis_penalty)
                denom = s_key * tolerance
                a = 1.0 - s / denom
                if edge_softness > 0:
                    a = (a - 0.5) / max(edge_softness, 1e-4) + 0.5
                alpha = a.clamp(0.0, 1.0)

                if alpha_expand != 0:
                    shift = alpha_expand * 0.06
                    alpha = (alpha + shift).clamp(0.0, 1.0)

                if unmix:
                    A = alpha.clamp(min=1e-3).unsqueeze(-1)
                    fg = ((img - (1.0 - A) * key.view(1, 1, 3)) / A).clamp(0.0, 1.0)
                    solid = (alpha >= 0.999).unsqueeze(-1)
                    fg = torch.where(solid, img, fg)
                else:
                    fg = img

            outs.append(torch.cat([fg, alpha.unsqueeze(-1)], dim=-1))
            masks.append(alpha)
            rgbs.append(fg)

        return (torch.stack(outs), torch.stack(masks), torch.stack(rgbs))


NODE_CLASS_MAPPINGS = {"ChromaKeyUnmix": ChromaKeyUnmix}
NODE_DISPLAY_NAME_MAPPINGS = {"ChromaKeyUnmix": "Chroma Key + Unmix"}
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
