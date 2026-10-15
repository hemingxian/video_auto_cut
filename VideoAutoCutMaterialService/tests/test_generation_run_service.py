from __future__ import annotations

import pytest

from app.errors import ServiceError
from app.models import GenerationRunCreateRequest
from app.models import GenerationRunStatusUpdateRequest
from app.service import MaterialService

from test_material_api import settings


class FakeRepository:
    def __init__(self, *, analysis_status: str = "completed") -> None:
        self.analysis_status = analysis_status
        self.idempotency = None
        self.created_runs = []
        self.resolve_calls = 0

    async def idempotency_get(self, user_id, operation, key, request_hash):
        assert (user_id, operation, key) == (
            "user-1",
            "create_generation_run",
            "generation-create-001",
        )
        if self.idempotency:
            assert self.idempotency[3] == request_hash
            return self.idempotency[4], self.idempotency[5]
        return None

    async def idempotency_save(
        self, user_id, operation, key, request_hash, status, response
    ):
        self.idempotency = (user_id, operation, key, request_hash, status, response)

    async def reuse_generation_run(self, *_args, **_kwargs):
        return None

    async def resolve_materials(self, user_id, material_ids):
        assert user_id == "user-1"
        self.resolve_calls += 1
        known = {
            "mat_12345": {
                "material_id": "mat_12345",
                "asset_id": "asset_12345",
                "asset_version": 2,
                "source_sha256": "a" * 64,
                "cloud_status": "ready",
                "analysis_status": self.analysis_status,
                "vector_sync_status": "completed",
            }
        }
        return [known[item_id] for item_id in material_ids if item_id in known]

    async def resolve_folder_materials(self, *_args, **_kwargs):
        raise AssertionError("folder resolution was not expected")

    async def create_generation_run(self, user_id, **kwargs):
        assert user_id == "user-1"
        self.created_runs.append(kwargs)
        return {
            "run_id": kwargs["run_id"],
            "task_id": kwargs["task_id"],
            "task_revision": kwargs["task_revision"],
            "status": "prepared",
            "stage": "material_manifest_ready",
            "progress": 0.0,
            "revision": 1,
            "manifest_checksum": kwargs["manifest_checksum"],
            "error": None,
            "created": True,
        }


class FakeStatusRepository:
    def __init__(self) -> None:
        self.idempotency = None
        self.updated = 0

    async def idempotency_get(self, user_id, operation, key, request_hash):
        assert (user_id, operation, key) == (
            "user-1",
            "update_generation_run",
            "generation-status-001",
        )
        if self.idempotency:
            assert self.idempotency[3] == request_hash
            return self.idempotency[4], self.idempotency[5]
        return None

    async def idempotency_save(
        self, user_id, operation, key, request_hash, status, response
    ):
        self.idempotency = (user_id, operation, key, request_hash, status, response)

    async def update_generation_run(self, user_id, run_id, **kwargs):
        assert (user_id, run_id, kwargs["expected_revision"]) == (
            "user-1",
            "run_12345",
            1,
        )
        self.updated += 1
        return {
            "run_id": run_id,
            "task_id": "task_12345",
            "task_revision": 7,
            "status": kwargs["status"],
            "stage": kwargs["stage"],
            "progress": kwargs["progress"],
            "revision": 2,
            "manifest_checksum": "b" * 64,
            "error": None,
        }


def request() -> GenerationRunCreateRequest:
    return GenerationRunCreateRequest.model_validate(
        {
            "task_id": "task_12345",
            "task_revision": 7,
            "shots": [
                {
                    "shot_id": "shot_auto",
                    "download_material": True,
                    "material_bindings": [],
                },
                {
                    "shot_id": "shot_manual",
                    "download_material": False,
                    "material_bindings": [
                        {"binding_type": "material", "material_id": "mat_12345"}
                    ],
                },
            ],
            "require_cloud_ready": False,
            "require_analysis_ready": True,
        }
    )


@pytest.mark.asyncio
async def test_generation_run_freezes_all_shots_and_replays_idempotently():
    repository = FakeRepository()
    service = MaterialService(
        settings=settings(), repository=repository, upload_gateway=object()
    )

    first = await service.create_generation_run(
        user_id="user-1",
        device_id="dev_12345",
        idempotency_key="generation-create-001",
        payload=request(),
    )
    replay = await service.create_generation_run(
        user_id="user-1",
        device_id="dev_12345",
        idempotency_key="generation-create-001",
        payload=request(),
    )

    assert first == replay
    assert len(repository.created_runs) == 1
    assert repository.resolve_calls == 2
    stored = repository.created_runs[0]
    assert len(stored["request_checksum"]) == 64
    assert len(stored["manifest_checksum"]) == 64
    assert stored["shots"][0]["materials"] == []
    assert stored["shots"][1]["materials"] == [
        {
            "material_id": "mat_12345",
            "asset_id": "asset_12345",
            "asset_version": 2,
            "source_sha256": "a" * 64,
        }
    ]


@pytest.mark.asyncio
async def test_generation_run_does_not_persist_when_validation_has_blockers():
    repository = FakeRepository(analysis_status="pending")
    service = MaterialService(
        settings=settings(), repository=repository, upload_gateway=object()
    )

    with pytest.raises(ServiceError) as captured:
        await service.create_generation_run(
            user_id="user-1",
            device_id="dev_12345",
            idempotency_key="generation-create-001",
            payload=request(),
        )

    assert captured.value.code == "generation_material_invalid"
    assert captured.value.details["summary"]["blocker_count"] == 1
    assert repository.created_runs == []
    assert repository.idempotency is None


@pytest.mark.asyncio
async def test_generation_status_update_is_revisioned_and_idempotent():
    repository = FakeStatusRepository()
    service = MaterialService(
        settings=settings(), repository=repository, upload_gateway=object()
    )
    payload = GenerationRunStatusUpdateRequest.model_validate(
        {
            "revision": 1,
            "status": "running",
            "stage": "compose",
            "progress": 72.5,
        }
    )

    first = await service.update_generation_run(
        user_id="user-1",
        run_id="run_12345",
        idempotency_key="generation-status-001",
        payload=payload,
    )
    replay = await service.update_generation_run(
        user_id="user-1",
        run_id="run_12345",
        idempotency_key="generation-status-001",
        payload=payload,
    )

    assert first == replay
    assert first["revision"] == 2
    assert repository.updated == 1


def test_failed_generation_status_requires_sanitized_error_details():
    with pytest.raises(ValueError):
        GenerationRunStatusUpdateRequest.model_validate(
            {
                "revision": 2,
                "status": "failed",
                "stage": "compose",
                "progress": 72.5,
            }
        )
