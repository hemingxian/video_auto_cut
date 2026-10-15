from __future__ import annotations

import argparse
import os
import secrets
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_UPLOAD_ENV = PROJECT_ROOT.parent.parent / "video-auto-cut_upload" / ".env"


def parse_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def random_secret() -> str:
    return secrets.token_urlsafe(36)


def build_local_env(upload_values: dict[str, str], postgres_port: int) -> str:
    upload_token = upload_values.get("UPLOAD_PRIVATE_API_TOKEN", "").strip()
    if len(upload_token) < 24:
        raise RuntimeError("UPLOAD_PRIVATE_API_TOKEN is missing or shorter than 24 characters")

    owner_password = random_secret()
    app_password = random_secret()
    worker_token = random_secret()
    lines = [
        f"MATERIAL_POSTGRES_HOST_PORT={postgres_port}",
        f"MATERIAL_POSTGRES_OWNER_PASSWORD={owner_password}",
        f"MATERIAL_POSTGRES_PASSWORD={app_password}",
        f"MATERIAL_DATABASE_URL=postgresql://video_auto_cut:{app_password}@127.0.0.1:{postgres_port}/video_auto_cut_material",
        f"MATERIAL_MIGRATION_DATABASE_URL=postgresql://material_owner:{owner_password}@127.0.0.1:{postgres_port}/video_auto_cut_material",
        "MATERIAL_AUTH_ME_URL=https://api.evstai.com/api/v1/auth/me",
        "MATERIAL_UPLOAD_SERVICE_URL=http://127.0.0.1:8090",
        f"MATERIAL_UPLOAD_SERVICE_TOKEN={upload_token}",
        "MATERIAL_API_HOST=127.0.0.1",
        "MATERIAL_API_PORT=8091",
        "MATERIAL_UPLOAD_MAX_BYTES=160000000000",
        "MATERIAL_UPLOAD_MULTIPART_THRESHOLD_BYTES=67108864",
        "MATERIAL_UPLOAD_PART_SIZE_BYTES=16777216",
        "MATERIAL_UPLOAD_MAX_PARALLEL_PARTS=4",
        "MATERIAL_EMBEDDING_URL=",
        "MATERIAL_EMBEDDING_TOKEN=",
        "MATERIAL_EMBEDDING_MODEL=qwen3-vl-embedding",
        "MATERIAL_VECTOR_DIMENSION=768",
        "MATERIAL_CLOUD_VECTOR_SEARCH_URL=",
        "MATERIAL_CLOUD_VECTOR_UPSERT_URL=",
        "MATERIAL_CLOUD_VECTOR_TOKEN=",
        f"MATERIAL_ANALYSIS_WORKER_TOKEN={worker_token}",
        "MATERIAL_ANALYSIS_PROFILE_ID=qwen3-vl-768-v1",
        "MATERIAL_ANALYSIS_MODEL=qwen3-vl",
        "MATERIAL_PUBLICATION_CONSENT_VERSION=2026-08",
        "MATERIAL_PLATFORM_AUTO_SYNC_ENABLED=true",
    ]
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Create a secret local integration environment without exposing COS credentials.",
    )
    parser.add_argument("--upload-env", type=Path, default=DEFAULT_UPLOAD_ENV)
    parser.add_argument("--output", type=Path, default=PROJECT_ROOT / ".env")
    parser.add_argument("--postgres-port", type=int, default=5433)
    args = parser.parse_args()

    upload_env = args.upload_env.expanduser().resolve()
    output = args.output.expanduser().resolve()
    if output.exists():
        raise RuntimeError(f"Refusing to overwrite existing environment file: {output}")
    if not upload_env.is_file():
        raise RuntimeError(f"Upload service environment file was not found: {upload_env}")
    if not 1 <= args.postgres_port <= 65535:
        raise RuntimeError("PostgreSQL port must be between 1 and 65535")

    content = build_local_env(parse_env(upload_env), args.postgres_port)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(".env.tmp")
    temporary.write_text(content, encoding="utf-8", newline="\n")
    os.chmod(temporary, 0o600)
    temporary.replace(output)
    print(f"[PASS] local material service environment created: {output}")
    print("[PASS] COS credentials were not copied; only the internal upload-service token was linked")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
