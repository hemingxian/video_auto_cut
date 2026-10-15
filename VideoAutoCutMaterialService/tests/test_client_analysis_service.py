from types import SimpleNamespace

import pytest

from app.analysis_service import AnalysisService
from app.errors import ServiceError
from app.models import ClientAnalysisResultRequest


def payload(**overrides) -> ClientAnalysisResultRequest:
    values = {
        "asset_id": "asset_1",
        "asset_version": 1,
        "source_sha256": "a" * 64,
        "file_size_bytes": 1024,
        "analysis_profile_id": "profile_1",
        "embedding_backend": "qwen-cloud",
        "model_name": "qwen3-vl-embedding",
        "model_version": "2026-08",
        "dimension": 768,
        "result_schema_version": 1,
        "chunks": [
            {
                "chunk_id": "chunk_1",
                "start_ms": 0,
                "end_ms": 1000,
                "caption": "工业机械臂",
                "embedding": [0.0] * 768,
            }
        ],
    }
    values.update(overrides)
    return ClientAnalysisResultRequest.model_validate(values)


class FakeRepository:
    def __init__(self):
        self.stored = None
        self.submissions = []
        self.saved = []
        self.indexed = []
        self.failures = []

    async def idempotency_get(self, user_id, operation, key, request_hash):
        assert user_id == "user-1"
        assert operation == "submit_client_analysis:mat_1"
        assert key == "analysis-submit-001"
        assert len(request_hash) == 64
        return self.stored

    async def submit_client_analysis(self, **kwargs):
        self.submissions.append(kwargs)
        return "ana_asset_1_1_profile_1"

    async def idempotency_save(self, *args):
        self.saved.append(args)

    async def mark_pgvector_index_ready(self, analysis_id):
        self.indexed.append(analysis_id)

    async def mark_vector_outbox(self, analysis_id, *, completed, error=""):
        self.failures.append((analysis_id, completed, error))


class FakeVectors:
    uses_pgvector_index = True


def service(repository: FakeRepository) -> AnalysisService:
    return AnalysisService(
        settings=SimpleNamespace(vector_dimension=768),
        repository=repository,
        upload_gateway=None,
        vectors=FakeVectors(),
    )


@pytest.mark.asyncio
async def test_client_result_is_persisted_and_indexed_without_downloading_cloud_file():
    repository = FakeRepository()
    result = await service(repository).submit_client_result(
        user_id="user-1",
        device_id="dev_12345",
        material_id="mat_1",
        idempotency_key="analysis-submit-001",
        payload=payload(),
    )

    assert result == {
        "material_id": "mat_1",
        "analysis_id": "ana_asset_1_1_profile_1",
        "analysis_status": "completed",
        "chunk_count": 1,
        "pgvector_status": "completed",
        "cloud_vector_status": "completed",
    }
    assert len(repository.submissions) == 1
    assert repository.submissions[0]["device_id"] == "dev_12345"
    assert repository.indexed == ["ana_asset_1_1_profile_1"]
    assert len(repository.saved) == 1


@pytest.mark.asyncio
async def test_client_result_replay_returns_saved_response_without_rewriting_vectors():
    repository = FakeRepository()
    repository.stored = (
        200,
        {
            "material_id": "mat_1",
            "analysis_id": "ana_existing",
            "analysis_status": "completed",
            "chunk_count": 1,
            "pgvector_status": "completed",
            "cloud_vector_status": "pending",
        },
    )

    result = await service(repository).submit_client_result(
        user_id="user-1",
        device_id="dev_12345",
        material_id="mat_1",
        idempotency_key="analysis-submit-001",
        payload=payload(),
    )

    assert result["analysis_id"] == "ana_existing"
    assert result["cloud_vector_status"] == "completed"
    assert repository.indexed == ["ana_existing"]
    assert repository.submissions == []
    assert repository.saved == []


@pytest.mark.asyncio
async def test_client_result_rejects_wrong_vector_dimension_before_persistence():
    repository = FakeRepository()
    wrong_dimension = payload(
        dimension=767,
        chunks=[
            {
                "chunk_id": "chunk_1",
                "start_ms": 0,
                "end_ms": 1000,
                "caption": "",
                "embedding": [0.0] * 768,
            }
        ],
    )

    with pytest.raises(ServiceError) as raised:
        await service(repository).submit_client_result(
            user_id="user-1",
            device_id="dev_12345",
            material_id="mat_1",
            idempotency_key="analysis-submit-001",
            payload=wrong_dimension,
        )

    assert raised.value.code == "vector_dimension_mismatch"
    assert repository.submissions == []
