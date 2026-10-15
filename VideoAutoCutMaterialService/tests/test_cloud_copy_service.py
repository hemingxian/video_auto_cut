from __future__ import annotations

import httpx
import pytest

from app.service import MaterialService
from app.upload_gateway import UploadGateway

from test_material_api import settings


class FakeRepository:
    def __init__(self) -> None:
        self.saved = None
        self.finished = 0

    async def idempotency_get(self, user_id, operation, key, request_hash):
        assert (user_id, operation, key) == ("user-1", "delete_cloud_copy", "delete-copy-001")
        if self.saved:
            assert self.saved[3] == request_hash
            return self.saved[4], self.saved[5]
        return None

    async def idempotency_save(self, user_id, operation, key, request_hash, status, response):
        self.saved = (user_id, operation, key, request_hash, status, response)

    async def begin_cloud_copy_delete(
        self, user_id, material_id, *, expected_revision, operation_id
    ):
        assert (user_id, material_id, expected_revision, operation_id) == (
            "user-1", "mat_1", 4, "delete-copy-001"
        )
        return {"storage_session_id": "upload-internal-1", "revision": 4}

    async def finish_cloud_copy_delete(
        self, user_id, material_id, *, storage_session_id, operation_id
    ):
        assert (user_id, material_id, storage_session_id, operation_id) == (
            "user-1", "mat_1", "upload-internal-1", "delete-copy-001"
        )
        self.finished += 1
        return 5


class FakeUploadGateway:
    def __init__(self) -> None:
        self.deleted = []

    async def delete_cloud_copy(self, user_id, session_id, idempotency_key):
        self.deleted.append((user_id, session_id, idempotency_key))
        return {"status": "deleted"}


@pytest.mark.asyncio
async def test_cloud_copy_delete_is_idempotent_and_keeps_storage_details_private():
    repository = FakeRepository()
    gateway = FakeUploadGateway()
    service = MaterialService(
        settings=settings(),
        repository=repository,
        upload_gateway=gateway,
    )

    first = await service.delete_cloud_copy(
        user_id="user-1",
        device_id="dev_1",
        material_id="mat_1",
        expected_revision=4,
        idempotency_key="delete-copy-001",
    )
    replay = await service.delete_cloud_copy(
        user_id="user-1",
        device_id="dev_1",
        material_id="mat_1",
        expected_revision=4,
        idempotency_key="delete-copy-001",
    )

    assert first == replay == {
        "material_id": "mat_1",
        "cloud_status": "not_uploaded",
        "revision": 5,
    }
    assert gateway.deleted == [("user-1", "upload-internal-1", "delete-copy-001")]
    assert repository.finished == 1


@pytest.mark.asyncio
async def test_upload_gateway_uses_owner_scoped_delete_route():
    captured = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        captured["request"] = request
        return httpx.Response(200, json={"id": "upload-internal-1", "status": "deleted"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        gateway = UploadGateway("http://upload.internal", "service-token", client)
        result = await gateway.delete_cloud_copy(
            "user-1", "upload-internal-1", "delete-copy-001"
        )

    request = captured["request"]
    assert request.method == "DELETE"
    assert request.url.path == "/v1/upload-sessions/upload-internal-1"
    assert request.headers["X-Actor-Id"] == "user-1"
    assert request.headers["Idempotency-Key"] == "delete-copy-001"
    assert result["status"] == "deleted"
