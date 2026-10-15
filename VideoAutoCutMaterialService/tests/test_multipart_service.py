from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from app.errors import ServiceError
from app.models import CompletePartRequest, CreateUploadSessionRequest
from app.service import MaterialService

from test_material_api import settings


class FakeRepository:
    def __init__(self, file_size: int = 80_000_000) -> None:
        self.session: dict | None = None
        self.parts: list[dict] = []
        self.file_size = file_size

    async def idempotency_get(self, *_args):
        return None

    async def idempotency_save(self, *_args):
        return None

    async def get_material(self, _user_id, _material_id):
        return {
            "material_id": "mat_large",
            "asset_id": "asset_large",
            "asset_version": 1,
            "display_name": "large.mp4",
            "mime_type": "video/mp4",
            "file_size_bytes": self.file_size,
            "source_sha256": "a" * 64,
            "origin": "user_upload",
            "cloud_status": "not_uploaded",
        }

    async def create_upload_session(
        self, user_id, device_id, session_id, material_id, upload_mode, part_size, expires_at
    ):
        self.session = {
            "upload_session_id": session_id,
            "owner_id": user_id,
            "device_id": device_id,
            "material_id": material_id,
            "asset_id": "asset_large",
            "asset_version": 1,
            "upload_mode": upload_mode,
            "part_size_bytes": part_size,
            "expected_size": self.file_size,
            "source_sha256": "a" * 64,
            "status": "created",
            "expires_at": expires_at,
            "internal_upload_session_id": None,
        }
        return {"reuse": False}

    async def attach_internal_upload(
        self, _user_id, _session_id, internal_id, expires_at, part_size=None
    ):
        self.session["internal_upload_session_id"] = internal_id
        self.session["expires_at"] = expires_at
        if part_size:
            self.session["part_size_bytes"] = part_size

    async def get_upload_session(self, _user_id, _session_id):
        return dict(self.session)

    async def complete_part(
        self, _user_id, _session_id, part_number, size_bytes, checksum, etag
    ):
        self.parts.append(
            {
                "part_number": part_number,
                "size_bytes": size_bytes,
                "checksum_sha256": checksum,
                "etag": etag,
            }
        )

    async def upload_session_progress(self, _user_id, _session_id):
        return {
            **self.session,
            "completed_parts": sorted(self.parts, key=lambda item: item["part_number"]),
            "uploaded_bytes": sum(item["size_bytes"] for item in self.parts),
        }

    async def resume_upload_session(
        self, _user_id, _session_id, *, expires_at, internal_parts
    ):
        self.session["status"] = "created"
        self.session["expires_at"] = expires_at
        existing = {item["part_number"] for item in self.parts}
        for item in internal_parts:
            if item["part_number"] not in existing:
                self.parts.append({**item, "checksum_sha256": None})
        return await self.upload_session_progress(_user_id, _session_id)

    async def mark_upload_verifying(self, _user_id, _session_id):
        self.session["status"] = "verifying"

    async def mark_upload_result(self, *_args, **_kwargs):
        return None


class FakeGateway:
    def __init__(self) -> None:
        self.completed = False
        self.completed_parts: list[int] = []
        self.resumed_parts: list[dict] = []

    async def create_multipart(self, **_kwargs):
        return {
            "id": "internal-multipart-1",
            "part_size_bytes": 16_777_216,
            "expires_at": (datetime.now(UTC) + timedelta(hours=24)).isoformat(),
        }

    async def multipart_part_authorization(
        self, _user_id, _internal_id, part_number, size_bytes
    ):
        return {
            "part_number": part_number,
            "url": f"https://cos.example/part/{part_number}",
            "required_headers": {"Content-Length": str(size_bytes)},
            "expires_at": (datetime.now(UTC) + timedelta(minutes=15)).isoformat(),
        }

    @staticmethod
    def public_part_authorization(value):
        return {
            "part_number": value["part_number"],
            "url": value["url"],
            "headers": value["required_headers"],
            "expires_at": datetime.fromisoformat(value["expires_at"]),
        }

    async def complete_multipart_part(
        self, _user_id, _internal_id, part_number, _size_bytes, _etag
    ):
        self.completed_parts.append(part_number)

    async def complete_multipart(self, _user_id, _internal_id):
        self.completed = True

    async def resume_multipart(self, _user_id, internal_id):
        return {
            "id": internal_id,
            "status": "initiated",
            "part_size_bytes": 16_777_216,
            "completed_parts": self.resumed_parts,
            "expires_at": (datetime.now(UTC) + timedelta(hours=24)).isoformat(),
        }


@pytest.mark.asyncio
async def test_large_material_uses_resumable_multipart_gateway() -> None:
    repository = FakeRepository()
    gateway = FakeGateway()
    service = MaterialService(
        settings=settings(), repository=repository, upload_gateway=gateway
    )
    created = await service.create_upload_session(
        user_id="user-1",
        device_id=f"dev_{'a' * 32}",
        idempotency_key="large-material-001",
        payload=CreateUploadSessionRequest(
            material_id="mat_large",
            filename="large.mp4",
            mime_type="video/mp4",
            file_size_bytes=80_000_000,
            source_sha256="a" * 64,
            origin="user_upload",
        ),
    )
    assert created.upload_mode == "multipart"
    assert created.part_size_bytes == 16_777_216
    total_parts = 5
    for part_number in range(1, total_parts + 1):
        authorization = await service.part_authorizations(
            user_id="user-1",
            device_id=f"dev_{'a' * 32}",
            session_id=created.upload_session_id,
            part_numbers=[part_number],
        )
        size = int(authorization.authorizations[0].headers["Content-Length"])
        await service.complete_part(
            user_id="user-1",
            device_id=f"dev_{'a' * 32}",
            session_id=created.upload_session_id,
            payload=CompletePartRequest(
                part_number=part_number,
                size_bytes=size,
                etag=f"etag-{part_number}",
                checksum=f"{part_number:064x}",
            ),
        )
    completed = await service.complete_upload(
        user_id="user-1",
        device_id=f"dev_{'a' * 32}",
        session_id=created.upload_session_id,
    )
    assert completed.status == "verifying"
    assert gateway.completed_parts == [1, 2, 3, 4, 5]
    assert gateway.completed is True


@pytest.mark.asyncio
async def test_resume_reconciles_internal_parts_and_rejects_another_device() -> None:
    repository = FakeRepository()
    gateway = FakeGateway()
    service = MaterialService(
        settings=settings(), repository=repository, upload_gateway=gateway
    )
    created = await service.create_upload_session(
        user_id="user-1",
        device_id=f"dev_{'a' * 32}",
        idempotency_key="large-material-resume-001",
        payload=CreateUploadSessionRequest(
            material_id="mat_large",
            filename="large.mp4",
            mime_type="video/mp4",
            file_size_bytes=80_000_000,
            source_sha256="a" * 64,
            origin="user_upload",
        ),
    )
    gateway.resumed_parts = [
        {"part_number": 1, "size_bytes": 16_777_216, "etag": "etag-1"},
        {"part_number": 2, "size_bytes": 16_777_216, "etag": "etag-2"},
    ]
    resumed = await service.resume_upload(
        user_id="user-1",
        device_id=f"dev_{'a' * 32}",
        session_id=created.upload_session_id,
    )
    with pytest.raises(ServiceError) as forbidden:
        await service.resume_upload(
            user_id="user-1",
            device_id=f"dev_{'b' * 32}",
            session_id=created.upload_session_id,
        )

    assert resumed.completed_parts == [1, 2]
    assert resumed.uploaded_bytes == 33_554_432
    assert forbidden.value.code == "operation_forbidden"


@pytest.mark.asyncio
async def test_new_single_upload_can_initialize_resume_before_first_signed_url() -> None:
    repository = FakeRepository(file_size=1024)
    gateway = FakeGateway()
    service = MaterialService(
        settings=settings(), repository=repository, upload_gateway=gateway
    )
    created = await service.create_upload_session(
        user_id="user-1",
        device_id=f"dev_{'a' * 32}",
        idempotency_key="single-material-resume-001",
        payload=CreateUploadSessionRequest(
            material_id="mat_large",
            filename="large.mp4",
            mime_type="video/mp4",
            file_size_bytes=1024,
            source_sha256="a" * 64,
            origin="user_upload",
        ),
    )
    resumed = await service.resume_upload(
        user_id="user-1",
        device_id=f"dev_{'a' * 32}",
        session_id=created.upload_session_id,
    )

    assert created.upload_mode == "single"
    assert resumed.upload_mode == "single"
    assert resumed.completed_parts == []
    assert resumed.uploaded_bytes == 0
