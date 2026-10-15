#!/usr/bin/env python3
"""Scan W6 outputs for the local release config and credential values without emitting them."""

from __future__ import annotations

import base64
import hashlib
import json
import sys
import zipfile
from pathlib import Path, PurePosixPath

CREDENTIAL_FIELDS = ("secretId", "secretKey", "sessionToken")
FORBIDDEN_NAME = "release-upload.local.json"


def encoded_patterns(value: str) -> set[bytes]:
    values = {value, value.strip()}
    values.discard("")
    patterns: set[bytes] = set()
    for item in values:
        raw = item.encode("utf-8")
        patterns.update((raw, item.encode("utf-16le"), item.encode("utf-16be")))
        patterns.add(json.dumps(item, ensure_ascii=True)[1:-1].encode("ascii"))
        patterns.add(json.dumps(item, ensure_ascii=False)[1:-1].encode("utf-8"))
        patterns.add(base64.b64encode(raw))
        patterns.add(base64.urlsafe_b64encode(raw))
    return {pattern for pattern in patterns if pattern}


def scan_stream(stream, patterns: set[bytes]) -> bool:
    overlap = max((len(pattern) for pattern in patterns), default=1) - 1
    tail = b""
    while True:
        chunk = stream.read(1024 * 1024)
        if not chunk:
            return False
        data = tail + chunk
        if any(pattern in data for pattern in patterns):
            return True
        tail = data[-overlap:] if overlap else b""


def main() -> int:
    if len(sys.argv) < 6:
        raise SystemExit("usage: scan_release_credentials.py <config> <zip> <extracted-root> <audit-root> <output>")
    config_path = Path(sys.argv[1]).resolve(strict=True)
    archive_path = Path(sys.argv[2]).resolve(strict=True)
    extracted_root = Path(sys.argv[3]).resolve(strict=True)
    audit_root = Path(sys.argv[4]).resolve(strict=True)
    output = Path(sys.argv[5]).resolve()
    if output.exists():
        raise SystemExit(f"refusing to overwrite: {output}")

    config_bytes = config_path.read_bytes()
    config = json.loads(config_bytes.decode("utf-8-sig"))
    values = [str(config.get(field) or "") for field in CREDENTIAL_FIELDS]
    nonempty = [value for value in values if value.strip()]
    patterns: set[bytes] = {config_bytes}
    for value in nonempty:
        patterns.update(encoded_patterns(value))

    forbidden_entries: list[str] = []
    credential_hits: list[str] = []
    zip_members = 0
    with zipfile.ZipFile(archive_path) as package:
        for info in package.infolist():
            normalized = info.filename.replace("\\", "/").strip("/").lower()
            if PurePosixPath(normalized).name == FORBIDDEN_NAME.lower():
                forbidden_entries.append(info.filename)
            if info.is_dir():
                continue
            zip_members += 1
            with package.open(info) as stream:
                if scan_stream(stream, patterns):
                    credential_hits.append(f"zip:{info.filename}")

    scanned_files = 0
    for scope, root in (("extracted", extracted_root), ("audit", audit_root)):
        for path in root.rglob("*"):
            if not path.is_file() or path.resolve() in {output, config_path}:
                continue
            if scope == "audit" and extracted_root in path.resolve().parents:
                continue
            scanned_files += 1
            with path.open("rb") as stream:
                if scan_stream(stream, patterns):
                    credential_hits.append(f"{scope}:{path.relative_to(root).as_posix()}")

    receipt = {
        "schema": "w6-release-credential-scan/v1",
        "config": {
            "path_label": "main/VideoAutoCutDesktop/release-upload.local.json",
            "bytes": len(config_bytes),
            "sha256": hashlib.sha256(config_bytes).hexdigest(),
            "credential_fields_checked": list(CREDENTIAL_FIELDS),
            "nonempty_credential_field_count": len(nonempty),
            "content_recorded": False,
        },
        "archive": str(archive_path),
        "zip_members_scanned": zip_members,
        "filesystem_files_scanned": scanned_files,
        "encodings_checked": ["raw", "trim", "utf8", "utf16le", "utf16be", "json-escaped", "base64", "urlsafe-base64"],
        "forbidden_filename": FORBIDDEN_NAME,
        "forbidden_entry_count": len(forbidden_entries),
        "forbidden_entries": forbidden_entries,
        "credential_match_count": len(credential_hits),
        "credential_match_paths": credential_hits,
        "pass": not forbidden_entries and not credential_hits,
    }
    output.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"pass": receipt["pass"], "zip_members": zip_members, "files": scanned_files,
                      "forbidden_entries": len(forbidden_entries), "credential_matches": len(credential_hits)}, ensure_ascii=False))
    return 0 if receipt["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
