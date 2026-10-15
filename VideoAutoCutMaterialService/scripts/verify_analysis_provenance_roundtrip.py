"""Exercise real repository SQL against PostgreSQL TEMP tables, then roll back.

Run from a checkout containing the matching app and migration files, with
MATERIAL_DATABASE_URL already set (or supplied by --env-file). No DSN is printed.
Production tables are used only as schema templates. Their rows, triggers and
foreign keys are not copied; this verifies SQL/JSONB/vector transport, not RLS.
"""
from __future__ import annotations

import argparse
import asyncio
from contextlib import asynccontextmanager
import copy
import json
import os
from pathlib import Path
import sys

SERVICE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_ROOT))

import psycopg
from psycopg import sql
from psycopg.rows import dict_row
from psycopg.pq import TransactionStatus
from dotenv import load_dotenv

from app.errors import ServiceError
from app.models import ClientAnalysisResultRequest
from app.repository import MaterialRepository


TABLES = ("material", "asset_version", "analysis", "analysis_chunk", "vector_outbox", "sync_change")
OWNER = "provenance_roundtrip_owner"


class TemporaryRepository(MaterialRepository):
    def __init__(self, connection: psycopg.AsyncConnection) -> None:
        # Do not create a pool, another connection, or any maintenance scope.
        self.fixed_connection = connection

    @asynccontextmanager
    async def connection(self, user_id: str, role: str = "user"):
        # Repository transactions are nested savepoints within our outer rollback.
        async with self.fixed_connection.transaction():
            await self.fixed_connection.execute(
                "SELECT set_config('app.user_id', %s, true), "
                "set_config('app.actor_role', %s, true)",
                (user_id, role),
            )
            yield self.fixed_connection


def make_payload(*, legacy: bool = False) -> ClientAnalysisResultRequest:
    suffix = "legacy" if legacy else "receipt"
    provenance = {
        "schema_version": 1,
        "source_identity": {
            "source_sha256": "a" * 64,
            "source_size": 1024,
            "normalization_profile": {
                "contract": "h264-index-normalization-v1",
                "encoder": "cpu",
                "ffmpeg_sha256": "b" * 64,
                "ffmpeg_arguments": ["-i", "$SOURCE", "-c:v", "libx264", "$OUTPUT"],
            },
        },
        "analysis_profile": {
            "contract": "sentry-analysis-v1",
            "backend": "qwen-cloud",
            "model": "qwen3-vl-embedding",
            "dimensions": 768,
            "chunk_duration": 30,
            "future_parameter": {"说明": "保持未来参数", "levels": [1, 0.5, True]},
        },
        "duration": 2,
        "spans": [[0, 1], [1, 2]],
        "still_spans": [],
    }
    return ClientAnalysisResultRequest.model_validate({
        "asset_id": f"asset_{suffix}",
        "asset_version": 1,
        "source_sha256": "a" * 64,
        "file_size_bytes": 1024,
        "analysis_profile_id": f"profile_{suffix}",
        "embedding_backend": "qwen-cloud",
        "model_name": "qwen3-vl-embedding",
        "model_version": "roundtrip-v1",
        "dimension": 768,
        "result_schema_version": 1,
        **({} if legacy else {"analysis_provenance": provenance}),
        "chunks": [{
            "chunk_id": f"chunk_{index}",
            "start_ms": index * 1000,
            "end_ms": (index + 1) * 1000,
            "caption": f"真实 SQL 验证片段 {index}",
            "embedding": [float(index), 0.5] + [0.0] * 766,
        } for index in range(2)],
    })


async def expect_service_error(call, *, code: str, status: int) -> None:
    try:
        await call
    except ServiceError as error:
        assert (error.code, error.status_code) == (code, status), error.code
    else:
        raise AssertionError(f"Expected {code}")


async def verify(database_url: str) -> dict:
    connection = await psycopg.AsyncConnection.connect(
        database_url, row_factory=dict_row, connect_timeout=10,
        application_name="provenance_temp_roundtrip", autocommit=False,
    )
    result = {}
    try:
        await connection.execute("BEGIN")
        await connection.execute("SET LOCAL statement_timeout = '30s'")
        await connection.execute("SET LOCAL lock_timeout = '5s'")
        for table in TABLES:
            await connection.execute(sql.SQL(
                "CREATE TEMP TABLE {} (LIKE public.{} INCLUDING DEFAULTS "
                "INCLUDING CONSTRAINTS INCLUDING INDEXES) ON COMMIT DROP"
            ).format(sql.Identifier(table), sql.Identifier(table)))
        await connection.execute("SET LOCAL search_path = pg_temp, public")
        # INCLUDING DEFAULTS would retain the production sequence reference.
        # Analysis completion now publishes sync events, so isolate that counter too.
        await connection.execute("CREATE TEMP SEQUENCE provenance_sync_sequence")
        await connection.execute(
            "ALTER TABLE pg_temp.sync_change ALTER COLUMN sequence_id "
            "SET DEFAULT nextval('pg_temp.provenance_sync_sequence')"
        )
        for table in TABLES:
            row = await (await connection.execute(
                "SELECT c.relnamespace = pg_my_temp_schema() AS isolated "
                "FROM pg_class c WHERE c.oid = to_regclass(%s)", (table,),
            )).fetchone()
            assert row and row["isolated"], f"Unsafe table resolution: {table}"

        # Exercise the real migration on the temporary pre-migration schema only.
        await connection.execute("ALTER TABLE pg_temp.analysis DROP COLUMN IF EXISTS analysis_provenance")
        migration = (SERVICE_ROOT / "migrations/015_analysis_provenance.sql").read_text("utf-8")
        statements = "\n".join(line for line in migration.splitlines() if not line.strip().startswith("--")).strip()
        assert statements == "ALTER TABLE analysis ADD COLUMN IF NOT EXISTS analysis_provenance JSONB;", "Review migration safety before running"
        await connection.execute(statements)
        await connection.execute(statements)  # Migration remains idempotent.

        repo = TemporaryRepository(connection)
        for legacy in (False, True):
            payload = make_payload(legacy=legacy)
            suffix = "legacy" if legacy else "receipt"
            material_id = f"material_{suffix}"
            await connection.execute(
                "INSERT INTO pg_temp.asset_version(asset_id, asset_version, source_sha256, source_size) "
                "VALUES (%s, 1, %s, 1024)", (payload.asset_id, "a" * 64),
            )
            await connection.execute(
                "INSERT INTO pg_temp.material(material_id, owner_id, folder_id, asset_id, "
                "asset_version, display_name, added_from) VALUES (%s, %s, 'temp_folder', %s, 1, 'temp.mp4', 'user_import')",
                (material_id, OWNER, payload.asset_id),
            )
            analysis_id = await repo.submit_client_analysis(
                user_id=OWNER, device_id="temporary_device", material_id=material_id, payload=payload,
            )
            first = await repo.material_analysis_page(OWNER, material_id, limit=1, cursor=None)
            assert first["analysis_id"] == analysis_id
            assert first["analysis_provenance"] == payload.analysis_provenance
            assert first["source_sha256"] == payload.source_sha256
            assert first["file_size_bytes"] == payload.file_size_bytes
            assert first["has_more"] and first["next_cursor"]
            second = await repo.material_analysis_page(OWNER, material_id, limit=1, cursor=first["next_cursor"])
            assert second["analysis_provenance"] == first["analysis_provenance"]
            assert second["analysis_result_version"] == first["analysis_result_version"]
            assert not second["has_more"] and second["next_cursor"] is None
            assert first["chunks"] + second["chunks"] == [chunk.model_dump() for chunk in payload.chunks]

            # Repeated submit reuses one analysis and replaces two chunks/outbox rows.
            repeated_id = await repo.submit_client_analysis(
                user_id=OWNER, device_id="temporary_device_2", material_id=material_id, payload=payload,
            )
            assert repeated_id == analysis_id
            row = await (await connection.execute(
                "SELECT (SELECT count(*) FROM pg_temp.analysis WHERE analysis_id=%s) AS analyses, "
                "(SELECT count(*) FROM pg_temp.analysis_chunk WHERE analysis_id=%s) AS chunks, "
                "(SELECT count(*) FROM pg_temp.vector_outbox WHERE analysis_id=%s) AS outboxes",
                (analysis_id, analysis_id, analysis_id),
            )).fetchone()
            assert row == {"analyses": 1, "chunks": 2, "outboxes": 1}, row

            await expect_service_error(
                repo.material_analysis_page("other_owner", material_id, limit=1, cursor=None),
                code="material_not_found", status=404,
            )
            await expect_service_error(repo.submit_client_analysis(
                user_id="other_owner", device_id="temp", material_id=material_id, payload=payload,
            ), code="material_not_found", status=404)
            wrong_identity = payload.model_dump()
            wrong_identity["asset_id"] = "asset_other"
            await expect_service_error(repo.submit_client_analysis(
                user_id=OWNER, device_id="temp", material_id=material_id,
                payload=ClientAnalysisResultRequest.model_validate(wrong_identity),
            ), code="material_identity_conflict", status=409)

            # Same profile ID must never silently acquire different semantics.
            alterations = ["schema_version"] if legacy else ["schema_version", "analysis_profile", "normalization_profile", "remove_provenance"]
            for alteration in alterations:
                changed = copy.deepcopy(payload.model_dump())
                if alteration == "schema_version":
                    changed["result_schema_version"] = 2
                elif alteration == "analysis_profile":
                    changed["analysis_provenance"]["analysis_profile"]["chunk_duration"] = 15
                elif alteration == "normalization_profile":
                    changed["analysis_provenance"]["source_identity"]["normalization_profile"]["encoder"] = "nvidia"
                else:
                    changed["analysis_provenance"] = None
                await expect_service_error(repo.submit_client_analysis(
                    user_id=OWNER, device_id="temp", material_id=material_id,
                    payload=ClientAnalysisResultRequest.model_validate(changed),
                ), code="analysis_profile_conflict", status=409)
            final = await repo.material_analysis_page(OWNER, material_id, limit=10, cursor=None)
            assert final["analysis_provenance"] == payload.analysis_provenance
            assert final["chunks"] == [chunk.model_dump() for chunk in payload.chunks]

        result = {"ok": True, "postgres_repository_roundtrip": True,
            "migration_idempotent": True, "jsonb_provenance_preserved": True,
            "legacy_supported": True, "profile_conflicts_rejected": True,
            "identity_and_owner_conflicts_rejected": True, "pagination_verified": True,
            "production_rows_written": 0, "temporary_tables": len(TABLES)}
    finally:
        await connection.rollback()
        result["rolled_back"] = connection.info.transaction_status == TransactionStatus.IDLE
        await connection.close()
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, help="Read a local service env file without printing secrets")
    args = parser.parse_args()
    if args.env_file:
        load_dotenv(args.env_file)
    database_url = os.environ.get("MATERIAL_DATABASE_URL", "").strip()
    if not database_url:
        parser.error("MATERIAL_DATABASE_URL is required; no database connection attempted")
    try:
        result = asyncio.run(verify(database_url))
    except Exception as error:
        # Driver errors can contain connection details; print only their type.
        print(json.dumps({"ok": False, "error_type": type(error).__name__}, ensure_ascii=False))
        raise SystemExit(1) from None
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
