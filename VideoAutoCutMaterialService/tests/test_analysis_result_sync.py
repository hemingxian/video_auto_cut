"""Analysis/index transitions must reach account-scoped incremental sync."""
import asyncio
from contextlib import asynccontextmanager

import pytest

from app.errors import ServiceError
from app.repository import MaterialRepository
from test_client_analysis_service import payload


class Cursor:
    def __init__(self, value):
        self.value = value

    async def fetchone(self):
        return self.value


class Repository(MaterialRepository):
    def __init__(self, *, indexed=False, actual_chunks=1):
        self.indexed = indexed
        self.actual_chunks = actual_chunks
        self.statements = []

    @asynccontextmanager
    async def maintenance_connection(self):
        yield self

    async def execute(self, query, params):
        self.statements.append((query, params))
        if "SELECT analysis_status, chunk_count" in query:
            return Cursor({"analysis_status": "completed", "chunk_count": 1,
                           "vector_sync_status": "completed" if self.indexed else "pending",
                           "requested_by_owner_id": "owner_1"})
        if "SELECT count(*) AS value" in query:
            return Cursor({"value": self.actual_chunks})
        if "RETURNING requested_by_owner_id" in query:
            return Cursor(None if self.indexed else {"requested_by_owner_id": "owner_1"})
        return Cursor(None)


@pytest.mark.asyncio
@pytest.mark.parametrize("indexed", [False, True])
async def test_pgvector_ready_notifies_once_under_recorded_owner(indexed):
    repository = Repository(indexed=indexed)
    await repository.mark_pgvector_index_ready("ana_1")
    notifications = [(query, params) for query, params in repository.statements
                     if "INSERT INTO sync_change" in query]
    assert len(notifications) == (0 if indexed else 1)
    if not indexed:
        query, params = notifications[0]
        assert params == ("ana_1", "owner_1")
        assert "m.deleted_at IS NULL" in query
        assert "m.asset_version=an.asset_version" in query
        scope = [(query, params) for query, params in repository.statements if "set_config" in query]
        assert scope[0][1] == ("owner_1",)


@pytest.mark.asyncio
async def test_incomplete_index_never_publishes_ready_or_sync_event():
    repository = Repository(actual_chunks=0)
    with pytest.raises(ServiceError) as caught:
        await repository.mark_pgvector_index_ready("ana_1")
    assert caught.value.code == "vector_index_incomplete"
    assert not any("UPDATE " in query or "INSERT " in query for query, _ in repository.statements)


@pytest.mark.asyncio
@pytest.mark.parametrize("indexed", [False, True])
async def test_external_vector_confirmation_notifies_only_on_transition(indexed):
    repository = Repository(indexed=indexed)
    await repository.mark_vector_outbox("ana_1", completed=True)
    assert sum("INSERT INTO sync_change" in query for query, _ in repository.statements) == (
        0 if indexed else 1
    )


@pytest.mark.asyncio
async def test_client_analysis_submission_publishes_material_aliases_before_commit():
    class SubmissionRepository(Repository):
        active_transaction = False

        @asynccontextmanager
        async def connection(self, user_id):
            assert user_id == "owner_1"
            self.active_transaction = True
            try:
                yield self
            finally:
                self.active_transaction = False

        async def execute(self, query, params):
            assert self.active_transaction
            if "SELECT m.asset_id, m.asset_version" in query:
                self.statements.append((query, params))
                return Cursor({"asset_id": "asset_1", "asset_version": 1,
                               "source_sha256": "a" * 64, "source_size": 1024})
            return await super().execute(query, params)

    repository = SubmissionRepository()
    analysis_id = await repository.submit_client_analysis(
        user_id="owner_1", device_id="device_1", material_id="mat_1", payload=payload()
    )
    notifications = [(query, params) for query, params in repository.statements
                     if "INSERT INTO sync_change" in query]
    assert len(notifications) == 1
    assert notifications[0][1] == (analysis_id, "owner_1")
    assert not repository.active_transaction


def regression_sql():
    repository = Repository()
    asyncio.run(repository._notify_analysis_materials(repository, "ana_1", "owner_1"))
    query, _ = repository.statements[-1]
    notification = query.replace("%s", "'ana_1'", 1).replace("%s", "'owner_1'", 1) + ";"
    return f"""
BEGIN;
CREATE ROLE analysis_sync_test_role;
CREATE TEMP TABLE material(material_id text, asset_id text, asset_version int,
 owner_id text, revision int, updated_at timestamptz, deleted_at timestamptz);
CREATE TEMP TABLE analysis(analysis_id text, asset_id text, asset_version int);
CREATE TEMP TABLE sync_change(owner_id text, entity_type text, entity_id text,
 operation text, revision int);
INSERT INTO analysis VALUES ('ana_1','asset_1',1);
INSERT INTO material VALUES
 ('m1','asset_1',1,'owner_1',1,now(),NULL),
 ('alias','asset_1',1,'owner_1',3,now(),NULL),
 ('foreign','asset_1',1,'owner_2',1,now(),NULL),
 ('deleted','asset_1',1,'owner_1',1,now(),now()),
 ('version2','asset_1',2,'owner_1',1,now(),NULL),
 ('other','asset_2',1,'owner_1',1,now(),NULL);
ALTER TABLE material ENABLE ROW LEVEL SECURITY;
ALTER TABLE material FORCE ROW LEVEL SECURITY;
ALTER TABLE sync_change ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_change FORCE ROW LEVEL SECURITY;
CREATE POLICY owned_material ON material
 USING (owner_id=current_setting('app.user_id',true))
 WITH CHECK (owner_id=current_setting('app.user_id',true));
CREATE POLICY owned_changes ON sync_change
 USING (owner_id=current_setting('app.user_id',true))
 WITH CHECK (owner_id=current_setting('app.user_id',true));
GRANT SELECT,UPDATE ON material TO analysis_sync_test_role;
GRANT SELECT ON analysis TO analysis_sync_test_role;
GRANT SELECT,INSERT ON sync_change TO analysis_sync_test_role;
SET LOCAL ROLE analysis_sync_test_role;
SELECT set_config('app.user_id','owner_1',true);
{notification}
RESET ROLE;
DO $$ BEGIN
 IF (SELECT count(*) FROM sync_change)<>2 THEN RAISE EXCEPTION 'missing material aliases'; END IF;
 IF (SELECT revision FROM material WHERE material_id='m1')<>2 THEN RAISE EXCEPTION 'revision not advanced'; END IF;
 IF (SELECT revision FROM material WHERE material_id='alias')<>4 THEN RAISE EXCEPTION 'alias revision lost'; END IF;
 IF EXISTS (SELECT 1 FROM sync_change WHERE owner_id<>'owner_1') THEN RAISE EXCEPTION 'foreign sync leaked'; END IF;
 IF EXISTS (SELECT 1 FROM material WHERE material_id NOT IN ('m1','alias') AND revision<>1) THEN RAISE EXCEPTION 'unrelated material changed'; END IF;
END $$;
SAVEPOINT atomic_event;
SET LOCAL ROLE analysis_sync_test_role;
{notification}
ROLLBACK TO SAVEPOINT atomic_event;
RESET ROLE;
DO $$ BEGIN
 IF (SELECT count(*) FROM sync_change)<>2 THEN RAISE EXCEPTION 'sync rollback failed'; END IF;
 IF (SELECT revision FROM material WHERE material_id='m1')<>2 THEN RAISE EXCEPTION 'material rollback failed'; END IF;
END $$;
ROLLBACK;
"""
