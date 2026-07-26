# 파이프라인 스크립트

이 스킬과 함께 배포되는 실행 코드. 세션 어디서든 `.claude/skills/sprite-matting/scripts/`로 복사되므로
`sys.path.insert(0, <이 폴더>)` 후 바로 import 하면 된다.

| 파일 | 역할 |
|---|---|
| `pick_key.py` | 레퍼런스 이미지에서 크로마 키 색 자동 선정 (hex + Qwen 프롬프트 문장 반환) |
| `pix.py` | 팔레트 추출·OKLab 변환·양자화 |
| `lines.py` | 언샤프, Weber 축소, 라인 인식 합성, selout 외곽선 |
| `chroma_key_pro.py` | ComfyUI 커스텀 노드 원본 (`ChromaKeyUnmix`). `custom_nodes/ComfyUI-ChromaKeyPro/__init__.py`로 복사해 설치 |

의존성은 numpy / Pillow / torch(노드만). ComfyUI venv에서 그대로 실행된다.

## 최소 사용 예

```python
import sys; sys.path.insert(0, '<scripts 폴더>')
import pick_key, pix, lines

hexs, hue, report = pick_key.pick('reference.png')     # 크로마 색 선정
print(pick_key.prompt(hexs))                            # Qwen 배경 교체 문장

rgb, alpha, _ = lines.line_aware_downscale(frame, 3)    # 1/3 축소 + 라인 보존
rgb = lines.selout(rgb, alpha, 0.35)                    # 외곽선
out = pix.map_to_palette(rgb, palette)                  # 팔레트 적용
```
