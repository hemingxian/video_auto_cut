from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class AnimationAgentResult:
    ok: bool
    engine: str
    source_path: Path | None = None
    rendered_path: Path | None = None
    state_path: Path | None = None
    attempts: list[dict] = field(default_factory=list)
    error: str = ""
