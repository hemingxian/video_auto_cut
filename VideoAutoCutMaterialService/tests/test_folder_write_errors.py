from contextlib import asynccontextmanager

import pytest
from psycopg import OperationalError
from psycopg.errors import ForeignKeyViolation, InsufficientPrivilege, UniqueViolation
from psycopg.pq import DiagnosticField

from app.errors import ServiceError
from app.models import FolderSyncItem, SyncBatchRequest
from app.repository import MaterialRepository
from app.service import MaterialService


NAME_CONSTRAINT = "material_folder_owner_id_parent_folder_id_name_key_key"


def unique_violation(constraint):
    info = {DiagnosticField.CONSTRAINT_NAME: constraint.encode()} if constraint else None
    return UniqueViolation("internal database detail", info=info)


class WriteFailureRepository(MaterialRepository):
    """Exercise repository control flow using actual psycopg error classes."""

    def __init__(self, error):
        self.error = error
        self.statements = []
        self.row = None

    @asynccontextmanager
    async def connection(self, user_id):
        assert user_id == "owner_current"
        yield self

    async def execute(self, query, parameters):
        query = " ".join(query.split())
        self.statements.append(query)
        if query.startswith(("INSERT INTO material_folder(", "UPDATE material_folder SET")):
            raise self.error
        if query.startswith("SELECT folder_id, parent_folder_id, name, revision"):
            self.row = {"folder_id": "folder_test", "parent_folder_id": None,
                        "name": "原文件夹", "revision": 1}
        else:
            self.row = None
        return self

    async def fetchone(self):
        return self.row


async def write_folder(repository, operation):
    if operation == "sync":
        return await repository.sync_folder("owner_current", FolderSyncItem(
            folder_id="folder_test", name="新文件夹", revision=1,
        ))
    return await repository.update_folder(
        "owner_current", "folder_test", expected_revision=1,
        name="新文件夹", parent_folder_id=None, update_parent=False,
    )


@pytest.mark.parametrize("operation", ["sync", "update"])
async def test_sibling_name_unique_violation_keeps_conflict_message(operation):
    original = unique_violation(NAME_CONSTRAINT)
    repository = WriteFailureRepository(original)

    with pytest.raises(ServiceError) as raised:
        await write_folder(repository, operation)

    error = raised.value
    assert (error.status_code, error.code, error.message) == (
        409, "folder_name_conflict", "同级文件夹名称已存在",
    )
    assert error.__cause__ is original
    assert not any("INSERT INTO sync_change" in query for query in repository.statements)


@pytest.mark.parametrize("operation", ["sync", "update"])
@pytest.mark.parametrize("detail", [
    'new row violates row-level security policy (USING expression) for table "material_folder"',
    'permission denied for table material_folder; private-owner-and-folder-details',
])
async def test_rls_and_permission_failures_are_not_name_conflicts(operation, detail):
    original = InsufficientPrivilege(detail)

    with pytest.raises(ServiceError) as raised:
        await write_folder(WriteFailureRepository(original), operation)

    error = raised.value
    assert (error.status_code, error.code, error.action) == (403, "folder_access_denied", "refresh")
    assert "当前账号" in error.message
    assert "同级文件夹名称已存在" not in error.message
    assert detail not in error.message
    assert error.details == {}
    assert error.__cause__ is original


@pytest.mark.parametrize("operation", ["sync", "update"])
@pytest.mark.parametrize("original", [
    unique_violation("material_folder_pkey"),
    unique_violation("some_other_unique_constraint"),
    unique_violation(None),
    ForeignKeyViolation("missing reference"),
    OperationalError("connection lost"),
    RuntimeError("unexpected repository failure"),
])
async def test_other_database_and_programming_errors_remain_original(operation, original):
    with pytest.raises(type(original)) as raised:
        await write_folder(WriteFailureRepository(original), operation)
    assert raised.value is original


async def test_batch_sync_reports_access_denied_without_database_details():
    detail = 'new row violates row-level security policy; private-folder-and-owner'
    service = MaterialService(
        settings=None, repository=WriteFailureRepository(InsufficientPrivilege(detail)),
        upload_gateway=None,
    )

    response = await service.sync_batch("owner_current", SyncBatchRequest(folders=[
        FolderSyncItem(folder_id="folder_test", name="新文件夹", revision=1),
    ]))

    result = response.results[0]
    assert result.ok is False
    assert result.error["code"] == "folder_access_denied"
    assert "当前账号" in result.error["message"]
    assert detail not in response.model_dump_json()


async def test_batch_sync_does_not_turn_connection_failure_into_folder_conflict():
    original = OperationalError("connection lost")
    service = MaterialService(
        settings=None, repository=WriteFailureRepository(original), upload_gateway=None,
    )

    with pytest.raises(OperationalError) as raised:
        await service.sync_batch("owner_current", SyncBatchRequest(folders=[
            FolderSyncItem(folder_id="folder_test", name="新文件夹", revision=1),
        ]))
    assert raised.value is original
