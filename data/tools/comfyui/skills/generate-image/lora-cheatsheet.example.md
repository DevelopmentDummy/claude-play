# Dynamic LoRA Cheatsheet

이 파일은 이미지 생성 시 사용 가능한 LoRA 목록이다.
`[BASE]` 표시된 LoRA는 워크플로우에 이미 고정 포함되어 있다.
`loras` 파라미터로 base LoRA를 오버라이드할 수 있다:
- **강도 0** → 해당 base LoRA를 체인에서 **제거**
- **다른 값** → 해당 base LoRA의 강도를 **오버라이드**
- base에 없는 LoRA → 체인 뒤에 **동적 추가**

## 사용 방법

`generate_image` 또는 `comfyui_generate` 도구의 `loras` 파라미터로 전달:

```json
{
  "loras": [
    { "name": "example_lora.safetensors", "strength": 0.6 }
  ]
}
```

## LoRA 목록

### 퀄리티/디테일

| LoRA 파일명 | 강도 | 용도 | 트리거 태그 | 비고 |
|---|---|---|---|---|
| `example_quality.safetensors` | 0.4 | 퀄리티 향상 | 없음 | **[BASE]** |

### 포즈/액션

| LoRA 파일명 | 강도 | 용도 | 트리거 태그 | 비고 |
|---|---|---|---|---|
| `example_pose.safetensors` | 0.6 | 예시 포즈 | `pose_tag` | |

> CivitAI에서 LoRA를 검색하고 다운로드하려면 `civitai-search` 스킬을 사용하세요.
> 다운로드 후 이 파일에 항목을 추가하세요.
