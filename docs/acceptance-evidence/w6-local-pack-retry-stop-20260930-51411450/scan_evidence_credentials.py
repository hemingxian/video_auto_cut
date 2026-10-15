import base64
import json
import sys
from pathlib import Path

FIELDS = ("secretId", "secretKey", "sessionToken")


def variants(value: str) -> set[bytes]:
    texts = {value, value.strip(), json.dumps(value, ensure_ascii=False)[1:-1]}
    out: set[bytes] = set()
    for text in texts:
        if not text:
            continue
        for encoding in ("utf-8", "utf-16le", "utf-16be"):
            out.add(text.encode(encoding))
        out.add(base64.b64encode(text.encode("utf-8")))
    return out


def main() -> int:
    config = Path(sys.argv[1]).resolve(strict=True)
    root = Path(sys.argv[2]).resolve(strict=True)
    output = Path(sys.argv[3]).resolve()
    data = json.loads(config.read_text(encoding="utf-8-sig"))
    patterns: set[bytes] = set()
    nonempty = 0
    for field in FIELDS:
        value = data.get(field)
        if isinstance(value, str) and value.strip():
            nonempty += 1
            patterns.update(variants(value))
    hits: list[str] = []
    scanned = 0
    for path in root.rglob("*"):
        if not path.is_file() or path.resolve() == output:
            continue
        scanned += 1
        blob = path.read_bytes()
        if any(pattern in blob for pattern in patterns):
            hits.append(path.relative_to(root).as_posix())
    receipt = {
        "schema": "w6-stop-evidence-credential-scan/v1",
        "credential_fields_checked": list(FIELDS),
        "nonempty_credential_field_count": nonempty,
        "files_scanned": scanned,
        "credential_match_count": len(hits),
        "pass": not hits,
        "content_recorded": False,
    }
    output.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0 if not hits else 1


if __name__ == "__main__":
    raise SystemExit(main())
