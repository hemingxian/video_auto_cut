"""A vector submitted before its file upload must not become a search candidate."""
import asyncio
from contextlib import asynccontextmanager

from app.repository import MaterialRepository


async def capture_queries():
    statements = []

    class Repository(MaterialRepository):
        def __init__(self):
            pass

        @asynccontextmanager
        async def connection(self, user_id):
            yield self

        async def execute(self, query, params):
            statements.append((query, params))
            return self

        async def fetchall(self):
            return []

    repository = Repository()
    await repository.allowed_asset_ids("owner_1")
    await repository.material_ids_for_assets("owner_1", ["uploaded", "uploading", "incomplete"])
    await repository.search_pgvector("owner_1", [1.0] * 768, 10)
    return statements


def test_local_and_external_search_guard_file_and_analysis_readiness():
    for query, params in asyncio.run(capture_queries()):
        assert "av.cloud_status='ready'" in query
        assert "an.analysis_status='completed'" in query
        assert "an.chunk_count > 0" in query
        assert "m.deleted_at IS NULL" in query
        assert query.count("%s") == len(params)


def regression_sql():
    statements = asyncio.run(capture_queries())
    allowed = statements[0][0].replace("%s", "NULL")
    hydrated = statements[1][0].replace("%s", "ARRAY['uploaded','uploading','incomplete']")
    return f"""
BEGIN;
CREATE TEMP TABLE material(material_id text, asset_id text, asset_version int,
 folder_id text, deleted_at timestamptz);
CREATE TEMP TABLE asset_version(asset_id text, asset_version int, cloud_status text);
CREATE TEMP TABLE analysis(analysis_id text, asset_id text, asset_version int,
 analysis_status text, chunk_count int);
CREATE TEMP TABLE analysis_chunk(analysis_id text, chunk_id text);
INSERT INTO material VALUES ('m1','uploaded',1,'f1',NULL),
 ('m2','uploading',1,'f1',NULL),('m3','incomplete',1,'f1',NULL);
INSERT INTO asset_version VALUES ('uploaded',1,'ready'),('uploading',1,'uploading'),
 ('incomplete',1,'ready');
INSERT INTO analysis VALUES ('a1','uploaded',1,'completed',1),
 ('a2','uploading',1,'completed',1),('a3','incomplete',1,'completed',2);
INSERT INTO analysis_chunk VALUES ('a1','c1'),('a2','c2'),('a3','c3');
CREATE TEMP TABLE allowed AS {allowed};
CREATE TEMP TABLE hydrated AS {hydrated};
DO $$ BEGIN
 IF (SELECT count(*) FROM allowed)<>1 OR (SELECT asset_id FROM allowed LIMIT 1)<>'uploaded'
 THEN RAISE EXCEPTION 'unavailable backup passed allowed asset filter'; END IF;
 IF (SELECT count(*) FROM hydrated)<>1 OR (SELECT material_id FROM hydrated LIMIT 1)<>'m1'
 THEN RAISE EXCEPTION 'external result recheck accepted unavailable backup'; END IF;
END $$;
ROLLBACK;
"""
