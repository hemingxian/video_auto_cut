# VideoAutoCut Manim Constraints

## Scope

Generate one self-contained Manim Community Python script for a single video shot.
The script is executed in a temporary task directory by VideoAutoCut.
These constraints are loaded after official Manim documentation excerpts.

## Required Contract

- Define `class GeneratedMaterialScene(Scene)` or `class GeneratedMaterialScene(ThreeDScene)`.
- Use only local code and Manim primitives. Do not require external images, fonts, videos, network resources, or user files.
- The packaged runtime does not include LaTeX. Do not use any Manim object that compiles TeX.
- The video must fit a 16:9 1920x1080 composition.
- Use these constants when useful: `TITLE`, `SUBTITLE`, `DURATION`, `KEYWORDS`, `ITEMS`, `VALUES`.
- Keep the animation duration controlled by `DURATION`; use bounded `run_time` values.
- Prefer a small number of clear objects over many slow objects.
- Output only JSON with a `source` field when asked to generate or repair code.

## Allowed Imports

- `from manim import *`
- `import math`
- `import random`
- `import numpy as np`

## Forbidden

- File access: `open`, `pathlib`, `shutil`, arbitrary read/write.
- System access: `os`, `sys`, `subprocess`, `ctypes`, `importlib`.
- Network access: `socket`, `requests`, `urllib`, `http`, `ftplib`.
- Dynamic execution: `eval`, `exec`, `compile`, `__import__`.
- Reflection helpers that hide unsafe behavior, including `getattr`, `setattr`, `delattr`.
- Dunder attributes or methods.

## API Compatibility Rules

- Do not call `Text.get_words()`. If word-level layout is needed, split the original string and build multiple `Text` objects.
- Do not use `MathTex`, `Tex`, `SingleStringMathTex`, `Matrix`, `MobjectMatrix`, `DecimalNumber`, `Integer`, `Variable`, or `NumberLine`; these can require a LaTeX toolchain that is not packaged.
- Write formulas with plain `Text`, for example `Text("QK^T -> scores")`, or draw matrices manually with `VGroup`, `Rectangle`, `Square`, `Dot`, and `Text`.
- Do not use `GrowFromBottom`; use `GrowFromEdge(mobject, DOWN)`, `FadeIn`, `Create`, or animate height/scale manually.
- Avoid undocumented Manim methods. Use common Manim Community primitives such as `Text`, `VGroup`, `Circle`, `Rectangle`, `Line`, `Arrow`, `Dot`, `Axes`, `FadeIn`, `FadeOut`, `Create`, `Write`, `Transform`, `LaggedStart`, `AnimationGroup`, `MoveAlongPath`, `Rotate`, and `Indicate`.
- Do not assume commercial plugins or custom Manim extensions exist.

## Visual Rules

- Do not draw JSON field names such as `prompt`, `title`, `style`, `duration`, `keywords`, `items`, `label`, `value`, `source`.
- Show only meaningful script content: concept names, stage names, product names, values, or short explanatory labels.
- Keep text readable and avoid overlapping elements.
- For Chinese text, use `font="Microsoft YaHei"` when creating `Text`.

## Failure Repair Rules

- If validation reports an unknown Manim name, replace it with a common Manim primitive.
- If rendering reports an attribute error, remove that API call and implement the behavior manually.
- If the scene is too slow or crowded, simplify layout and reduce object count.
