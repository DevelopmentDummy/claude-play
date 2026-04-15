---
name: anima-prompt-pool
description: Build external prompt pools for Anima-based source generation. Use when creating many Anima prompts for later batch generation, especially when prompts must be saved in a stable JSON-friendly format with ids, categories, notes, subject tags, and natural-language scene text.
---

# Anima Prompt Pool

## Overview

Create prompt-bank entries that are easy to append into the batch pipeline later.
Write prompts for Anima source generation, not for the Illustrious teacher pass.

## Core Rules

- Use `subject_tags + scene_prompt` as the canonical format.
- `subject_tags` holds visible anchors in tag form.
- `scene_prompt` holds the main natural-language scene description.
- Optimize for batch consistency, not literary flair.
- Keep one entry focused on one scene idea.
- If an outfit, lighting, or camera angle matters, state it explicitly.

## Output Format

Default to this JSON object format:

```json
{
  "id": "p001",
  "category": ["office", "professional", "glasses"],
  "subject_tags": "1girl, solo, long navy hair, silver-rimmed glasses, white research blouse, dark navy vest, black pleated skirt",
  "scene_prompt": "An adult woman is sitting at a sleek modern office desk, focusing on a holographic display. The scene is lit by cool blue screen glow and soft ambient office lights. The image should feel professional and focused, with sharp suit textures and polished glass surfaces.",
  "notes": "Optional short note about intent or risk."
}
```

When asked for many prompts, output a JSON array of those objects.

Legacy compatibility:

- old `prompt` single-field format may still exist
- but new pools should default to `subject_tags + scene_prompt`

## Real File Example

Use a `prompt-bank.json` file like this:

```json
[
  {
    "id": "p001",
    "category": ["office", "professional", "glasses"],
    "subject_tags": "1girl, solo, long navy hair, silver-rimmed glasses, white research blouse, dark navy vest, black pleated skirt",
    "scene_prompt": "An adult woman is sitting at a sleek modern office desk, focusing on a holographic display. The scene is lit by cool blue screen glow and soft ambient office lights. The image should feel professional and focused, with sharp suit textures and polished glass surfaces.",
    "notes": "Good for polished interior surfaces."
  },
  {
    "id": "p002",
    "category": ["nature", "forest", "ethereal"],
    "subject_tags": "1girl, solo, long navy hair, white sundress, barefoot",
    "scene_prompt": "An adult woman is walking through a sun-drenched forest with ancient mossy trees and floating pollen. The scene is lit by warm dapples of sunlight filtering through the canopy. The image should feel ethereal and serene, with soft fabric movement and detailed leaf textures.",
    "notes": "Good for soft natural light."
  },
  {
    "id": "p003",
    "category": ["cyberpunk", "street", "neon"],
    "subject_tags": "1girl, solo, black leather jacket, dark navy hair, boots",
    "scene_prompt": "An adult woman is leaning against a brick wall in a rainy neon-lit alleyway. The scene is lit by vibrant pink and blue neon signs reflecting off wet pavement. The image should feel gritty and stylish, with glossy leather highlights and realistic rain droplets.",
    "notes": "Good for neon reflections and wet surfaces."
  }
]
```

Use a `review-queue.json` file like this:

```json
[
  {
    "id": "p001",
    "status": "pending",
    "source_image": "images/source/p001.png",
    "teacher_image": "images/teacher/p001.png",
    "subject_tags": "1girl, solo, long navy hair, silver-rimmed glasses, white research blouse, dark navy vest, black pleated skirt",
    "scene_prompt": "An adult woman is sitting at a sleek modern office desk, focusing on a holographic display. The scene is lit by cool blue screen glow and soft ambient office lights. The image should feel professional and focused, with sharp suit textures and polished glass surfaces.",
    "category": ["office", "professional", "glasses"],
    "notes": "Good for polished interior surfaces."
  }
]
```

Recommended status values:

- `pending` — not reviewed yet
- `yes` — approved for dataset
- `no` — rejected
- `hold` — keep for later review

## Prompt Construction Workflow

For each prompt:

1. Choose one clear scene family
   - neon city
   - luxury interior
   - futuristic stage
   - bedroom
   - bathroom
   - office
   - fantasy tavern

2. Lock the visible anchors
   - subject count
   - outfit
   - hair / accessories
   - body exposure level if relevant

3. Split the entry into two fields
   - `subject_tags`: visible anchors in tag form
   - `scene_prompt`: action, environment, lighting, mood, material richness

4. Add a short note only if needed
   - good for glossy clothing
   - strong color contrast
   - risk of cluttered background

## Writing Pattern

Use this skeleton:

```text
subject_tags: [Danbooru-style visible anchors]
scene_prompt: An adult [subject] is [pose/action] in [environment]. The scene is lit by [lighting]. The image should feel [mood], with [material/color/composition details].
```

## Constraints

- Prefer prompts that remain readable after batch generation.
- Do not overload every prompt with too many visual ideas.
- Do not write teacher-stage trigger tags here unless explicitly requested.
- Do not convert the whole entry into tags only; keep `scene_prompt` in natural language.
- If the user wants erotic prompts, keep the same structured format and focus on scene clarity.

## If the User Requests Variations

Generate variations by changing only one or two axes:

- environment
- lighting
- outfit material
- color palette
- camera distance

Do not change every axis at once unless the user asks for maximum variety.

## Deliverables

When asked to prepare a pool, provide:

1. A JSON array
2. Optional category summary
3. Optional warnings about prompts likely to fail in batch
