from __future__ import annotations

from contextlib import asynccontextmanager
import httpx
import pytest

from app.auth import Principal
from app.config import Settings
from app.container import Container
from app.errors import ServiceError
from app.main import create_app


def settings() -> Settings:
    return Settings(
        database_url="postgresql://unused",
        auth_me_url="https://auth.example/me",
        upload_service_url="http://upload.internal",
        upload_service_token="internal-only",
        host="127.0.0.1",
        port=8091,
        upload_max_bytes=5_000_000_000,
        multipart_threshold_bytes=67_108_864,
        part_size_bytes=16_777_216,
        max_parallel_parts=4,
        embedding_url="https://embedding.internal",
        embedding_token="embedding-secret",
        embedding_model="qwen3-vl-embedding",
        vector_dimension=768,
        cloud_vector_search_url="https://vector.internal/search",
        cloud_vector_token="vector-secret",
        consent_version="2026-08",
        platform_auto_sync_enabled=False,
        analysis_worker_token="analysis-worker-token-long-enough",
        cloud_vector_upsert_url="https://vector.internal/upsert",
    )


class FakeAuth:
    async def resolve(self, authorization, device_id):
        if authorization not in {"Bearer login-token", "Bearer moderator-token"}:
            raise ServiceError(401, "missing_authorization", "需要登录")
        if not device_id:
            raise ServiceError(400, "invalid_device_id", "设备标识无效")
        if authorization == "Bearer moderator-token":
            return Principal(user_id="moderator-1", device_id=device_id, role="moderator")
        return Principal(user_id="user-1", device_id=device_id, role="user")


class FakeRepository:
    def __init__(self):
        self.devices = []

    async def ping(self):
        return None

    async def register_device(self, user_id, device_id):
        self.devices.append((user_id, device_id))

    async def record_audit(self, *_args, **_kwargs):
        return None

    async def list_devices(self, user_id):
        assert user_id == "user-1"
        return [{"device_id": f"dev_{'a' * 32}", "revoked_at": None}]

    async def revoke_device(self, user_id, device_id):
        assert user_id == "user-1"
        assert device_id == f"dev_{'b' * 32}"

    async def list_folders(self, user_id):
        assert user_id == "user-1"
        return [{"folder_id": "fld_1", "parent_folder_id": None, "name": "产品", "revision": 1}]

    async def list_materials(self, user_id, **_kwargs):
        assert user_id == "user-1"
        return [], None

    async def list_public_materials(self, user_id, *, limit, cursor, keyword):
        assert user_id == "user-1"
        assert (limit, cursor, keyword) == (20, None, "机械臂")
        return [{
            "publication_id": "pub_12345",
            "display_name": "工业机械臂.mp4",
            "mime_type": "video/mp4",
            "file_size_bytes": 1024,
            "analysis_status": "ready",
            "published_at": "2026-08-24T10:00:00+08:00",
            "can_report": True,
            "report_status": None,
        }], None

    async def list_sync_changes(self, user_id, *, after_sequence, limit):
        assert (user_id, after_sequence, limit) == ("user-1", 41, 100)
        return [
            {
                "sequence_id": 42,
                "entity_type": "material",
                "entity_id": "mat_1",
                "operation": "upsert",
                "revision": 2,
            }
        ], None


class FakeMaterials:
    async def create_generation_run(
        self, *, user_id, device_id, idempotency_key, payload
    ):
        assert (user_id, device_id, idempotency_key) == (
            "user-1",
            f"dev_{'a' * 32}",
            "generation-create-001",
        )
        assert payload.task_id == "task_12345"
        assert payload.task_revision == 4
        return {
            "run_id": "run_12345",
            "task_id": payload.task_id,
            "task_revision": payload.task_revision,
            "status": "prepared",
            "stage": "material_manifest_ready",
            "progress": 0.0,
            "revision": 1,
            "manifest_checksum": "e" * 64,
            "error": None,
            "created": True,
        }

    async def get_generation_run(self, *, user_id, run_id):
        assert (user_id, run_id) == ("user-1", "run_12345")
        return {
            "run_id": run_id,
            "task_id": "task_12345",
            "task_revision": 4,
            "status": "prepared",
            "stage": "material_manifest_ready",
            "progress": 0.0,
            "revision": 1,
            "manifest_checksum": "e" * 64,
            "error": None,
        }

    async def update_generation_run(
        self, *, user_id, run_id, idempotency_key, payload
    ):
        assert (user_id, run_id, idempotency_key) == (
            "user-1",
            "run_12345",
            "generation-status-001",
        )
        assert payload.revision == 1
        return {
            "run_id": run_id,
            "task_id": "task_12345",
            "task_revision": 4,
            "status": payload.status,
            "stage": payload.stage,
            "progress": payload.progress,
            "revision": 2,
            "manifest_checksum": "e" * 64,
            "error": None,
        }

    async def resume_upload(self, *, user_id, device_id, session_id):
        assert (user_id, device_id, session_id) == (
            "user-1", f"dev_{'a' * 32}", "upl_12345"
        )
        return type("ResumeResult", (), {
            "uploaded_bytes": 16_777_216,
            "model_dump": lambda self, mode=None: {
                "upload_session_id": session_id,
                "status": "created",
                "upload_mode": "multipart",
                "part_size_bytes": 16_777_216,
                "uploaded_bytes": 16_777_216,
                "completed_parts": [1],
                "expires_at": "2026-08-25T10:00:00+08:00",
            },
        })()

    async def get_generation_manifest(self, *, user_id, run_id):
        assert (user_id, run_id) == ("user-1", "run_12345")
        return {
            "schema_version": 1,
            "run_id": run_id,
            "task_id": "task_12345",
            "task_revision": 4,
            "manifest_checksum": "e" * 64,
            "shots": [
                {
                    "shot_id": "shot_12345",
                    "download_material": False,
                    "checksum": "f" * 64,
                    "materials": [
                        {
                            "material_id": "mat_1",
                            "asset_id": "asset_1",
                            "asset_version": 1,
                            "source_sha256": "a" * 64,
                        }
                    ],
                }
            ],
        }

    async def validate_shot_materials(self, *, user_id, payload):
        assert user_id == "user-1"
        assert payload.shots[0].shot_id == "shot_12345"
        assert payload.shots[0].material_bindings[0].material_id == "mat_1"
        return {
            "valid": True,
            "summary": {
                "shot_count": 1,
                "valid_shot_count": 1,
                "blocker_count": 0,
                "warning_count": 0,
            },
            "shots": [
                {
                    "shot_id": "shot_12345",
                    "valid": True,
                    "download_material": False,
                    "binding_count": 1,
                    "resolved_material_count": 1,
                    "duplicate_asset_count": 0,
                    "materials": [
                        {
                            "material_id": "mat_1",
                            "asset_id": "asset_1",
                            "asset_version": 1,
                            "cloud_status": "ready",
                            "analysis_status": "ready",
                            "vector_sync_status": "ready",
                        }
                    ],
                    "issues": [],
                }
            ],
        }

    async def withdraw_publication(
        self, *, user_id, publication_id, idempotency_key, payload
    ):
        assert (user_id, publication_id, idempotency_key) == (
            "user-1", "pub_12345", "publish-withdraw-001"
        )
        assert payload.revision == 2
        return {
            "publication_id": publication_id,
            "material_id": "mat_1",
            "status": "withdrawn",
            "revision": 3,
            "material_revision": 8,
        }

    async def moderate_publication_status(
        self,
        *,
        actor_id,
        actor_role,
        publication_id,
        idempotency_key,
        payload,
    ):
        if actor_role not in {"admin", "moderator"}:
            raise ServiceError(403, "moderation_forbidden", "当前账号没有素材审核权限")
        assert (actor_id, publication_id, idempotency_key) == (
            "moderator-1", "pub_12345", "publish-remove-001"
        )
        assert payload.action == "remove"
        return {
            "publication_id": publication_id,
            "material_id": "mat_1",
            "status": "removed",
            "revision": 3,
            "material_revision": 8,
            "removed_imports": 2,
        }

    async def add_public_material(
        self, *, user_id, publication_id, idempotency_key, payload
    ):
        assert user_id == "user-1"
        assert publication_id == "pub_12345"
        assert idempotency_key == "public-add-001"
        assert payload.folder_id == "fld_12345"
        return {
            "publication_id": publication_id,
            "material_id": "mat_public_copy_1",
            "created": True,
            "cloud_status": "ready",
            "analysis_status": "ready",
            "revision": 1,
        }

    async def create_publication(
        self, *, user_id, material_id, idempotency_key, payload
    ):
        assert user_id == "user-1"
        assert material_id == "mat_1"
        assert idempotency_key == "publish-submit-001"
        assert payload.revision == 5
        assert payload.consent_version == "2026-08"
        assert payload.rights_confirmed is True
        return {
            "publication_id": "pub_12345",
            "material_id": material_id,
            "status": "pending_review",
            "revision": 1,
            "material_revision": 6,
            "consent_version": "2026-08",
            "rights_confirmed": True,
        }

    async def review_publication(
        self,
        *,
        actor_id,
        actor_role,
        publication_id,
        idempotency_key,
        payload,
    ):
        if actor_role not in {"admin", "moderator"}:
            raise ServiceError(403, "moderation_forbidden", "当前账号没有素材审核权限")
        assert actor_id == "moderator-1"
        assert publication_id == "pub_12345"
        assert idempotency_key == "publish-review-001"
        assert payload.decision == "approve"
        return {
            "publication_id": publication_id,
            "material_id": "mat_1",
            "status": "published",
            "revision": 2,
            "material_revision": 7,
            "review_reason": "",
        }

    async def create_publication_report(
        self, *, user_id, publication_id, idempotency_key, payload
    ):
        assert (user_id, publication_id, idempotency_key) == (
            "user-1", "pub_12345", "report-submit-001"
        )
        assert payload.category == "copyright"
        return {
            "report_id": "rpt_12345",
            "publication_id": publication_id,
            "category": payload.category,
            "status": "pending",
            "revision": 1,
            "created_at": "2026-08-24T10:00:00+08:00",
            "created": True,
        }

    async def list_publication_reports(
        self, *, actor_id, actor_role, status, limit
    ):
        if actor_role not in {"admin", "moderator"}:
            raise ServiceError(403, "moderation_forbidden", "当前账号没有举报审核权限")
        assert (actor_id, status, limit) == ("moderator-1", "pending", 20)
        return [{
            "report_id": "rpt_12345",
            "publication_id": "pub_12345",
            "category": "copyright",
            "description": "该素材未经授权使用了我的原创视频。",
            "status": "pending",
            "revision": 1,
            "display_name": "工业机械臂.mp4",
            "publication_status": "published",
            "publication_revision": 3,
        }]

    async def review_publication_report(
        self, *, actor_id, actor_role, report_id, idempotency_key, payload
    ):
        if actor_role not in {"admin", "moderator"}:
            raise ServiceError(403, "moderation_forbidden", "当前账号没有举报审核权限")
        assert (actor_id, report_id, idempotency_key) == (
            "moderator-1", "rpt_12345", "report-review-001"
        )
        assert payload.decision == "uphold"
        return {
            "report_id": report_id,
            "publication_id": "pub_12345",
            "status": "upheld",
            "revision": 2,
            "reviewed_at": "2026-08-24T11:00:00+08:00",
            "publication_status": "published",
            "publication_revision": 3,
            "next_actions": ["pause_publication", "remove_publication"],
        }

    async def delete_cloud_copy(
        self,
        *,
        user_id,
        device_id,
        material_id,
        expected_revision,
        idempotency_key,
    ):
        assert user_id == "user-1"
        assert device_id == f"dev_{'a' * 32}"
        assert material_id == "mat_1"
        assert expected_revision == 4
        assert idempotency_key == "delete-copy-001"
        return {
            "material_id": material_id,
            "cloud_status": "not_uploaded",
            "revision": 5,
        }

    async def resolve_selection(self, *, user_id, payload):
        assert user_id == "user-1"
        assert payload.material_ids == ["mat_1", "mat_missing"]
        return {
            "items": [{"material_id": "mat_1", "cloud_ready": True}],
            "unavailable": [
                {"material_id": "mat_missing", "reason": "not_found_or_forbidden"}
            ],
        }

    async def freeze_generation_snapshot(self, *, user_id, payload):
        assert user_id == "user-1"
        return {
            "run_id": payload.run_id,
            "shot_id": payload.shot_id,
            "checksum": "f" * 64,
            "created": True,
            "items": [["mat_1", "ast_1", 1, "a" * 64]],
        }


class FakeVectors:
    async def search(self, **kwargs):
        assert kwargs["user_id"] == "user-1"
        return [{"rank": 1, "material_id": "mat_1", "score": 0.9}], "cloud"


class FakeAnalysis:
    async def status_checks(self, user_id, payload):
        assert user_id == "user-1"
        return {"items": [{"material_id": payload.material_ids[0], "analysis_status": "pending"}]}

    async def claim(self, *, worker_id, limit):
        assert (worker_id, limit) == ("worker_01", 2)
        return {"jobs": []}

    async def submit_client_result(
        self, *, user_id, device_id, material_id, idempotency_key, payload
    ):
        assert user_id == "user-1"
        assert device_id == f"dev_{'a' * 32}"
        assert material_id == "mat_1"
        assert idempotency_key == "analysis-submit-001"
        assert payload.embedding_backend == "qwen-cloud"
        assert payload.model_name == "qwen3-vl-embedding"
        return {
            "material_id": material_id,
            "analysis_id": "ana_asset_1_1_profile_1",
            "analysis_result_version": "2026-08-24T10:00:00+08:00",
            "analysis_status": "completed",
            "chunk_count": len(payload.chunks),
            "pgvector_status": "completed",
            "cloud_vector_status": "pending",
        }

    async def result_page(self, *, user_id, material_id, limit, cursor):
        assert user_id == "user-1"
        assert material_id == "mat_1"
        assert limit == 100
        assert cursor is None
        return {
            "material_id": material_id,
            "asset_id": "asset_1",
            "asset_version": 1,
            "source_sha256": "a" * 64,
            "file_size_bytes": 1024,
            "analysis_id": "ana_asset_1_1_profile_1",
            "analysis_profile_id": "profile_1",
            "embedding_backend": "qwen-cloud",
            "model_name": "qwen3-vl-embedding",
            "model_version": "2026-08",
            "dimension": 768,
            "result_schema_version": 1,
            "chunks": [{
                "chunk_id": "chunk_1",
                "start_ms": 0,
                "end_ms": 1000,
                "caption": "工业机械臂",
                "embedding": [0.0] * 768,
            }],
            "next_cursor": None,
            "has_more": False,
        }


@asynccontextmanager
async def api_client():
    repository = FakeRepository()
    container = Container(
        settings=settings(),
        http=None,
        auth=FakeAuth(),
        repository=repository,
        materials=FakeMaterials(),
        vectors=FakeVectors(),
        upload_gateway=None,
        analysis=FakeAnalysis(),
    )
    app = create_app(settings(), injected=container)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            yield client, repository


def headers():
    return {
        "Authorization": "Bearer login-token",
        "X-Device-Id": f"dev_{'a' * 32}",
    }


@pytest.mark.asyncio
async def test_material_config_never_exposes_infrastructure_or_credentials():
    async with api_client() as (client, repository):
        response = await client.get("/v1/material-config", headers=headers())

    assert response.status_code == 200
    text = response.text.lower()
    assert "bucket" not in text
    assert "object_key" not in text
    assert "internal-only" not in text
    assert "analysis-worker-token-long-enough" not in text
    assert "vector.internal" not in text
    assert repository.devices == [("user-1", f"dev_{'a' * 32}")]


@pytest.mark.asyncio
async def test_semantic_search_returns_revalidated_business_ids_only():
    async with api_client() as (client, _repository):
        response = await client.post(
            "/v1/materials/search/semantic",
            headers=headers(),
            json={"query": "工业机械臂", "limit": 20},
        )

    assert response.status_code == 200
    assert response.json() == {
        "results": [{"rank": 1, "material_id": "mat_1", "score": 0.9}],
        "source": "cloud",
    }


@pytest.mark.asyncio
async def test_private_routes_require_login_and_device_identity():
    async with api_client() as (client, _repository):
        missing = await client.get("/v1/folders")

    assert missing.status_code == 401
    assert missing.json()["error"]["code"] == "missing_authorization"


@pytest.mark.asyncio
async def test_upload_resume_returns_server_authoritative_progress_without_storage_fields():
    async with api_client() as (client, _repository):
        response = await client.post(
            "/v1/upload-sessions/upl_12345/resume",
            headers=headers(),
        )

    assert response.status_code == 200
    assert response.json()["completed_parts"] == [1]
    assert response.json()["uploaded_bytes"] == 16_777_216
    assert response.headers["cache-control"] == "no-store"
    for field in ["bucket", "object_key", "url", "internal_upload_session_id"]:
        assert field not in response.text


@pytest.mark.asyncio
async def test_signed_in_device_can_delete_only_the_cloud_copy():
    async with api_client() as (client, _repository):
        response = await client.request(
            "DELETE",
            "/v1/materials/mat_1/cloud-copy",
            headers={**headers(), "Idempotency-Key": "delete-copy-001"},
            json={"revision": 4},
        )

    assert response.status_code == 200
    assert response.json() == {
        "material_id": "mat_1",
        "cloud_status": "not_uploaded",
        "revision": 5,
    }
    assert "storage_session_id" not in response.text


@pytest.mark.asyncio
async def test_cloud_copy_delete_requires_idempotency_key():
    async with api_client() as (client, _repository):
        response = await client.request(
            "DELETE",
            "/v1/materials/mat_1/cloud-copy",
            headers=headers(),
            json={"revision": 4},
        )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "missing_idempotency_key"


@pytest.mark.asyncio
async def test_owner_can_submit_rights_confirmed_material_for_review():
    async with api_client() as (client, _repository):
        response = await client.post(
            "/v1/materials/mat_1/publications",
            headers={**headers(), "Idempotency-Key": "publish-submit-001"},
            json={
                "revision": 5,
                "consent_version": "2026-08",
                "rights_confirmed": True,
            },
        )

    assert response.status_code == 201
    assert response.json()["status"] == "pending_review"
    assert response.json()["rights_confirmed"] is True


@pytest.mark.asyncio
async def test_only_moderation_role_can_approve_publication():
    async with api_client() as (client, _repository):
        forbidden = await client.post(
            "/v1/moderation/publications/pub_12345/review",
            headers={**headers(), "Idempotency-Key": "publish-review-001"},
            json={"revision": 1, "decision": "approve", "reason": ""},
        )
        approved = await client.post(
            "/v1/moderation/publications/pub_12345/review",
            headers={
                **headers(),
                "Authorization": "Bearer moderator-token",
                "Idempotency-Key": "publish-review-001",
            },
            json={"revision": 1, "decision": "approve", "reason": ""},
        )

    assert forbidden.status_code == 403
    assert forbidden.json()["error"]["code"] == "moderation_forbidden"
    assert approved.status_code == 200
    assert approved.json()["status"] == "published"


@pytest.mark.asyncio
async def test_public_catalog_search_never_exposes_owner_hash_or_storage_fields():
    async with api_client() as (client, _repository):
        response = await client.get(
            "/v1/public-materials?limit=20&keyword=%E6%9C%BA%E6%A2%B0%E8%87%82",
            headers=headers(),
        )

    assert response.status_code == 200
    assert response.json()["items"][0]["display_name"] == "工业机械臂.mp4"
    assert response.json()["items"][0]["can_report"] is True
    for field in ["owner_id", "source_sha256", "storage_session_id", "object_key", "url"]:
        assert field not in response.text


@pytest.mark.asyncio
async def test_user_can_report_public_material_without_exposing_report_description_in_audit():
    async with api_client() as (client, _repository):
        response = await client.post(
            "/v1/public-materials/pub_12345/reports",
            headers={**headers(), "Idempotency-Key": "report-submit-001"},
            json={
                "category": "copyright",
                "description": "该素材未经授权使用了我的原创视频。",
            },
        )

    assert response.status_code == 201
    assert response.json()["status"] == "pending"
    assert response.json()["report_id"] == "rpt_12345"


@pytest.mark.asyncio
async def test_only_moderator_can_read_and_review_publication_reports():
    async with api_client() as (client, _repository):
        forbidden = await client.get(
            "/v1/moderation/publication-reports?status=pending&limit=20",
            headers=headers(),
        )
        listed = await client.get(
            "/v1/moderation/publication-reports?status=pending&limit=20",
            headers={**headers(), "Authorization": "Bearer moderator-token"},
        )
        reviewed = await client.post(
            "/v1/moderation/publication-reports/rpt_12345/review",
            headers={
                **headers(),
                "Authorization": "Bearer moderator-token",
                "Idempotency-Key": "report-review-001",
            },
            json={"revision": 1, "decision": "uphold", "reason": "版权证明有效"},
        )

    assert forbidden.status_code == 403
    assert listed.status_code == 200
    assert listed.json()["items"][0]["category"] == "copyright"
    assert reviewed.status_code == 200
    assert reviewed.json()["next_actions"] == ["pause_publication", "remove_publication"]


@pytest.mark.asyncio
async def test_user_can_add_published_asset_to_private_material_folder():
    async with api_client() as (client, _repository):
        response = await client.post(
            "/v1/public-materials/pub_12345/add",
            headers={**headers(), "Idempotency-Key": "public-add-001"},
            json={"folder_id": "fld_12345"},
        )

    assert response.status_code == 200
    assert response.json()["created"] is True
    assert response.json()["cloud_status"] == "ready"
    assert "source_sha256" not in response.text


@pytest.mark.asyncio
async def test_owner_can_withdraw_publication_without_deleting_private_material():
    async with api_client() as (client, _repository):
        response = await client.request(
            "DELETE",
            "/v1/publications/pub_12345",
            headers={**headers(), "Idempotency-Key": "publish-withdraw-001"},
            json={"revision": 2, "reason": "暂不公开"},
        )

    assert response.status_code == 200
    assert response.json()["status"] == "withdrawn"
    assert response.json()["material_id"] == "mat_1"


@pytest.mark.asyncio
async def test_moderator_can_remove_publication_and_propagate_import_deletions():
    async with api_client() as (client, _repository):
        forbidden = await client.post(
            "/v1/moderation/publications/pub_12345/status",
            headers={**headers(), "Idempotency-Key": "publish-remove-001"},
            json={"revision": 2, "action": "remove", "reason": "版权投诉成立"},
        )
        removed = await client.post(
            "/v1/moderation/publications/pub_12345/status",
            headers={
                **headers(),
                "Authorization": "Bearer moderator-token",
                "Idempotency-Key": "publish-remove-001",
            },
            json={"revision": 2, "action": "remove", "reason": "版权投诉成立"},
        )

    assert forbidden.status_code == 403
    assert removed.status_code == 200
    assert removed.json()["status"] == "removed"
    assert removed.json()["removed_imports"] == 2


@pytest.mark.asyncio
async def test_picker_resolves_business_material_ids_without_leaking_storage_fields():
    async with api_client() as (client, _repository):
        response = await client.post(
            "/v1/selections/resolve",
            headers=headers(),
            json={"material_ids": ["mat_1", "mat_missing"]},
        )

    assert response.status_code == 200
    assert response.json()["items"] == [{"material_id": "mat_1", "cloud_ready": True}]
    assert response.json()["unavailable"][0]["reason"] == "not_found_or_forbidden"
    assert "object_key" not in response.text


@pytest.mark.asyncio
async def test_shot_material_validation_keeps_business_ids_and_returns_all_statuses():
    async with api_client() as (client, _repository):
        response = await client.post(
            "/v1/shot-material-validations",
            headers=headers(),
            json={
                "shots": [
                    {
                        "shot_id": "shot_12345",
                        "download_material": False,
                        "material_bindings": [
                            {"binding_type": "material", "material_id": "mat_1"}
                        ],
                    }
                ]
            },
        )

    assert response.status_code == 200
    assert response.json()["valid"] is True
    assert response.json()["shots"][0]["materials"][0]["material_id"] == "mat_1"
    assert "source_sha256" not in response.text
    assert "object_key" not in response.text


@pytest.mark.asyncio
async def test_generation_run_create_status_and_manifest_endpoints_are_owner_scoped():
    async with api_client() as (client, _repository):
        created = await client.post(
            "/v1/generation-runs",
            headers={**headers(), "Idempotency-Key": "generation-create-001"},
            json={
                "task_id": "task_12345",
                "task_revision": 4,
                "shots": [
                    {
                        "shot_id": "shot_12345",
                        "download_material": False,
                        "material_bindings": [
                            {"binding_type": "material", "material_id": "mat_1"}
                        ],
                    }
                ],
            },
        )
        status = await client.get("/v1/generation-runs/run_12345", headers=headers())
        updated = await client.patch(
            "/v1/generation-runs/run_12345",
            headers={**headers(), "Idempotency-Key": "generation-status-001"},
            json={
                "revision": 1,
                "status": "running",
                "stage": "compose",
                "progress": 72.5,
            },
        )
        manifest = await client.get(
            "/v1/generation-runs/run_12345/material-manifest", headers=headers()
        )

    assert created.status_code == 201
    assert created.json()["run_id"] == "run_12345"
    assert status.status_code == 200
    assert status.json()["stage"] == "material_manifest_ready"
    assert updated.status_code == 200
    assert updated.json()["revision"] == 2
    assert manifest.status_code == 200
    assert manifest.json()["shots"][0]["materials"][0]["source_sha256"] == "a" * 64
    assert "object_key" not in manifest.text


@pytest.mark.asyncio
async def test_generation_freezes_an_immutable_material_identity_list():
    async with api_client() as (client, _repository):
        response = await client.post(
            "/v1/generation/material-snapshots",
            headers=headers(),
            json={
                "run_id": "run_12345",
                "shot_id": "shot_12345",
                "material_ids": ["mat_1"],
                "download_material": False,
            },
        )

    assert response.status_code == 200
    assert response.json()["created"] is True
    assert response.json()["checksum"] == "f" * 64


@pytest.mark.asyncio
async def test_sync_changes_uses_monotonic_sequence_cursor():
    async with api_client() as (client, _repository):
        response = await client.get(
            "/v1/sync/changes?cursor=41&limit=100", headers=headers()
        )

    assert response.status_code == 200
    assert response.json()["changes"][0]["sequence_id"] == 42
    assert response.json()["next_cursor"] == 42
    assert response.json()["has_more"] is False


@pytest.mark.asyncio
async def test_user_can_list_and_revoke_only_devices_in_their_authenticated_scope():
    async with api_client() as (client, _repository):
        listed = await client.get("/v1/devices", headers=headers())
        revoked = await client.post(
            f"/v1/devices/dev_{'b' * 32}/revoke", headers=headers()
        )

    assert listed.status_code == 200
    assert listed.json()["items"][0]["device_id"] == f"dev_{'a' * 32}"
    assert revoked.status_code == 200
    assert revoked.json()["revoked"] is True


@pytest.mark.asyncio
async def test_analysis_worker_uses_separate_service_credential_and_user_trigger_stays_scoped():
    async with api_client() as (client, _repository):
        triggered = await client.post(
            "/v1/analyses/status-checks",
            headers=headers(),
            json={"material_ids": ["mat_1"], "trigger_missing": True},
        )
        unauthorized = await client.post(
            "/internal/v1/analyses/claim",
            headers={"X-Worker-Token": "wrong-token"},
            json={"worker_id": "worker_01", "limit": 2},
        )
        claimed = await client.post(
            "/internal/v1/analyses/claim",
            headers={"X-Worker-Token": "analysis-worker-token-long-enough"},
            json={"worker_id": "worker_01", "limit": 2},
        )

    assert triggered.status_code == 200
    assert triggered.json()["items"][0]["material_id"] == "mat_1"
    assert unauthorized.status_code == 401
    assert claimed.status_code == 200
    assert claimed.json() == {"jobs": []}


def client_analysis_payload():
    return {
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


@pytest.mark.asyncio
async def test_signed_in_device_can_submit_qwen_cloud_results_without_worker_credential():
    async with api_client() as (client, _repository):
        response = await client.post(
            "/v1/materials/mat_1/analysis-results",
            headers={**headers(), "Idempotency-Key": "analysis-submit-001"},
            json=client_analysis_payload(),
        )

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["analysis_status"] == "completed"
    assert response.json()["chunk_count"] == 1


@pytest.mark.asyncio
async def test_client_analysis_submission_requires_idempotency_key():
    async with api_client() as (client, _repository):
        response = await client.post(
            "/v1/materials/mat_1/analysis-results",
            headers=headers(),
            json=client_analysis_payload(),
        )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "missing_idempotency_key"


@pytest.mark.asyncio
async def test_signed_in_device_can_page_analysis_results_without_storage_fields():
    async with api_client() as (client, _repository):
        response = await client.get(
            "/v1/materials/mat_1/analysis-results",
            headers=headers(),
        )

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["chunks"][0]["caption"] == "工业机械臂"
    assert "object_key" not in response.text
    assert "url" not in response.json()
