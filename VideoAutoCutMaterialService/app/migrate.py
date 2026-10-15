from __future__ import annotations

import os
from pathlib import Path

import psycopg
from dotenv import load_dotenv


LOCK_ID = 8_117_202_608_010


def main() -> None:
    load_dotenv()
    database_url = (
        os.getenv("MATERIAL_MIGRATION_DATABASE_URL", "").strip()
        or os.getenv("MATERIAL_DATABASE_URL", "").strip()
    )
    if not database_url:
        raise RuntimeError("MATERIAL_MIGRATION_DATABASE_URL or MATERIAL_DATABASE_URL is required")
    migrations = sorted((Path(__file__).resolve().parent.parent / "migrations").glob("*.sql"))
    if not migrations:
        raise RuntimeError("No database migrations were found")
    with psycopg.connect(database_url, autocommit=True) as connection:
        connection.execute("SELECT pg_advisory_lock(%s)", (LOCK_ID,))
        try:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS schema_migration (
                    migration_name TEXT PRIMARY KEY,
                    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
                )
                """
            )
            applied = {
                str(row[0])
                for row in connection.execute(
                    "SELECT migration_name FROM schema_migration"
                ).fetchall()
            }
            for migration in migrations:
                if migration.name in applied:
                    continue
                connection.execute(migration.read_text(encoding="utf-8"))
                connection.execute(
                    "INSERT INTO schema_migration(migration_name) VALUES (%s)",
                    (migration.name,),
                )
        finally:
            connection.execute("SELECT pg_advisory_unlock(%s)", (LOCK_ID,))


if __name__ == "__main__":
    main()
