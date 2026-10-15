"""Qwen3-VL embedding via Alibaba DashScope (百炼).

Video chunks: pass a *local file path* as ``video``. The DashScope Python SDK
uploads the file to DashScope-managed temporary OSS and replaces it with an
``oss://`` URL before calling the API — same pattern as the official docs'
\"暂不支持直接传入本地视频\" workaround without requiring your own bucket.

See: https://help.aliyun.com/dashscope/developer-reference/one-peace-multimodal-embedding-metering-and-billing

International region: set ``DASHSCOPE_HTTP_BASE_URL`` (see ``dashscope.common.env``).
"""

from __future__ import annotations

import os
import json
import math
import subprocess
import ssl
import sys
import time
from collections import deque
from http import HTTPStatus
from pathlib import Path

from dotenv import load_dotenv

from .base_embedder import BaseEmbedder
from .dashscope_config import dashscope_sdk_base_url

load_dotenv()

DEFAULT_MODEL = "qwen3-vl-embedding"
DIMENSIONS = 768
DEFAULT_RPM = int(os.environ.get("DASHSCOPE_RPM", "45"))
DEFAULT_VIDEO_FPS = float(os.environ.get("DASHSCOPE_VIDEO_FPS", "0.5"))


def request_timeout():
    value = float(os.environ.get("DASHSCOPE_REQUEST_TIMEOUT_SECONDS", "120"))
    if not math.isfinite(value) or not 1 <= value <= 900:
        raise ValueError("DASHSCOPE_REQUEST_TIMEOUT_SECONDS must be within 1..900")
    return value


def attempt_timeout():
    value = float(os.environ.get("VIDEOAUTO_QWEN_ATTEMPT_TIMEOUT_SECONDS", "180"))
    if not math.isfinite(value) or not 1 <= value <= 1800:
        raise ValueError("VIDEOAUTO_QWEN_ATTEMPT_TIMEOUT_SECONDS must be within 1..1800")
    return value


def default_dashscope_embedding_model() -> str:
    """Return the DashScope embedding model id from env or the built-in default."""
    return os.environ.get("DASHSCOPE_EMBEDDING_MODEL") or DEFAULT_MODEL


def _ensure_windows_ca_bundle() -> str:
    """Use the Windows trust store when a packaged certifi bundle is absent."""
    if os.name != "nt":
        return ""
    for name in ("REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "SSL_CERT_FILE"):
        configured = os.environ.get(name, "").strip()
        if configured and os.path.isfile(configured):
            return configured
    try:
        import certifi

        bundled = certifi.where()
        if bundled and os.path.isfile(bundled):
            return bundled
    except (ImportError, OSError):
        pass

    config_root = os.environ.get("VIDEOAUTO_CONFIG_ROOT", "").strip()
    if not config_root:
        data_root = os.environ.get("VIDEOAUTO_DATA_ROOT", "").strip()
        config_root = os.path.join(data_root, "config") if data_root else str(Path.home() / ".sentrysearch")
    bundle_path = Path(config_root) / "windows-ca-bundle.pem"
    try:
        if not bundle_path.is_file() or bundle_path.stat().st_size == 0:
            certificates: list[str] = []
            seen: set[bytes] = set()
            for store_name in ("ROOT", "CA"):
                for certificate, encoding, _trust in ssl.enum_certificates(store_name):
                    if encoding != "x509_asn" or certificate in seen:
                        continue
                    seen.add(certificate)
                    certificates.append(ssl.DER_cert_to_PEM_cert(certificate))
            if not certificates:
                return ""
            bundle_path.parent.mkdir(parents=True, exist_ok=True)
            temporary_path = bundle_path.with_suffix(".tmp")
            temporary_path.write_text("\n".join(certificates) + "\n", encoding="ascii")
            os.replace(temporary_path, bundle_path)
    except OSError:
        return ""
    resolved = str(bundle_path)
    os.environ.setdefault("REQUESTS_CA_BUNDLE", resolved)
    os.environ.setdefault("SSL_CERT_FILE", resolved)
    return resolved


class DashScopeAPIKeyError(RuntimeError):
    """Raised when DASHSCOPE_API_KEY is missing."""


class DashScopeAPIError(RuntimeError):
    """Raised when the DashScope API returns an error response."""


class DashScopeDependencyError(RuntimeError):
    """Raised when the optional ``dashscope`` package is not installed."""


class _RateLimiter:
    """Sliding-window rate limiter (requests per minute)."""

    def __init__(self, max_per_minute: int):
        self._max = max_per_minute
        self._timestamps: deque[float] = deque()

    def wait(self) -> None:
        now = time.monotonic()
        while self._timestamps and now - self._timestamps[0] >= 60:
            self._timestamps.popleft()
        if len(self._timestamps) >= self._max:
            sleep_for = 60.0 - (now - self._timestamps[0])
            if sleep_for > 0:
                time.sleep(sleep_for)
        self._timestamps.append(time.monotonic())


def _is_transient_transport_error(exc: BaseException) -> bool:
    """True for typical HTTP client / TLS / socket failures worth retrying."""
    try:
        import requests
    except ImportError:
        requests = None  # type: ignore[assignment]

    if requests is not None and isinstance(
        exc,
        (
            requests.exceptions.ConnectionError,
            requests.exceptions.Timeout,
            requests.exceptions.ChunkedEncodingError,
            requests.exceptions.SSLError,
        ),
    ):
        return True
    if isinstance(exc, (TimeoutError, BrokenPipeError, ConnectionResetError)):
        return True
    msg = str(exc).lower()
    return any(
        k in msg
        for k in (
            "connection",
            "timeout",
            "timed out",
            "reset by peer",
            "ssl",
            "eof",
            "broken pipe",
            "temporarily unavailable",
        )
    )


def _retry(fn, *, max_retries: int = 2, initial_delay: float = 2.0, max_delay: float = 60.0):
    """Retry on throttling, API errors, and transient network/transport failures."""
    delay = initial_delay
    for attempt in range(max_retries + 1):
        try:
            return fn()
        except DashScopeAPIError as exc:
            msg = str(exc).lower()
            retryable = (
                "429" in msg
                or "rate" in msg
                or "throttl" in msg
                or "quota" in msg
                or "503" in msg
            )
            if not retryable or attempt == max_retries:
                raise
            wait = min(delay, max_delay)
            print(
                f"  Retryable DashScope error (attempt {attempt + 1}/{max_retries}), "
                f"waiting {wait:.0f}s: {exc}",
                file=sys.stderr,
            )
            time.sleep(wait)
            delay *= 2
        except Exception as exc:  # noqa: BLE001 — narrow follow-up below
            if not _is_transient_transport_error(exc) or attempt == max_retries:
                raise
            wait = min(delay, max_delay)
            print(
                f"  Retryable transport error (attempt {attempt + 1}/{max_retries}), "
                f"waiting {wait:.0f}s: {exc}",
                file=sys.stderr,
            )
            time.sleep(wait)
            delay *= 2


class QwenCloudEmbedder(BaseEmbedder):
    """DashScope multimodal embedding (e.g. ``qwen3-vl-embedding``)."""

    def __init__(
        self,
        model_name: str | None = None,
        *,
        dimensions: int = DIMENSIONS,
        video_fps: float | None = None,
    ):
        _ensure_windows_ca_bundle()
        try:
            import dashscope
            from dashscope import MultiModalEmbedding
        except ImportError as exc:
            raise DashScopeDependencyError(
                "The dashscope package is not installed.\n\n"
                'Install optional dependencies: uv tool install ".[qwen-cloud]"'
            ) from exc

        sdk_base_url = dashscope_sdk_base_url()
        if sdk_base_url:
            # dashscope reads this variable during import. Updating both values
            # also handles processes where another module imported it earlier.
            os.environ["DASHSCOPE_HTTP_BASE_URL"] = sdk_base_url
            dashscope.base_http_api_url = sdk_base_url

        self._MultiModalEmbedding = MultiModalEmbedding
        api_key = os.environ.get("DASHSCOPE_API_KEY")
        if not api_key:
            raise DashScopeAPIKeyError(
                "DASHSCOPE_API_KEY is not set.\n\n"
                "Create a key in the Alibaba Cloud Model Studio console, then:\n"
                "  export DASHSCOPE_API_KEY=your-key\n\n"
                "Or add it to ~/.sentrysearch/.env\n\n"
                "Install the SDK:\n"
                '  uv tool install ".[qwen-cloud]"'
            )

        self._api_key = api_key
        self._model = model_name or default_dashscope_embedding_model()
        self._dimensions = dimensions
        self._video_fps = (
            video_fps if video_fps is not None else DEFAULT_VIDEO_FPS
        )
        self._limiter = _RateLimiter(max_per_minute=DEFAULT_RPM)

    def embed_video_chunk(self, chunk_path: str, verbose: bool = False) -> list[float]:
        if not os.path.isfile(chunk_path):
            raise FileNotFoundError(f"Chunk file not found: {chunk_path}")

        contents = [{"video": chunk_path, "factor": 1.0}]
        params = {
            "dimension": self._dimensions,
            "fps": self._video_fps,
        }
        return self._embed_one(
            contents,
            params,
            verbose=verbose,
            label="video",
            extra_kb=os.path.getsize(chunk_path) / 1024,
        )

    def embed_query(self, query_text: str, verbose: bool = False) -> list[float]:
        contents = [{"text": query_text, "factor": 1.0}]
        params = {"dimension": self._dimensions}
        return self._embed_one(contents, params, verbose=verbose, label="query")

    def embed_image(self, image_path: str, verbose: bool = False) -> list[float]:
        if not os.path.isfile(image_path):
            raise FileNotFoundError(f"Image file not found: {image_path}")

        contents = [{"image": image_path, "factor": 1.0}]
        params = {"dimension": self._dimensions}
        return self._embed_one(
            contents,
            params,
            verbose=verbose,
            label="image",
            extra_kb=os.path.getsize(image_path) / 1024,
        )

    def dimensions(self) -> int:
        return self._dimensions

    def _embed_one(
        self,
        contents: list[dict],
        parameters: dict,
        *,
        verbose: bool,
        label: str,
        extra_kb: float | None = None,
    ) -> list[float]:
        t0 = time.monotonic()

        def call():
            self._limiter.wait()
            if label == "video":
                return self._video_request(contents, parameters)
            resp = self._MultiModalEmbedding.call(
                model=self._model,
                input=contents,
                api_key=self._api_key,
                request_timeout=request_timeout(),
                **parameters,
            )
            return self._parse_embedding_response(resp)

        embedding = _retry(call)
        if len(embedding) != self._dimensions:
            raise DashScopeAPIError(
                f"DashScope returned {len(embedding)} dimensions; expected {self._dimensions}."
            )
        elapsed = time.monotonic() - t0

        if verbose:
            detail = f"dims={len(embedding)}, api_time={elapsed:.2f}s"
            if extra_kb is not None:
                detail = f"size={extra_kb:.0f}KB, {detail}"
            print(f"  [verbose] {label} embedding: {detail}", file=sys.stderr)

        return embedding

    def _video_request(self, contents, parameters):
        """Bound SDK upload + inference together, including SDK-internal waits."""
        timeout = attempt_timeout()
        payload = {"model": self._model, "contents": contents, "parameters": parameters}
        started = time.monotonic()
        try:
            result = subprocess.run(
                [sys.executable, "-m", "sentrysearch.qwen_request_worker"],
                input=json.dumps(payload), capture_output=True, text=True, encoding="utf-8",
                errors="replace", timeout=timeout,
            )
        except subprocess.TimeoutExpired as exc:
            raise TimeoutError(f"Qwen upload/inference attempt exceeded {timeout}s") from exc
        lines = [line for line in result.stdout.splitlines() if line.startswith("VACUT_EMBED_RESULT:")]
        if not lines:
            raise DashScopeAPIError(f"Qwen worker failed ({result.returncode}); no embedding result")
        response = json.loads(lines[-1].split(":", 1)[1])
        print(f"  Qwen request attempt finished in {time.monotonic()-started:.2f}s", file=sys.stderr)
        if not response.get("ok"):
            if response.get("transient"):
                raise TimeoutError(response.get("error", "Qwen transport failed"))
            raise DashScopeAPIError(response.get("error", "Qwen request failed"))
        if result.returncode:
            raise DashScopeAPIError(f"Qwen worker exited {result.returncode} after response")
        return response["embedding"]

    @staticmethod
    def _parse_embedding_response(resp) -> list[float]:
        status_code = getattr(resp, "status_code", None)
        if status_code != HTTPStatus.OK:
            code = resp.get("code") or ""
            msg = resp.get("message") or ""
            raise DashScopeAPIError(
                f"DashScope API error (HTTP {status_code}, code={code!r}): {msg}"
            )

        output = resp.get("output") or {}
        embeddings = output.get("embeddings") or []
        if not embeddings:
            raise DashScopeAPIError(
                "DashScope response contained no embeddings in output."
            )
        vec = embeddings[0].get("embedding")
        if not vec:
            raise DashScopeAPIError(
                "DashScope response missing embedding vector for first content."
            )
        return list(vec)
