# S2 card static-frame evidence

This checks that S2 did not change S1 card title wrapping for food shots 1, 3, 8 and 9. It renders only real HyperFrames HTML overlays; it does not generate video.

- Before: existing HTML from the 2026-09-29 real run.
- After: WIP template_packaging.build_composition using the same shots.json, duration, 1920x1080 dimensions and picture_bounds.
- Seeks: shot 1 = 4.0 s, shot 3 = 5.5 s, shot 8 = 4.0 s, shot 9 = 4.0 s.
- Browser: installed Google Chrome headless at 1920x1080 with GPU disabled.
- Font and GSAP: copied byte-for-byte from each real packaging directory; no remote assets.
- Transparent HTML overlay only; no source video was composited.

receipt.json records every PNG SHA-256. All four before/after pairs are byte-identical, so existing card line breaks, including shot 1 最重/复 and shot 9 发/过来, remain unchanged.
