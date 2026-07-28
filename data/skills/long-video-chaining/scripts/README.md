# 장편 체이닝 스크립트

ComfyUI HTTP API를 직접 호출한다. 워크플로우 패키지를 거치지 않으므로 ComfyUI가 떠 있기만 하면 된다.
zero-dep은 아니고 `Pillow` + `safetensors` + `torch`를 쓴다(ComfyUI venv에 이미 있음).

## 실행 전 확인

1. ComfyUI 구동 확인 — `curl http://127.0.0.1:8188/system_stats`
2. 앵커 프레임을 ComfyUI `input/longvid/anchor.png`에 배치
3. 시작 프레임을 `input/longvid/seg01_last.png`에 배치
4. `chain_runner.py` 상단 상수 조정 — `INPUT_DIR`, `SCRIPT`(모션 시퀀스), `W/H/LENGTH/SEED`

## chain_runner.py

```sh
python chain_runner.py <variant> <세그먼트수>
```

| variant | 진행형 프롬프트 | ColorMatch 앵커 | SVI LoRA |
|---|---|---|---|
| C | ✓ | | |
| **D** | ✓ | **✓** | |
| E | ✓ | ✓ | ✓ (비권장) |

**D가 정답 레시피다.** E는 SVI가 lightning과 충돌해 화면이 붕괴하므로 실패 재현용으로만 쓴다.

```sh
python chain_runner.py D 6      # 30초
python chain_runner.py D 12     # 60초
```

출력:
- `runs/D_seg01.webp` … 세그먼트별 클립
- `runs/D_stats.json` — 세그먼트별 휘도/std/motion/pose_delta

콘솔 로그 형식:
```
[D] seg01 123.6s lum=102.17 drift=-0.01 stdR=76.24 motion= 3.266 poseΔ=18.048
```

- `drift`가 ±1 이내면 색 안정
- `stdR`이 단조 증가하면 대비 누적 진행 중 → ColorMatch 확인
- `poseΔ`가 10 미만으로 연속되면 모션 데드락 의심 → 프롬프트 시퀀스 점검
- `motion`이 30을 넘으면 움직임이 아니라 **노이즈 붕괴**일 가능성이 높다. 반드시 프레임 확인

## convert_svi.py

SVI 2.0 Pro(PEFT 포맷)를 ComfyUI 네이티브 LoRA 포맷으로 변환한다.

```sh
python convert_svi.py
```

`LORA_DIR` 상수를 환경에 맞게 수정할 것. 800키 → 1200키로 늘어나면 정상이다.

⚠ 변환에 성공해도 **lightning 환경에서는 쓰지 마라.** SKILL.md 함정 2 참조.

## make_strip.py

```sh
python make_strip.py ./runs compare.png A:반복프롬프트 C:진행형 D:진행형+색앵커
```

세그먼트별 마지막 프레임을 가로로 이어 붙인다. **수치 판정 전에 반드시 이걸 먼저 봐라.**

## 최종 연결

세그먼트 클립을 하나로 이어붙일 때는 이음새 중복 프레임 1장을 버린다.

```python
from PIL import Image, ImageSequence
allf = []
for i in range(1, N + 1):
    fr = [f.copy().convert("RGB") for f in ImageSequence.Iterator(Image.open("runs/D_seg%02d.webp" % i))]
    allf.extend(fr if i == 1 else fr[1:])
allf[0].save("final.webp", save_all=True, append_images=allf[1:],
             duration=int(1000 / 16), loop=0, quality=88, method=4)
```
