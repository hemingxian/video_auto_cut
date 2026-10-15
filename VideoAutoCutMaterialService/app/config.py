from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv


def _integer(name: str, default: int, minimum: int = 1) -> int:
    raw = os.getenv(name, "").strip()
    value = int(raw) if raw else default
    if value < minimum:
        raise RuntimeError(f"{name} must be at least {minimum}")
    return value


def _boolean(name: str, default: bool = False) -> bool:
    raw = os.getenv(name, "").strip().lower()
    if not raw:
        return default
    if raw not in {"true", "false"}:
        raise RuntimeError(f"{name} must be true or false")
    return raw == "true"


@dataclass(frozen=True)
class Settings:
    database_url: str
    auth_me_url: str
    upload_service_url: str
    upload_service_token: str
    host: str
    port: int
    upload_max_bytes: int
    multipart_threshold_bytes: int
    part_size_bytes: int
    max_parallel_parts: int
    embedding_url: str
    embedding_token: str
    embedding_model: str
    vector_dimension: int
    cloud_vector_search_url: str
    cloud_vector_token: str
    consent_version: str
    platform_auto_sync_enabled: bool
    analysis_worker_token: str = ""
    cloud_vector_upsert_url: str = ""
    analysis_profile_id: str = "qwen3-vl-768-v1"
    analysis_model: str = "qwen3-vl"
    vector_backend: str = "pgvector"

    @classmethod
    def from_env(cls) -> "Settings":
        load_dotenv()
        embedding_token = (
            os.getenv("MATERIAL_EMBEDDING_TOKEN", "").strip()
            or os.getenv("DASHSCOPE_API_KEY", "").strip()
        )
        embedding_url = os.getenv("MATERIAL_EMBEDDING_URL", "").strip()
        if not embedding_url and embedding_token:
            relay_root = os.getenv("DASHSCOPE_BASE_URL", "").strip().rstrip("/")
            embedding_url = (
                f"{relay_root}/api/v1/services/embeddings/"
                "multimodal-embedding/multimodal-embedding"
                if relay_root
                else "https://dashscope.aliyuncs.com/api/v1/services/embeddings/"
                "multimodal-embedding/multimodal-embedding"
            )
        return cls(
            database_url=os.getenv("MATERIAL_DATABASE_URL", "").strip(),
            auth_me_url=os.getenv("MATERIAL_AUTH_ME_URL", "").strip(),
            upload_service_url=os.getenv("MATERIAL_UPLOAD_SERVICE_URL", "").strip().rstrip("/"),
            upload_service_token=os.getenv("MATERIAL_UPLOAD_SERVICE_TOKEN", "").strip(),
            host=os.getenv("MATERIAL_API_HOST", "127.0.0.1").strip(),
            port=_integer("MATERIAL_API_PORT", 8091),
            upload_max_bytes=_integer("MATERIAL_UPLOAD_MAX_BYTES", 5_000_000_000),
            multipart_threshold_bytes=_integer(
                "MATERIAL_UPLOAD_MULTIPART_THRESHOLD_BYTES", 67_108_864
            ),
            part_size_bytes=_integer("MATERIAL_UPLOAD_PART_SIZE_BYTES", 16_777_216),
            max_parallel_parts=_integer("MATERIAL_UPLOAD_MAX_PARALLEL_PARTS", 4),
            embedding_url=embedding_url,
            embedding_token=embedding_token,
            embedding_model=os.getenv(
                "MATERIAL_EMBEDDING_MODEL", "qwen3-vl-embedding"
            ).strip(),
            vector_dimension=_integer("MATERIAL_VECTOR_DIMENSION", 768),
            cloud_vector_search_url=os.getenv(
                "MATERIAL_CLOUD_VECTOR_SEARCH_URL", ""
            ).strip(),
            cloud_vector_token=os.getenv("MATERIAL_CLOUD_VECTOR_TOKEN", "").strip(),
            consent_version=os.getenv(
                "MATERIAL_PUBLICATION_CONSENT_VERSION", "2026-08"
            ).strip(),
            platform_auto_sync_enabled=_boolean(
                "MATERIAL_PLATFORM_AUTO_SYNC_ENABLED", True
            ),
            analysis_worker_token=os.getenv(
                "MATERIAL_ANALYSIS_WORKER_TOKEN", ""
            ).strip(),
            cloud_vector_upsert_url=os.getenv(
                "MATERIAL_CLOUD_VECTOR_UPSERT_URL", ""
            ).strip(),
            analysis_profile_id=os.getenv(
                "MATERIAL_ANALYSIS_PROFILE_ID", "qwen3-vl-768-v1"
            ).strip(),
            analysis_model=os.getenv("MATERIAL_ANALYSIS_MODEL", "qwen3-vl").strip(),
            vector_backend=os.getenv("MATERIAL_VECTOR_BACKEND", "pgvector").strip().lower(),
        )

    def validate_runtime(self) -> None:
        required = {
            "MATERIAL_DATABASE_URL": self.database_url,
            "MATERIAL_AUTH_ME_URL": self.auth_me_url,
            "MATERIAL_UPLOAD_SERVICE_URL": self.upload_service_url,
            "MATERIAL_UPLOAD_SERVICE_TOKEN": self.upload_service_token,
        }
        missing = [name for name, value in required.items() if not value]
        if missing:
            raise RuntimeError(f"Missing required configuration: {', '.join(missing)}")
        if self.vector_dimension != 768:
            raise RuntimeError("MATERIAL_VECTOR_DIMENSION must remain 768 for profile v1")
        if self.analysis_worker_token and len(self.analysis_worker_token) < 24:
            raise RuntimeError("MATERIAL_ANALYSIS_WORKER_TOKEN must be at least 24 characters")
        if self.vector_backend not in {"pgvector", "external"}:
            raise RuntimeError("MATERIAL_VECTOR_BACKEND must be pgvector or external")
        if not self.embedding_url or not self.embedding_token:
            raise RuntimeError(
                "MATERIAL_EMBEDDING_TOKEN (or DASHSCOPE_API_KEY) is required"
            )
        if self.vector_backend == "external" and not (
            self.cloud_vector_search_url
            and self.cloud_vector_upsert_url
            and self.cloud_vector_token
        ):
            raise RuntimeError(
                "External vector backend requires search URL, upsert URL and token"
            )
