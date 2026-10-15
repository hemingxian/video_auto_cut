import hashlib
import json
import sys
import zipfile
from pathlib import Path


def main():
    if len(sys.argv) != 4:
        raise SystemExit("usage: write_zip_inventory.py <zip> <jsonl> <summary>")
    archive, output, summary = map(Path, sys.argv[1:])
    archive = archive.resolve(strict=True)
    output, summary = output.resolve(), summary.resolve()
    if output.exists() or summary.exists():
        raise SystemExit("refusing to overwrite inventory output")
    count = 0
    total_uncompressed = 0
    total_compressed = 0
    with zipfile.ZipFile(archive) as package, output.open("w", encoding="utf-8", newline="\n") as stream:
        for info in package.infolist():
            row = {"path": info.filename, "is_dir": info.is_dir(), "uncompressed_bytes": info.file_size,
                   "compressed_bytes": info.compress_size, "crc32": f"{info.CRC:08x}"}
            stream.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
            count += 1
            total_uncompressed += info.file_size
            total_compressed += info.compress_size
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    receipt = {"schema": "w6-zip-inventory/v1", "archive": str(archive), "entry_count": count,
               "total_uncompressed_bytes": total_uncompressed, "total_compressed_bytes": total_compressed,
               "inventory_path": str(output), "inventory_bytes": output.stat().st_size, "inventory_sha256": digest}
    summary.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"entry_count": count, "inventory_bytes": output.stat().st_size, "inventory_sha256": digest}))


if __name__ == "__main__":
    main()
