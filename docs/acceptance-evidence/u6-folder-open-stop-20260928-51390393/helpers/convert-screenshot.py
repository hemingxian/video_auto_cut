import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


parser = argparse.ArgumentParser()
parser.add_argument("--source", required=True)
parser.add_argument("--png", required=True)
parser.add_argument("--receipt", required=True)
args = parser.parse_args()

source = Path(args.source)
png = Path(args.png)
receipt = Path(args.receipt)

with Image.open(source) as image:
    source_rgb = image.convert("RGB")
    source_pixels = source_rgb.tobytes()
    width, height = source_rgb.size
    png.parent.mkdir(parents=True, exist_ok=True)
    source_rgb.save(png, format="PNG")

with Image.open(png) as image:
    png_rgb = image.convert("RGB")
    png_pixels = png_rgb.tobytes()

if png_rgb.size != (width, height) or png_pixels != source_pixels:
    raise SystemExit("decoded RGB pixels differ after JPEG-to-PNG conversion")

data = {
    "schema": "vacut-sky-jpeg-to-png-pixel-equivalence/v1",
    "source_original_jpeg": {
        "basename": source.name,
        "bytes": source.stat().st_size,
        "sha256": sha256(source),
        "retained": "private audit source; not copied to public evidence",
    },
    "public_png": {
        "basename": png.name,
        "bytes": png.stat().st_size,
        "sha256": sha256(png),
    },
    "decoded": {
        "mode": "RGB",
        "width": width,
        "height": height,
        "source_pixel_sha256": hashlib.sha256(source_pixels).hexdigest(),
        "png_pixel_sha256": hashlib.sha256(png_pixels).hexdigest(),
        "pixel_equal": True,
    },
}
receipt.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
