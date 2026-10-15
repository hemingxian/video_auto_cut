#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Video encoder selection and hardware-to-software fallback helpers."""
from __future__ import annotations

import os
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Mapping, Sequence


@dataclass(frozen=True, slots=True)
class EncoderSpec:
    """An immutable FFmpeg H.264 encoder description."""

    key: str
    codec: str
    label: str
    pixel_format: str
    preset_options: tuple[str, ...] = ()


CPU_ENCODER = EncoderSpec("cpu", "libx264", "CPU (libx264)", "yuv420p", ("-preset", "veryfast"))
INTEL_ENCODER = EncoderSpec("intel", "h264_qsv", "Intel Quick Sync", "nv12", ("-preset", "veryfast"))
AMD_ENCODER = EncoderSpec("amd", "h264_amf", "AMD AMF", "nv12", ("-quality", "balanced"))
NVIDIA_ENCODER = EncoderSpec("nvidia", "h264_nvenc", "NVIDIA NVENC", "yuv420p", ("-preset", "p4"))

ENCODERS: Mapping[str, EncoderSpec] = {
    spec.key: spec
    for spec in (CPU_ENCODER, INTEL_ENCODER, AMD_ENCODER, NVIDIA_ENCODER)
}

# Standalone scripts benchmark every candidate, including libx264, instead of
# guessing from the GPU vendor. Electron supplies Rust's already-resolved choice
# and therefore skips this work entirely.
AUTO_BENCHMARK_ORDER: tuple[EncoderSpec, ...] = (
    CPU_ENCODER,
    NVIDIA_ENCODER,
    AMD_ENCODER,
    INTEL_ENCODER,
)
BENCHMARK_ITEM_TIMEOUT_SECONDS = 3.0
BENCHMARK_TOTAL_BUDGET_SECONDS = 10.0
BENCHMARK_FRAMES = 90

ENCODER_ALIASES: Mapping[str, str] = {
    "cpu": "cpu",
    "software": "cpu",
    "x264": "cpu",
    "libx264": "cpu",
    "intel": "intel",
    "qsv": "intel",
    "h264_qsv": "intel",
    "amd": "amd",
    "amf": "amd",
    "h264_amf": "amd",
    "nvidia": "nvidia",
    "nvenc": "nvidia",
    "h264_nvenc": "nvidia",
}


def encoder_by_name(value: str) -> EncoderSpec | None:
    """Map a user-facing or FFmpeg encoder name to its specification."""

    key = ENCODER_ALIASES.get(str(value or "").strip().lower())
    return ENCODERS.get(key) if key else None


def normalized_quality(quality: int | float) -> int:
    """Return a valid FFmpeg H.264 quality value."""

    try:
        value = int(round(float(quality)))
    except (TypeError, ValueError):
        value = 20
    return min(51, max(1, value))


def encoder_arguments(encoder: EncoderSpec, quality: int | float = 20) -> list[str]:
    """Build FFmpeg video encoder arguments for a numeric quality target."""

    value = str(normalized_quality(quality))
    args = ["-c:v", encoder.codec, *encoder.preset_options]
    if encoder.key == "cpu":
        quality_args = ["-crf", value]
    elif encoder.key == "intel":
        quality_args = ["-global_quality", value]
    elif encoder.key == "amd":
        q = int(value)
        quality_args = [
            "-usage", "transcoding", "-rc", "cqp",
            "-qp_i", str(max(1, q - 2)),
            "-qp_p", value,
            "-qp_b", str(min(51, q + 2)),
        ]
    elif encoder.key == "nvidia":
        quality_args = ["-tune", "hq", "-rc", "constqp", "-qp", value]
    else:
        raise ValueError(f"unsupported video encoder: {encoder.key}")
    return [
        *args,
        *quality_args,
        "-profile:v", "high",
        "-level:v", "4.2",
        "-g", "60",
    ]


def append_pixel_format_filter(filter_chain: str, encoder: EncoderSpec) -> str:
    """Append the encoder-compatible format after all CPU/ASS filters."""

    format_filter = f"format={encoder.pixel_format}"
    return f"{filter_chain},{format_filter}" if filter_chain else format_filter


def fallback_marker_path(environ: Mapping[str, str] | None = None) -> Path | None:
    env = os.environ if environ is None else environ
    value = env.get("VIDEOAUTO_VIDEO_ENCODER_FALLBACK_FILE", "").strip()
    return Path(value) if value else None


def benchmark_encoder(
    ffmpeg: str,
    encoder: EncoderSpec,
    *,
    quality: int | float = 20,
    timeout: float = BENCHMARK_ITEM_TIMEOUT_SECONDS,
    runner: Callable[..., object] | None = None,
    clock: Callable[[], float] = time.perf_counter,
) -> float | None:
    """Return elapsed seconds for a real encode, or ``None`` when unavailable."""

    timeout = max(0.1, float(timeout))
    command = [
        ffmpeg,
        "-hide_banner",
        "-nostats",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=1920x1080:rate=30",
        "-frames:v",
        str(BENCHMARK_FRAMES),
        "-an",
        "-vf",
        f"format={encoder.pixel_format}",
        *encoder_arguments(encoder, quality),
        "-f",
        "null",
        "-",
    ]
    execute = runner or subprocess.run
    started = clock()
    try:
        execute(
            command,
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=timeout,
        )
        return max(0.000001, clock() - started)
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return None


def resolve_encoder(
    ffmpeg: str,
    *,
    environ: Mapping[str, str] | None = None,
    benchmark: Callable[[str, EncoderSpec, float], float | None] | None = None,
    clock: Callable[[], float] = time.monotonic,
) -> EncoderSpec:
    """Resolve the encoder without repeating Electron's hardware probe.

    Electron passes ``VIDEOAUTO_VIDEO_ENCODER_RESOLVED``. When it is absent,
    standalone Python benchmarks actual H.264 encodes under a bounded time
    budget and selects the fastest working encoder, including libx264.
    """

    env = os.environ if environ is None else environ
    marker = fallback_marker_path(env)
    if marker and marker.exists():
        return CPU_ENCODER

    resolved_value = env.get("VIDEOAUTO_VIDEO_ENCODER_RESOLVED", "").strip()
    if resolved_value:
        return encoder_by_name(resolved_value) or CPU_ENCODER

    configured = (
        env.get("VIDEOAUTO_VIDEO_ENCODER", "").strip()
        or env.get("VIDEO_ENCODER", "").strip()
        or "auto"
    ).lower()
    measure = benchmark or (
        lambda binary, spec, timeout: benchmark_encoder(
            binary,
            spec,
            timeout=timeout,
        )
    )

    if configured != "auto":
        selected = encoder_by_name(configured)
        if selected is not None and selected.key == "cpu":
            return CPU_ENCODER
        if selected is not None:
            elapsed = measure(ffmpeg, selected, BENCHMARK_ITEM_TIMEOUT_SECONDS)
            return selected if elapsed is not None else CPU_ENCODER

    deadline = clock() + BENCHMARK_TOTAL_BUDGET_SECONDS
    timings: list[tuple[float, EncoderSpec]] = []
    for index, encoder in enumerate(AUTO_BENCHMARK_ORDER):
        remaining = deadline - clock()
        if remaining <= 0.1:
            break
        candidates_left = len(AUTO_BENCHMARK_ORDER) - index
        timeout = min(
            BENCHMARK_ITEM_TIMEOUT_SECONDS,
            max(0.1, remaining / candidates_left),
        )
        elapsed = measure(ffmpeg, encoder, timeout)
        if elapsed is not None:
            timings.append((elapsed, encoder))

    return min(timings, key=lambda item: item[0])[1] if timings else CPU_ENCODER


def mark_hardware_fallback(marker: Path | None) -> None:
    if marker is None:
        return
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.touch(exist_ok=True)


def encode_timeout_seconds(duration_seconds: float, encoder: EncoderSpec) -> float:
    """Calculate a finite full-encode timeout from media duration.

    Software encoding gets a larger allowance because ASS rendering and x264
    are CPU-bound. Both paths are capped so a stuck FFmpeg process cannot block
    a task forever.
    """

    try:
        duration = max(1.0, float(duration_seconds))
    except (TypeError, ValueError):
        duration = 1.0
    if encoder.key == "cpu":
        return min(1200.0, max(60.0, duration * 8.0 + 30.0))
    return min(600.0, max(30.0, duration * 3.0 + 20.0))


def run_with_hardware_fallback(
    encoder: EncoderSpec,
    *,
    output: Path,
    duration_seconds: float,
    command_for: Callable[[EncoderSpec], Sequence[str]],
    runner: Callable[[list[str], float], None],
    marker: Path | None = None,
) -> EncoderSpec:
    """Run a full encode, retrying hardware failure once with libx264."""

    def run_and_validate(selected: EncoderSpec) -> None:
        timeout = encode_timeout_seconds(duration_seconds, selected)
        runner(list(command_for(selected)), timeout)
        if not output.is_file() or output.stat().st_size <= 1024:
            raise RuntimeError(f"video encoder produced no valid output: {output}")

    try:
        run_and_validate(encoder)
        return encoder
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired, RuntimeError):
        if encoder.key == "cpu":
            output.unlink(missing_ok=True)
            raise

    output.unlink(missing_ok=True)
    mark_hardware_fallback(marker)
    print(f"[警告] {encoder.label} 编码失败，已切换 CPU 编码重试...")
    try:
        run_and_validate(CPU_ENCODER)
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired, RuntimeError):
        output.unlink(missing_ok=True)
        raise
    return CPU_ENCODER
