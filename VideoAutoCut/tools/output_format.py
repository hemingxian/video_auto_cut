"""Task-owned output canvas, shared by rendering and subtitle layout."""
import json
import os
from pathlib import Path

SIZES = {"4:3": (1440, 1080), "3:4": (1080, 1440), "9:16": (1080, 1920), "16:9": (1920, 1080)}
RESOLUTION_SIZES = {
    **{(ratio, "1080p"): size for ratio, size in SIZES.items()},
    ("16:9", "720p"): (1280, 720),
    ("16:9", "4k"): (3840, 2160),
    ("9:16", "4k"): (2160, 3840),
}


def dimensions(ratio: str, resolution: str = "1080p"):
    try:
        return RESOLUTION_SIZES[(ratio, resolution)]
    except KeyError:
        raise ValueError(f"不支持的成片比例与分辨率: {ratio} / {resolution}") from None

def canvas_size():
    size = (int(os.environ.get("VIDEOAUTO_OUTPUT_WIDTH", "1920")), int(os.environ.get("VIDEOAUTO_OUTPUT_HEIGHT", "1080")))
    if size not in RESOLUTION_SIZES.values():
        raise ValueError(f"不支持的成片尺寸: {size}")
    return size

def configure_canvas(shots_json: str, ratio: str | None = None, resolution: str | None = None):
    config = Path(shots_json).parent / "output-format.json" if shots_json else None
    saved = {}
    if config and config.exists():
        saved = json.loads(config.read_text(encoding="utf-8"))
        saved_width, saved_height = dimensions(saved["aspect_ratio"], saved.get("resolution", "1080p"))
        if saved.get("width", saved_width) != saved_width or saved.get("height", saved_height) != saved_height:
            raise ValueError("任务尺寸记录与分辨率不一致")
    if ratio is not None or resolution is not None or saved:
        ratio = ratio or saved.get("aspect_ratio", "16:9")
        resolution = resolution or saved.get("resolution", "1080p")
        width, height = dimensions(ratio, resolution)
        os.environ["VIDEOAUTO_OUTPUT_WIDTH"] = str(width)
        os.environ["VIDEOAUTO_OUTPUT_HEIGHT"] = str(height)
    return canvas_size()


def layout_scale():
    """User typography settings are authored on a canvas with a 1080px short edge."""
    return min(canvas_size()) / 1080.0


def scaled_pixels(value):
    return int(round(value * layout_scale()))

def canvas_filter(width, height):
    return (f"scale=trunc(iw*sar/2)*2:ih,setsar=1,"
            f"scale={width}:{height}:force_original_aspect_ratio=decrease:force_divisible_by=2,"
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30")

def fitted_picture_bounds(source_width, source_height, width, height, sar=1.0):
    source_width = max(2, int(source_width * sar / 2) * 2)
    scale = min(width / source_width, height / source_height)
    picture_width = max(2, int(source_width * scale / 2) * 2)
    picture_height = max(2, int(source_height * scale / 2) * 2)
    # yuv420 padding positions are aligned to even pixels.
    return ((width - picture_width) // 4 * 2, (height - picture_height) // 4 * 2,
            picture_width, picture_height)
