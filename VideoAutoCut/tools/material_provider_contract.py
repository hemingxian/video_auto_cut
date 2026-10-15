#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Shared transport contract and public errors for material providers."""
from __future__ import annotations

import urllib.request
from typing import Any, Protocol


DEFAULT_USER_AGENT = "VideoAutoCut/0.1 material-provider"


class ProviderError(RuntimeError):
    """A provider failure safe to show directly in the CLI."""


class JsonReader(Protocol):
    def __call__(
        self,
        request: str | urllib.request.Request,
        *,
        label: str,
    ) -> dict[str, Any]: ...


class FormPoster(Protocol):
    def __call__(
        self,
        url: str,
        data: dict[str, str],
        *,
        label: str,
    ) -> dict[str, Any]: ...
