import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parents[1]))
from app.repository import MaterialRepository


async def capture_result(ready=True):
    statements = []

    class Repository(MaterialRepository):
        def __init__(self):
            pass

        async def get_upload_session(self, user_id, session_id):
            return {'asset_id': 'asset_test', 'asset_version': 1,
                    'internal_upload_session_id': 'storage_test'}

        @asynccontextmanager
        async def connection(self, user_id):
            yield self

        async def execute(self, query, params):
            statements.append((query, params))

    await Repository().mark_upload_result('owner_test', 'upload_test', ready=ready,
                                          error='' if ready else 'checksum mismatch')
    return statements


def test_upload_result_publishes_sync_changes_in_the_status_transaction():
    for ready in [True, False]:
        statements = asyncio.run(capture_result(ready))
        assert len(statements) == 2
        query, params = statements[1]
        assert 'INSERT INTO sync_change' in query
        assert params[-1] == 'owner_test'
        assert params[0] == ('ready' if ready else 'failed')
        assert params[6] == params[0]
        assert params[7] == params[1]
        assert params[8] == params[3]
        assert query.count('%s') == len(params)


def result_sql(ready):
    query, params = asyncio.run(capture_result(ready))[1]
    def literal(value):
        if value is None:
            return 'NULL'
        if isinstance(value, int):
            return str(value)
        return "'" + str(value).replace("'", "''") + "'"
    pieces = query.split('%s')
    return ''.join(piece + (literal(params[i]) if i < len(params) else '')
                   for i, piece in enumerate(pieces)) + ';'


def regression_sql():
    ready, failed = result_sql(True), result_sql(False)
    return f"""
BEGIN;
CREATE TEMP TABLE asset_version (asset_id text, asset_version int, cloud_status text,
 storage_session_id text, verified_at timestamptz, last_error text, updated_at timestamptz);
CREATE TEMP TABLE material (material_id text, asset_id text, asset_version int,
 owner_id text, revision int, updated_at timestamptz, deleted_at timestamptz);
CREATE TEMP TABLE sync_change (owner_id text, entity_type text, entity_id text, operation text, revision int);
INSERT INTO asset_version VALUES ('asset_test',1,'verifying',NULL,NULL,NULL,now());
INSERT INTO material VALUES
 ('m1','asset_test',1,'owner_test',1,now(),NULL),
 ('m2','asset_test',1,'owner_test',3,now(),NULL),
 ('deleted','asset_test',1,'owner_test',1,now(),now()),
 ('foreign','asset_test',1,'other_owner',1,now(),NULL),
 ('other','other_asset',1,'owner_test',1,now(),NULL);
{ready}
{ready}
DO $$ BEGIN
 IF (SELECT count(*) FROM sync_change) <> 2 THEN RAISE EXCEPTION 'missing aliases or repeated notification'; END IF;
 IF (SELECT revision FROM material WHERE material_id='m1') <> 2 THEN RAISE EXCEPTION 'bad material revision'; END IF;
 IF (SELECT revision FROM material WHERE material_id='m2') <> 4 THEN RAISE EXCEPTION 'alias revision lost'; END IF;
 IF EXISTS(SELECT 1 FROM sync_change WHERE entity_id NOT IN ('m1','m2')) THEN RAISE EXCEPTION 'scope leak'; END IF;
 IF (SELECT cloud_status FROM asset_version) <> 'ready' THEN RAISE EXCEPTION 'status not ready'; END IF;
END $$;
{failed}
{failed}
DO $$ BEGIN
 IF (SELECT count(*) FROM sync_change) <> 4 THEN RAISE EXCEPTION 'failure transition missing or duplicated'; END IF;
 IF (SELECT cloud_status FROM asset_version) <> 'failed' THEN RAISE EXCEPTION 'failure not applied'; END IF;
END $$;
ROLLBACK;
"""


if __name__ == '__main__':
    print(regression_sql())
