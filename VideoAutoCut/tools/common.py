#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Shared helpers for VideoAuto tool scripts."""
from __future__ import annotations

import gzip
import os
import re
import socket
import ssl
import subprocess
import time
import http.client
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from text_layout import text_width, wrap_text, wrap_text_pixels

REMOTE_SECRET_ENV_KEYS = {
    "DASHSCOPE_API_KEY",
    "PEXELS_API_KEY",
    "PIXABAY_API_KEY",
    "JAMENDO_CLIENT_ID",
    "OPENVERSE_CLIENT_ID",
    "OPENVERSE_CLIENT_SECRET",
}

TRUE_VALUES = {"1", "true", "yes", "y", "on"}
FALSE_VALUES = {"0", "false", "no", "n", "off"}
DEFAULT_HTTP_USER_AGENT = "VideoAutoCutEngine/1.0"


def dashscope_base_url() -> str:
    """Return the optional relay root used for every DashScope API.

    ``DASHSCOPE_BASE_URL`` is deliberately a root URL (for example
    ``https://api.example.com``), not an individual API endpoint. When it is
    absent, callers keep their existing endpoint override and the official
    DashScope default.
    """
    return os.environ.get("DASHSCOPE_BASE_URL", "").strip().rstrip("/")


def dashscope_url(path: str, *, override_env: str, default: str) -> str:
    """Resolve a DashScope endpoint while keeping direct-call compatibility.

    The relay root is the master switch and therefore wins over old endpoint
    variables that may still exist in an installed workspace's ``.env``.
    """
    relay_root = dashscope_base_url()
    if relay_root:
        return f"{relay_root}/{path.lstrip('/')}"
    configured = os.environ.get(override_env, "").strip()
    return configured or default


def runtime_root() -> Path:
    configured = os.environ.get("VIDEOAUTO_RUNTIME_ROOT", "").strip() or os.environ.get("VIDEOAUTO_ROOT", "").strip()
    return Path(configured) if configured else Path(__file__).resolve().parents[1]


def data_root() -> Path:
    configured = os.environ.get("VIDEOAUTO_DATA_ROOT", "").strip() or os.environ.get("VIDEOAUTO_WORKSPACE_DIR", "").strip()
    return Path(configured) if configured else runtime_root()


def config_root() -> Path:
    configured = os.environ.get("VIDEOAUTO_CONFIG_ROOT", "").strip()
    return Path(configured) if configured else data_root() / "config"


def env_path() -> Path:
    configured = os.environ.get("VIDEOAUTO_ENV_PATH", "").strip()
    if configured:
        return Path(configured)
    if os.environ.get("VIDEOAUTO_CONFIG_ROOT", "").strip():
        return config_root() / "app.env"
    return data_root() / ".env"


def app_root() -> Path:
    return runtime_root()


def prompt_template_paths(name: str) -> list[Path]:
    candidates: list[Path] = []
    configured = os.environ.get("VIDEOAUTO_PYTHON_PROMPT_DIR", "").strip()
    if configured:
        candidates.append(Path(configured) / name)

    root = runtime_root()
    candidates.append(root / "tools" / "prompts" / name)

    cwd = Path.cwd()
    candidates.append(cwd / "tools" / "prompts" / name)
    candidates.append(cwd / "VideoAutoCut" / "tools" / "prompts" / name)
    if cwd.parent:
        candidates.append(cwd.parent / "VideoAutoCut" / "tools" / "prompts" / name)

    unique: list[Path] = []
    seen: set[str] = set()
    for path in candidates:
        key = str(path)
        if key not in seen:
            unique.append(path)
            seen.add(key)
    return unique


def load_prompt_template(name: str) -> str:
    candidates = prompt_template_paths(name)
    for path in candidates:
        if path.is_file():
            return path.read_text(encoding="utf-8")
    searched = ", ".join(str(path) for path in candidates)
    raise FileNotFoundError(f"缺少提示词模板: {name}，已查找: {searched}")


def render_prompt_template(template: str, values: dict[str, object]) -> str:
    text = template
    for key, value in values.items():
        text = text.replace("{{" + key + "}}", "" if value is None else str(value))
    return text


def temp_root(subdir: str | None = None) -> Path:
    """Central directory for generated temporary files.

    Default: <VideoAuto data>/temp.
    You can override with VIDEOAUTO_TEMP_DIR in .env. Relative values are
    resolved under the data root; absolute values are used directly.
    """
    configured = os.environ.get("VIDEOAUTO_TEMP_DIR", "").strip()
    if configured:
        base = Path(configured)
        root = base if base.is_absolute() else data_root() / base
    else:
        root = data_root() / "temp"
    path = root / subdir if subdir else root
    path.mkdir(parents=True, exist_ok=True)
    return path


def temp_path(prefix: str = "tmp", suffix: str = "", subdir: str | None = None) -> Path:
    safe = re.sub(r"[^0-9A-Za-z一-龥._-]+", "_", prefix or "tmp").strip("._-")
    if not safe:
        safe = "tmp"
    if len(safe) > 60:
        safe = safe[:60]
    if suffix and not suffix.startswith("."):
        suffix = "." + suffix
    return temp_root(subdir) / f"{safe}_{os.getpid()}_{uuid.uuid4().hex[:8]}{suffix}"


def load_dotenv(path: Path | None = None) -> None:
    path = path or env_path()
    if not path.exists():
        return
    require_remote_config = bool(parse_bool(os.environ.get("VIDEOAUTO_REQUIRE_REMOTE_CONFIG"), False))
    remote_config_keys = {
        item.strip()
        for item in os.environ.get("VIDEOAUTO_REMOTE_CONFIG_KEYS", "").split(",")
        if item.strip()
    }
    for raw in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if require_remote_config and key in REMOTE_SECRET_ENV_KEYS and key not in remote_config_keys:
            continue
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


def env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        return default


def transient_http_status(code: int) -> bool:
    return code in {408, 425, 429, 500, 502, 503, 504}


def transient_network_error(exc: BaseException) -> bool:
    if isinstance(exc, urllib.error.HTTPError):
        return transient_http_status(exc.code)

    if isinstance(exc, urllib.error.URLError):
        reason = getattr(exc, "reason", None)
        if isinstance(reason, BaseException) and transient_network_error(reason):
            return True

    if isinstance(
        exc,
        (
            TimeoutError,
            socket.timeout,
            ssl.SSLError,
            ConnectionResetError,
            ConnectionAbortedError,
            BrokenPipeError,
            http.client.IncompleteRead,
            http.client.RemoteDisconnected,
        ),
    ):
        return True

    message = str(exc).lower()
    return any(
        text in message
        for text in (
            "connection",
            "timeout",
            "timed out",
            "reset by peer",
            "ssl",
            "eof",
            "broken pipe",
            "temporarily unavailable",
            "remote end closed",
        )
    )


def with_default_user_agent(request: str | urllib.request.Request) -> urllib.request.Request:
    user_agent = os.environ.get("VIDEOAUTO_HTTP_USER_AGENT", "").strip() or DEFAULT_HTTP_USER_AGENT
    if isinstance(request, str):
        return urllib.request.Request(request, headers={"User-Agent": user_agent})
    if not request.get_header("User-agent"):
        request.add_header("User-Agent", user_agent)
    return request


def read_http_response_bytes(response) -> bytes:
    payload = response.read()
    headers = getattr(response, "headers", None)
    content_encoding = str(headers.get("Content-Encoding", "") if headers else "").lower()
    if payload.startswith(b"\x1f\x8b") or "gzip" in content_encoding:
        try:
            return gzip.decompress(payload)
        except (EOFError, OSError):
            return payload
    return payload


def read_http_response_text(response, *, errors: str = "replace") -> str:
    return read_http_response_bytes(response).decode("utf-8", errors=errors)


def urlopen_with_retry(
    request: str | urllib.request.Request,
    *,
    timeout: int = 120,
    attempts: int | None = None,
    label: str = "HTTP request",
):
    request = with_default_user_agent(request)
    total_attempts = attempts or max(1, env_int("VIDEOAUTO_HTTP_RETRIES", 5))
    base_delay = max(0.1, env_float("VIDEOAUTO_HTTP_RETRY_DELAY", 2.0))
    max_delay = max(base_delay, env_float("VIDEOAUTO_HTTP_RETRY_MAX_DELAY", 30.0))
    last_error: BaseException | None = None

    for attempt in range(1, total_attempts + 1):
        try:
            return urllib.request.urlopen(request, timeout=timeout)
        except urllib.error.HTTPError as exc:
            last_error = exc
            if not transient_http_status(exc.code) or attempt >= total_attempts:
                raise
            wait = min(max_delay, base_delay * (2 ** (attempt - 1)))
            print(f"[警告] {label} HTTP {exc.code}，{wait:.1f} 秒后重试 {attempt}/{total_attempts}...")
            time.sleep(wait)
        except Exception as exc:
            last_error = exc
            if not transient_network_error(exc) or attempt >= total_attempts:
                raise
            wait = min(max_delay, base_delay * (2 ** (attempt - 1)))
            print(f"[警告] {label} 网络连接失败：{exc}，{wait:.1f} 秒后重试 {attempt}/{total_attempts}...")
            time.sleep(wait)

    if last_error:
        raise last_error
    raise RuntimeError(f"{label} failed")


def find_ffmpeg() -> str:
    root = runtime_root()
    candidates = [
        root / "ffmpeg" / "bin" / "ffmpeg.exe",
        root / "ffmpeg.exe",
    ]
    for c in candidates:
        if c.exists():
            return str(c)
    return "ffmpeg"


def run(cmd: list[str]) -> None:
    print(">>>", " ".join(f'"{c}"' if " " in c else c for c in cmd))
    subprocess.run(cmd, check=True)


def env_int(name: str, default: int) -> int:
    try:
        value = os.environ.get(name, str(default)).strip().lower()
        if value in TRUE_VALUES:
            return 1
        if value in FALSE_VALUES:
            return 0
        return int(value)
    except (AttributeError, TypeError, ValueError):
        return default


def parse_bool(value: object, default: bool | None = False) -> bool | None:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    text = str(value).strip().lower()
    if not text:
        return default
    if text in TRUE_VALUES:
        return True
    if text in FALSE_VALUES:
        return False
    return default


def strict_bool(value: object, field: str, default: bool | None = None) -> bool | None:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    raise ValueError(f"{field} must be a JSON boolean")


def env_bool(name: str, default: bool = False) -> bool:
    parsed = parse_bool(os.environ.get(name), default)
    return bool(parsed)


def ass_time(seconds: float) -> str:
    total_cs = int(round(max(seconds, 0) * 100))
    cs = total_cs % 100
    total_s = total_cs // 100
    s = total_s % 60
    total_m = total_s // 60
    m = total_m % 60
    h = total_m // 60
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def escape_ass(text: str) -> str:
    return (text or "").replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}").replace("\n", "\\N")


def split_lines(text: str, max_chars: int = 24, max_lines: int = 2) -> list[str]:
    chars = [c for c in (text or "").strip() if c.isprintable()]
    lines: list[str] = []
    while chars and len(lines) < max_lines:
        take = min(len(chars), max_chars)
        lines.append("".join(chars[:take]))
        del chars[:take]
    if chars and lines:
        lines[-1] += "…"
    return lines


def visible_text_len(text: str) -> int:
    return sum(1 for ch in (text or "") if not ch.isspace())


def split_subtitle_lines_preserve(text: str, max_chars: int = 24) -> list[str]:
    """Wrap at word/CJK boundaries, retaining spaces and complete long words."""
    max_chars = max(1, int(max_chars or 24))
    return wrap_text(
        (text or "").strip(),
        lambda candidate: len(candidate) <= max_chars,
        cjk_word_boundaries=True,
    )


def subtitle_display_pages(text: str, max_chars: int = 24, max_lines: int = 2, *, max_width: float | None = None, font: str = "Microsoft YaHei", font_size: int = 68) -> list[list[str]]:
    single_line = subtitle_display_line(text)
    single_line_limit = int(os.environ.get("SUBTITLE_SINGLE_LINE_MAX_CHARS", str(max_chars + 4)))
    if max_width is not None:
        lines = wrap_text_pixels(
            single_line,
            max_width,
            font,
            font_size,
            cjk_word_boundaries=True,
        )
    elif single_line and "\n" not in single_line and visible_text_len(single_line) <= single_line_limit:
        return [[single_line]]
    else:
        lines = split_subtitle_lines_preserve(text, max_chars=max_chars)
    max_lines = max(1, int(max_lines or 2))
    return [lines[i:i + max_lines] for i in range(0, len(lines), max_lines)]


def subtitle_display_line(text: str) -> str:
    return (text or "").strip().rstrip("、，,。！？!?；;：:")


def subtitle_display_wrapped_line(text: str) -> str:
    """Apply the accepted line-end punctuation style without losing whitespace."""
    line = text or ""
    match = re.search(r"[^\S\r\n]*$", line)
    suffix = match.group(0) if match else ""
    body = line[:-len(suffix)] if suffix else line
    return body.rstrip("、，,。！？!?；;：:") + suffix


def subtitle_events_from_timed_text(
    text: str,
    start_seconds: float,
    end_seconds: float,
    *,
    style: str = "Subtitle",
    layer: int = 5,
    y: int = 870,
    line_gap: int = 80,
    max_chars: int = 22,
    max_lines: int = 2,
    anchor: str = "center",
    max_width: float | None = None,
    font: str = "Microsoft YaHei",
    font_size: int = 68,
) -> str:
    """Render subtitle pages without truncating text."""
    pages = subtitle_display_pages(text, max_chars=max_chars, max_lines=max_lines, max_width=max_width, font=font, font_size=font_size)
    if not pages or end_seconds <= start_seconds:
        return ""

    duration = max(0.1, end_seconds - start_seconds)
    weights = [max(1, sum(visible_text_len(line) for line in page)) for page in pages]
    total_weight = sum(weights) or 1

    events = ""
    cursor = start_seconds
    for page_idx, (page, weight) in enumerate(zip(pages, weights)):
        page_start = cursor
        page_end = end_seconds if page_idx == len(pages) - 1 else min(end_seconds, cursor + duration * weight / total_weight)
        cursor = page_end
        base_y = y - (len(page) - 1) * line_gap // 2
        if anchor == "top":
            base_y = y
        elif anchor == "bottom":
            base_y = y - (len(page) - 1) * line_gap
        alignment = r"\an8" if anchor == "top" else r"\an2" if anchor == "bottom" else ""
        for line_idx, line in enumerate(page):
            # Keep the accepted subtitle style: punctuation which lands at a
            # soft line ending is removed, while carried U+0020 remains intact.
            line = subtitle_display_wrapped_line(line)
            if not line:
                continue
            line_y = base_y + line_idx * line_gap
            size_tag = ""
            if max_width is not None:
                # An indivisible product name can be wider than the entire
                # caption area. Scale that line as a whole instead of slicing it.
                fitted_size = font_size
                while fitted_size > 1 and text_width(line, font, fitted_size) > max_width:
                    fitted_size -= 1
                size_tag = f"\\fs{fitted_size}"
            events += (
                f"Dialogue: {layer},{ass_time(page_start)},{ass_time(page_end)},{style},,0,0,0,,"
                f"{{{alignment}{size_tag}\\pos({int(os.environ.get('VIDEOAUTO_OUTPUT_WIDTH', '1920')) // 2},{line_y})}}{escape_ass(line)}\n"
            )
    return events


def split_subtitle_sentences(text: str, max_chars: int = 42) -> list[str]:
    """Split voiceover into natural sentence-level chunks.

    Important: do NOT split at commas. Comma splitting makes口播和字幕都很碎，
    especially with English brand names like FANUC、ABB、KUKA.
    We only split at strong sentence punctuation.
    """
    text = re.sub(r"\s+", " ", (text or "").strip())
    if not text:
        return []
    parts = [p.strip() for p in re.findall(r"[^。！？!?；;]+[。！？!?；;]?", text) if p.strip()]
    if not parts:
        parts = [text]
    return parts


def subtitle_weight(sentence: str) -> float:
    """Approximate spoken duration weight for a subtitle chunk."""
    s = sentence or ""
    # Chinese TTS duration tracks character count reasonably well; punctuation adds pause.
    chars = sum(1 for c in s if not c.isspace())
    pause = 0.0
    for c in s:
        if c in "。！？!?；;":
            pause += 4.0
        elif c in "，,、：:":
            pause += 2.0
    return max(4.0, chars + pause)


def subtitle_events_by_sentence(
    text: str,
    duration: float,
    *,
    style: str = "Subtitle",
    layer: int = 5,
    y: int = 870,
    max_chars: int | None = None,
    anchor: str = "center",
    line_gap: int | None = None,
    max_width: float | None = None,
    font: str = "Microsoft YaHei",
    font_size: int = 68,
) -> str:
    sentences = split_subtitle_sentences(text)
    if not sentences:
        return ""
    duration = max(1.0, float(duration))

    # Keep a small tail gap so the final subtitle does not hang too long after voice ends.
    usable_duration = max(0.8, duration - 0.15)
    weights = [subtitle_weight(s) for s in sentences]
    total_weight = sum(weights) or 1.0

    events = ""
    t = 0.0
    for idx, (sentence, weight) in enumerate(zip(sentences, weights)):
        seg = usable_duration * weight / total_weight
        # Avoid flickering: very short chunks get at least 0.65s when possible.
        if len(sentences) * 0.65 <= usable_duration:
            seg = max(0.65, seg)
        start_t = min(t, usable_duration)
        end_t = usable_duration if idx == len(sentences) - 1 else min(usable_duration, t + seg)
        if end_t <= start_t:
            end_t = min(duration, start_t + 0.25)
        t = end_t

        events += subtitle_events_from_timed_text(
            sentence,
            start_t,
            end_t,
            style=style,
            layer=layer,
            y=y,
            line_gap=line_gap if line_gap is not None else env_int("SUBTITLE_LINE_GAP", 80),
            max_chars=max_chars if max_chars is not None else env_int("SUBTITLE_LINE_MAX_CHARS", 22),
            max_lines=2,
            anchor=anchor,
            max_width=max_width,
            font=font,
            font_size=font_size,
        )
    return events


def clean_label(text: str, index: int) -> str:
    text = (text or "").strip()
    if not text:
        return f"模块{index}"
    for sep in ("：", ":"):
        if sep in text:
            prefix, rest = text.split(sep, 1)
            if len(prefix) <= 12:
                text = rest.strip()
            break
    for sep in ("，", ",", "；", ";", "。"):
        if sep in text:
            text = text.split(sep, 1)[0].strip()
            break
    return text or f"模块{index}"
