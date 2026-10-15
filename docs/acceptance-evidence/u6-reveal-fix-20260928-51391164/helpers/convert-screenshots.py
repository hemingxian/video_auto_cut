from pathlib import Path
from PIL import Image, ImageChops
import hashlib
import json

root = Path(
    r"D:\autocut\video-auto-cut\VideoAutoCutDesktop\node_modules\.tmp"
    r"\ui-u6-51388993-314c52f-20260928\phase-51391164-5893f7d\screenshots"
)
rows = []
for src in sorted(root.glob("*.jpeg")):
    with Image.open(src) as image:
        image.load()
        mode = image.mode
        size = image.size
        dst = src.with_suffix(".png")
        image.save(dst, format="PNG")
    with Image.open(src) as original, Image.open(dst) as png:
        original.load()
        png.load()
        same = (
            original.mode == png.mode
            and original.size == png.size
            and ImageChops.difference(original, png).getbbox() is None
        )
    rows.append(
        {
            "source": str(src),
            "source_mime": "image/jpeg",
            "source_sha256": hashlib.sha256(src.read_bytes()).hexdigest(),
            "png": str(dst),
            "png_sha256": hashlib.sha256(dst.read_bytes()).hexdigest(),
            "decoded_mode": mode,
            "width": size[0],
            "height": size[1],
            "decoded_pixels_equal": same,
        }
    )

receipt = {
    "schema": "vacut-sky-jpeg-png-mapping/v1",
    "count": len(rows),
    "all_decoded_pixels_equal": all(row["decoded_pixels_equal"] for row in rows),
    "mappings": rows,
}
output = root.parent / "receipts" / "screenshot-png-index.json"
output.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(
    json.dumps(
        {
            "index": str(output),
            "count": len(rows),
            "all_equal": receipt["all_decoded_pixels_equal"],
        },
        ensure_ascii=False,
    )
)
