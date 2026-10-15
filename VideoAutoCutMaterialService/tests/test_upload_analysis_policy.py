from types import SimpleNamespace

import pytest

from app.analysis_service import AnalysisService
from app.errors import ServiceError
from app.models import AnalysisStatusCheckRequest
from app.service import MaterialService


class Repository:
    def __init__(self):
        self.results = []
        self.seeds = []

    async def get_upload_session(self, user_id, session_id):
        return {
            "internal_upload_session_id": "storage_1",
            "source_sha256": "a" * 64,
            "expected_size": 1024,
            "material_id": "mat_1",
        }

    async def mark_upload_result(self, user_id, session_id, **result):
        self.results.append((user_id, session_id, result))

    async def ensure_analysis(self, user_id, material_id, **config):
        self.seeds.append((user_id, material_id, config))
        return {"material_id": material_id, "analysis_status": "pending"}


class Gateway:
    def __init__(self, failure=None):
        self.failure = failure

    async def verify_sha256(self, user_id, internal_id, sha256, size):
        assert (user_id, internal_id, sha256, size) == (
            "owner_1", "storage_1", "a" * 64, 1024
        )
        if self.failure:
            raise self.failure


@pytest.mark.asyncio
async def test_verified_video_does_not_create_an_unrelated_pending_analysis():
    repository = Repository()
    service = MaterialService(
        settings=SimpleNamespace(), repository=repository, upload_gateway=Gateway()
    )
    await service.verify_upload(user_id="owner_1", session_id="session_1")
    assert repository.results == [("owner_1", "session_1", {"ready": True})]
    assert repository.seeds == []


@pytest.mark.asyncio
async def test_failed_video_verification_does_not_report_file_ready_or_seed_analysis():
    repository = Repository()
    service = MaterialService(
        settings=SimpleNamespace(), repository=repository,
        upload_gateway=Gateway(ServiceError(409, "hash_mismatch", "hash mismatch")),
    )
    await service.verify_upload(user_id="owner_1", session_id="session_1")
    assert repository.results == [
        ("owner_1", "session_1", {"ready": False, "error": "hash mismatch"})
    ]
    assert repository.seeds == []


@pytest.mark.asyncio
async def test_explicit_analysis_request_remains_available():
    repository = Repository()
    service = AnalysisService(
        settings=SimpleNamespace(analysis_profile_id="profile_1", analysis_model="qwen",
                                 vector_dimension=768),
        repository=repository, upload_gateway=None, vectors=None,
    )
    response = await service.status_checks(
        "owner_1", AnalysisStatusCheckRequest(material_ids=["mat_1"], trigger_missing=True)
    )
    assert response["items"] == [{"material_id": "mat_1", "analysis_status": "pending"}]
    assert len(repository.seeds) == 1
