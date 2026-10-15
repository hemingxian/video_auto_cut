from __future__ import annotations

import pytest

from app.errors import ServiceError
from app.models import (
    PublicMaterialAddRequest,
    PublicationCreateRequest,
    PublicationModerationRequest,
    PublicationReportCreateRequest,
    PublicationReportReviewRequest,
    PublicationReviewRequest,
    PublicationWithdrawRequest,
)
from app.service import MaterialService

from test_material_api import settings


class FakeRepository:
    def __init__(self) -> None:
        self.records = {}
        self.created = 0
        self.reviewed = 0
        self.created_reports = 0
        self.reviewed_reports = 0

    async def idempotency_get(self, user_id, operation, key, request_hash):
        stored = self.records.get((user_id, operation, key))
        if not stored:
            return None
        assert stored[0] == request_hash
        return stored[1], stored[2]

    async def idempotency_save(self, user_id, operation, key, request_hash, status, response):
        self.records[(user_id, operation, key)] = (request_hash, status, response)

    async def create_publication(self, user_id, material_id, **kwargs):
        self.created += 1
        assert (user_id, material_id) == ("user-1", "mat_1")
        assert kwargs["expected_revision"] == 5
        return {
            "publication_id": kwargs["publication_id"],
            "material_id": material_id,
            "status": "pending_review",
            "revision": 1,
            "material_revision": 6,
            "consent_version": kwargs["consent_version"],
            "rights_confirmed": True,
        }

    async def review_publication(self, actor_id, actor_role, publication_id, **kwargs):
        self.reviewed += 1
        assert (actor_id, actor_role, publication_id) == (
            "moderator-1", "moderator", "pub_12345"
        )
        assert kwargs["decision"] == "reject"
        assert kwargs["reason"] == "版权证明不足"
        return {
            "publication_id": publication_id,
            "material_id": "mat_1",
            "status": "rejected",
            "revision": 2,
            "material_revision": 7,
            "review_reason": kwargs["reason"],
        }

    async def add_public_material(self, user_id, publication_id, **kwargs):
        assert (user_id, publication_id, kwargs["folder_id"]) == (
            "user-1", "pub_12345", "fld_12345"
        )
        return {
            "publication_id": publication_id,
            "material_id": kwargs["material_id"],
            "created": True,
            "cloud_status": "ready",
            "analysis_status": "ready",
            "revision": 1,
        }

    async def withdraw_publication(self, user_id, publication_id, **kwargs):
        assert (user_id, publication_id, kwargs["expected_revision"]) == (
            "user-1", "pub_12345", 2
        )
        return {
            "publication_id": publication_id,
            "material_id": "mat_1",
            "status": "withdrawn",
            "revision": 3,
            "material_revision": 8,
        }

    async def moderate_publication_status(
        self, actor_id, actor_role, publication_id, **kwargs
    ):
        assert (actor_id, actor_role, publication_id) == (
            "moderator-1", "moderator", "pub_12345"
        )
        assert kwargs["action"] == "pause"
        return {
            "publication_id": publication_id,
            "material_id": "mat_1",
            "status": "paused",
            "revision": 3,
            "material_revision": 8,
            "removed_imports": 0,
        }

    async def create_publication_report(self, user_id, publication_id, **kwargs):
        self.created_reports += 1
        assert (user_id, publication_id) == ("user-1", "pub_12345")
        assert kwargs["category"] == "copyright"
        return {
            "report_id": kwargs["report_id"],
            "publication_id": publication_id,
            "category": kwargs["category"],
            "status": "pending",
            "revision": 1,
            "created_at": "2026-08-24T10:00:00+08:00",
            "created": True,
        }

    async def list_publication_reports(self, actor_id, actor_role, **kwargs):
        assert (actor_id, actor_role, kwargs["status"], kwargs["limit"]) == (
            "moderator-1", "moderator", "pending", 50
        )
        return [{"report_id": "rpt_12345", "status": "pending", "revision": 1}]

    async def review_publication_report(self, actor_id, actor_role, report_id, **kwargs):
        self.reviewed_reports += 1
        assert (actor_id, actor_role, report_id) == (
            "moderator-1", "moderator", "rpt_12345"
        )
        assert kwargs["decision"] == "uphold"
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


class UnusedGateway:
    pass


@pytest.mark.asyncio
async def test_publication_submission_and_review_are_idempotent():
    repository = FakeRepository()
    service = MaterialService(
        settings=settings(), repository=repository, upload_gateway=UnusedGateway()
    )
    create_payload = PublicationCreateRequest(
        revision=5, consent_version="2026-08", rights_confirmed=True
    )
    first = await service.create_publication(
        user_id="user-1",
        material_id="mat_1",
        idempotency_key="publish-submit-001",
        payload=create_payload,
    )
    replay = await service.create_publication(
        user_id="user-1",
        material_id="mat_1",
        idempotency_key="publish-submit-001",
        payload=create_payload,
    )
    review_payload = PublicationReviewRequest(
        revision=1, decision="reject", reason="版权证明不足"
    )
    reviewed = await service.review_publication(
        actor_id="moderator-1",
        actor_role="moderator",
        publication_id="pub_12345",
        idempotency_key="publish-review-001",
        payload=review_payload,
    )

    assert first == replay
    assert first["status"] == "pending_review"
    assert reviewed["status"] == "rejected"
    assert repository.created == 1
    assert repository.reviewed == 1


@pytest.mark.asyncio
async def test_publication_rejects_expired_consent_and_non_moderator_review():
    service = MaterialService(
        settings=settings(), repository=FakeRepository(), upload_gateway=UnusedGateway()
    )
    with pytest.raises(ServiceError) as expired:
        await service.create_publication(
            user_id="user-1",
            material_id="mat_1",
            idempotency_key="publish-submit-002",
            payload=PublicationCreateRequest(
                revision=5, consent_version="2026-07", rights_confirmed=True
            ),
        )
    with pytest.raises(ServiceError) as forbidden:
        await service.review_publication(
            actor_id="user-1",
            actor_role="user",
            publication_id="pub_12345",
            idempotency_key="publish-review-002",
            payload=PublicationReviewRequest(
                revision=1, decision="approve", reason=""
            ),
        )

    assert expired.value.code == "consent_version_expired"
    assert forbidden.value.code == "moderation_forbidden"


@pytest.mark.asyncio
async def test_adding_public_material_is_idempotent():
    repository = FakeRepository()
    service = MaterialService(
        settings=settings(), repository=repository, upload_gateway=UnusedGateway()
    )
    payload = PublicMaterialAddRequest(folder_id="fld_12345")
    first = await service.add_public_material(
        user_id="user-1",
        publication_id="pub_12345",
        idempotency_key="public-add-001",
        payload=payload,
    )
    replay = await service.add_public_material(
        user_id="user-1",
        publication_id="pub_12345",
        idempotency_key="public-add-001",
        payload=payload,
    )

    assert first == replay
    assert first["created"] is True


@pytest.mark.asyncio
async def test_publication_lifecycle_operations_are_idempotent_and_role_scoped():
    repository = FakeRepository()
    service = MaterialService(
        settings=settings(), repository=repository, upload_gateway=UnusedGateway()
    )
    withdrawn = await service.withdraw_publication(
        user_id="user-1",
        publication_id="pub_12345",
        idempotency_key="publish-withdraw-001",
        payload=PublicationWithdrawRequest(revision=2, reason="暂不公开"),
    )
    paused = await service.moderate_publication_status(
        actor_id="moderator-1",
        actor_role="moderator",
        publication_id="pub_12345",
        idempotency_key="publish-pause-001",
        payload=PublicationModerationRequest(
            revision=2, action="pause", reason="等待版权复核"
        ),
    )

    assert withdrawn["status"] == "withdrawn"
    assert paused["status"] == "paused"


@pytest.mark.asyncio
async def test_publication_report_submission_and_review_are_idempotent_and_role_scoped():
    repository = FakeRepository()
    service = MaterialService(
        settings=settings(), repository=repository, upload_gateway=UnusedGateway()
    )
    payload = PublicationReportCreateRequest(
        category="copyright", description="该素材未经授权使用了我的原创视频。"
    )
    first = await service.create_publication_report(
        user_id="user-1",
        publication_id="pub_12345",
        idempotency_key="report-submit-001",
        payload=payload,
    )
    replay = await service.create_publication_report(
        user_id="user-1",
        publication_id="pub_12345",
        idempotency_key="report-submit-001",
        payload=payload,
    )
    reports = await service.list_publication_reports(
        actor_id="moderator-1", actor_role="moderator", status="pending", limit=50
    )
    reviewed = await service.review_publication_report(
        actor_id="moderator-1",
        actor_role="moderator",
        report_id="rpt_12345",
        idempotency_key="report-review-001",
        payload=PublicationReportReviewRequest(
            revision=1, decision="uphold", reason="版权证明有效"
        ),
    )
    with pytest.raises(ServiceError) as forbidden:
        await service.list_publication_reports(
            actor_id="user-1", actor_role="user", status="pending", limit=50
        )

    assert first == replay
    assert reports[0]["status"] == "pending"
    assert reviewed["next_actions"] == ["pause_publication", "remove_publication"]
    assert forbidden.value.code == "moderation_forbidden"
    assert repository.created_reports == 1
    assert repository.reviewed_reports == 1
