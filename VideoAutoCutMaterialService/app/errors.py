from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class ServiceError(Exception):
    status_code: int
    code: str
    message: str
    retryable: bool = False
    action: str | None = None
    details: dict[str, Any] = field(default_factory=dict)

    def __str__(self) -> str:
        return self.message
