#!/usr/bin/env python3
"""Rebuild the public-safe excerpt from the immutable private formal streams."""
from __future__ import annotations

import hashlib
from pathlib import Path

AUDIT = Path(__file__).resolve().parent
DEST = Path(__file__).resolve().parents[4] / "docs/acceptance-evidence/food-e2e-stop-20260929-51400401/logs/safe-stop-excerpt.txt"

def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()

stdout_path = AUDIT / "formal-stdout.private.bin"
stderr_path = AUDIT / "formal-stderr.private.bin"
def lf_lines(path: Path) -> list[str]:
    return [line[:-1] if line.endswith("\r") else line for line in path.read_bytes().decode("utf-8").split("\n")]

streams = {"stdout": lf_lines(stdout_path), "stderr": lf_lines(stderr_path)}
selectors = {
    "stdout": [
        ("TTS saved", lambda text: text.startswith("voice saved: "), 9),
        ("ASR task", lambda text: text.startswith("ASR task_id: "), 9),
        ("ASR success", lambda text: "SUCCEEDED" in text, 9),
        ("cue written", lambda text: "formal-workspace" in text and text.endswith("0001_cues.json"), 9),
        ("clean-missing command", lambda text: "sentrysearch_entry.py" in text and "clean-missing" in text and "qwen-cloud" in text, 1),
        ("index stage", lambda text: "sentrysearch index" in text and "43200" in text, 1),
    ],
    "stderr": [
        ("PersistentClient", lambda text: "chromadb.PersistentClient(path=db_path)" in text, 2),
        ("Chroma code 14", lambda text: "chromadb.errors.InternalError" in text and "code: 14" in text and "unable to open database file" in text, 2),
        ("wrapper index failure", lambda text: "sentrysearch index" in text and "Some(1)" in text, 1),
    ],
}
out = [
    f"source stdout sha256={sha(stdout_path)} bytes={stdout_path.stat().st_size}",
    f"source stderr sha256={sha(stderr_path)} bytes={stderr_path.stat().st_size}",
]
for stream_name, lines in streams.items():
    selected: set[int] = set()
    for label, predicate, expected in selectors[stream_name]:
        matches = [number for number, text in enumerate(lines, 1) if predicate(text)]
        if len(matches) != expected:
            raise SystemExit(f"{stream_name} {label}: expected {expected}, found {len(matches)}")
        selected.update(matches)
    for number in sorted(selected):
        line = lines[number - 1]
        lowered = line.lower()
        if any(token in lowered for token in ("http://", "https://", "oss://", "bearer ", "access_token", "refresh_token")):
            raise SystemExit(f"unsafe content selected from {stream_name} line {number}")
        out.append(f"{stream_name} LF line {number}: {line}")
DEST.write_text("\n".join(out) + "\n", encoding="utf-8")
print(f"wrote {DEST} with {len(out) - 2} mechanically selected raw lines")
