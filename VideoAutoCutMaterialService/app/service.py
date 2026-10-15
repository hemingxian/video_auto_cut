from __future__ import annotations

import hashlib
import json
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from .config import Settings
from .errors import ServiceError
from .models import (
    CompletePartRequest,
    CreateUploadSessionRequest,
    DownloadSessionResponse,
    FolderSyncItem,
    GenerationRunCreateRequest,
    GenerationRunStatusUpdateRequest,
    GenerationSnapshotRequest,
    MaterialSyncItem,
    PartAuthorization,
    PartAuthorizationResponse,
    PublicationCreateRequest,
    PublicationModerationRequest,
    PublicationReportCreateRequest,
    PublicationReportReviewRequest,
    PublicationReviewRequest,
    PublicationWithdrawRequest,
    PublicMaterialAddRequest,
    ReuseResult,
    SelectionResolveRequest,
    ShotMaterialValidationRequest,
    SyncBatchRequest,
    SyncBatchResponse,
    SyncBatchResult,
    UploadCompleteResponse,
    UploadResumeResponse,
    UploadSessionResponse,
)
from .repository import MaterialRepository
from .upload_gateway import UploadGateway, _datetime


def _request_hash(value: Any) -> str:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode()).hexdigest()


class MaterialService:
    def __init__(
        self,
        *,
        settings: Settings,
        repository: MaterialRepository,
        upload_gateway: UploadGateway,
    ) -> None:
        self.settings = settings
        self.repository = repository
        self.upload_gateway = upload_gateway
        self._active_verifications: set[tuple[str, str]] = set()

    async def sync_batch(self, user_id: str, payload: SyncBatchRequest) -> SyncBatchResponse:
        results: list[SyncBatchResult] = []
        for folder in payload.folders:
            try:
                revision = await self.repository.sync_folder(user_id, folder)
                results.append(
                    SyncBatchResult(
                        entity_type="folder",
                        entity_id=folder.folder_id,
                        ok=True,
                        revision=revision,
                    )
                )
            except ServiceError as error:
                results.append(
                    SyncBatchResult(
                        entity_type="folder",
                        entity_id=folder.folder_id,
                        ok=False,
                        error={"code": error.code, "message": error.message},
                    )
                )
        failed_folders = {
            result.entity_id for result in results if result.entity_type == "folder" and not result.ok
        }
        for material in payload.materials:
            if material.folder_id in failed_folders:
                results.append(
                    SyncBatchResult(
                        entity_type="material",
                        entity_id=material.material_id,
                        ok=False,
                        error={"code": "folder_sync_failed", "message": "素材文件夹同步失败"},
                    )
                )
                continue
            try:
                revision = await self.repository.sync_material(user_id, material)
                results.append(
                    SyncBatchResult(
                        entity_type="material",
                        entity_id=material.material_id,
                        ok=True,
                        revision=revision,
                    )
                )
            except ServiceError as error:
                results.append(
                    SyncBatchResult(
                        entity_type="material",
                        entity_id=material.material_id,
                        ok=False,
                        error={"code": error.code, "message": error.message},
                    )
                )
        return SyncBatchResponse(results=results)

    async def delete_cloud_copy(
        self,
        *,
        user_id: str,
        device_id: str,
        material_id: str,
        expected_revision: int,
        idempotency_key: str,
    ) -> dict[str, Any]:
        if not 8 <= len(idempotency_key) <= 128:
            raise ServiceError(400, "invalid_idempotency_key", "幂等键长度必须为8到128个字符")
        request = {"material_id": material_id, "revision": expected_revision}
        request_hash = _request_hash(request)
        stored = await self.repository.idempotency_get(
            user_id, "delete_cloud_copy", idempotency_key, request_hash
        )
        if stored:
            return stored[1]
        prepared = await self.repository.begin_cloud_copy_delete(
            user_id,
            material_id,
            expected_revision=expected_revision,
            operation_id=idempotency_key,
        )
        await self.upload_gateway.delete_cloud_copy(
            user_id,
            prepared["storage_session_id"],
            idempotency_key,
        )
        revision = await self.repository.finish_cloud_copy_delete(
            user_id,
            material_id,
            storage_session_id=prepared["storage_session_id"],
            operation_id=idempotency_key,
        )
        response = {
            "material_id": material_id,
            "cloud_status": "not_uploaded",
            "revision": revision,
        }
        await self.repository.idempotency_save(
            user_id,
            "delete_cloud_copy",
            idempotency_key,
            request_hash,
            200,
            response,
        )
        return response

    async def create_publication(
        self,
        *,
        user_id: str,
        material_id: str,
        idempotency_key: str,
        payload: PublicationCreateRequest,
    ) -> dict[str, Any]:
        if not 8 <= len(idempotency_key) <= 128:
            raise ServiceError(400, "invalid_idempotency_key", "幂等键长度必须为8到128个字符")
        if payload.consent_version != self.settings.consent_version:
            raise ServiceError(409, "consent_version_expired", "公开授权声明已更新，请重新确认")
        request_hash = _request_hash(
            {"material_id": material_id, **payload.model_dump(mode="json")}
        )
        stored = await self.repository.idempotency_get(
            user_id, "create_publication", idempotency_key, request_hash
        )
        if stored:
            return stored[1]
        response = await self.repository.create_publication(
            user_id,
            material_id,
            publication_id=f"pub_{uuid.uuid4().hex}",
            expected_revision=payload.revision,
            consent_version=payload.consent_version,
        )
        await self.repository.idempotency_save(
            user_id,
            "create_publication",
            idempotency_key,
            request_hash,
            201,
            response,
        )
        return response

    async def review_publication(
        self,
        *,
        actor_id: str,
        actor_role: str,
        publication_id: str,
        idempotency_key: str,
        payload: PublicationReviewRequest,
    ) -> dict[str, Any]:
        if actor_role not in {"admin", "moderator"}:
            raise ServiceError(403, "moderation_forbidden", "当前账号没有素材审核权限")
        if not 8 <= len(idempotency_key) <= 128:
            raise ServiceError(400, "invalid_idempotency_key", "幂等键长度必须为8到128个字符")
        request_hash = _request_hash(
            {"publication_id": publication_id, **payload.model_dump(mode="json")}
        )
        stored = await self.repository.idempotency_get(
            actor_id, "review_publication", idempotency_key, request_hash
        )
        if stored:
            return stored[1]
        response = await self.repository.review_publication(
            actor_id,
            actor_role,
            publication_id,
            expected_revision=payload.revision,
            decision=payload.decision,
            reason=payload.reason,
        )
        await self.repository.idempotency_save(
            actor_id,
            "review_publication",
            idempotency_key,
            request_hash,
            200,
            response,
        )
        return response

    async def add_public_material(
        self,
        *,
        user_id: str,
        publication_id: str,
        idempotency_key: str,
        payload: PublicMaterialAddRequest,
    ) -> dict[str, Any]:
        if not 8 <= len(idempotency_key) <= 128:
            raise ServiceError(400, "invalid_idempotency_key", "幂等键长度必须为8到128个字符")
        request_hash = _request_hash(
            {"publication_id": publication_id, **payload.model_dump(mode="json")}
        )
        stored = await self.repository.idempotency_get(
            user_id, "add_public_material", idempotency_key, request_hash
        )
        if stored:
            return stored[1]
        response = await self.repository.add_public_material(
            user_id,
            publication_id,
            folder_id=payload.folder_id,
            material_id=f"mat_{uuid.uuid4().hex}",
        )
        await self.repository.idempotency_save(
            user_id,
            "add_public_material",
            idempotency_key,
            request_hash,
            200,
            response,
        )
        return response

    async def withdraw_publication(
        self,
        *,
        user_id: str,
        publication_id: str,
        idempotency_key: str,
        payload: PublicationWithdrawRequest,
    ) -> dict[str, Any]:
        if not 8 <= len(idempotency_key) <= 128:
            raise ServiceError(400, "invalid_idempotency_key", "幂等键长度必须为8到128个字符")
        request_hash = _request_hash(
            {"publication_id": publication_id, **payload.model_dump(mode="json")}
        )
        stored = await self.repository.idempotency_get(
            user_id, "withdraw_publication", idempotency_key, request_hash
        )
        if stored:
            return stored[1]
        response = await self.repository.withdraw_publication(
            user_id,
            publication_id,
            expected_revision=payload.revision,
            reason=payload.reason,
        )
        await self.repository.idempotency_save(
            user_id,
            "withdraw_publication",
            idempotency_key,
            request_hash,
            200,
            response,
        )
        return response

    async def moderate_publication_status(
        self,
        *,
        actor_id: str,
        actor_role: str,
        publication_id: str,
        idempotency_key: str,
        payload: PublicationModerationRequest,
    ) -> dict[str, Any]:
        if actor_role not in {"admin", "moderator"}:
            raise ServiceError(403, "moderation_forbidden", "当前账号没有素材审核权限")
        if not 8 <= len(idempotency_key) <= 128:
            raise ServiceError(400, "invalid_idempotency_key", "幂等键长度必须为8到128个字符")
        request_hash = _request_hash(
            {"publication_id": publication_id, **payload.model_dump(mode="json")}
        )
        stored = await self.repository.idempotency_get(
            actor_id, "moderate_publication_status", idempotency_key, request_hash
        )
        if stored:
            return stored[1]
        response = await self.repository.moderate_publication_status(
            actor_id,
            actor_role,
            publication_id,
            expected_revision=payload.revision,
            action=payload.action,
            reason=payload.reason,
        )
        await self.repository.idempotency_save(
            actor_id,
            "moderate_publication_status",
            idempotency_key,
            request_hash,
            200,
            response,
        )
        return response

    async def create_publication_report(
        self,
        *,
        user_id: str,
        publication_id: str,
        idempotency_key: str,
        payload: PublicationReportCreateRequest,
    ) -> dict[str, Any]:
        if not 8 <= len(idempotency_key) <= 128:
            raise ServiceError(400, "invalid_idempotency_key", "幂等键长度必须为8到128个字符")
        request_hash = _request_hash(
            {"publication_id": publication_id, **payload.model_dump(mode="json")}
        )
        stored = await self.repository.idempotency_get(
            user_id, "create_publication_report", idempotency_key, request_hash
        )
        if stored:
            return stored[1]
        response = await self.repository.create_publication_report(
            user_id,
            publication_id,
            report_id=f"rpt_{uuid.uuid4().hex}",
            category=payload.category,
            description=payload.description,
        )
        await self.repository.idempotency_save(
            user_id,
            "create_publication_report",
            idempotency_key,
            request_hash,
            201,
            response,
        )
        return response

    async def list_publication_reports(
        self,
        *,
        actor_id: str,
        actor_role: str,
        status: str,
        limit: int,
    ) -> list[dict[str, Any]]:
        if actor_role not in {"admin", "moderator"}:
            raise ServiceError(403, "moderation_forbidden", "当前账号没有举报审核权限")
        if status not in {"pending", "reviewing", "upheld", "dismissed"}:
            raise ServiceError(422, "invalid_report_status", "举报状态无效")
        return await self.repository.list_publication_reports(
            actor_id,
            actor_role,
            status=status,
            limit=limit,
        )

    async def review_publication_report(
        self,
        *,
        actor_id: str,
        actor_role: str,
        report_id: str,
        idempotency_key: str,
        payload: PublicationReportReviewRequest,
    ) -> dict[str, Any]:
        if actor_role not in {"admin", "moderator"}:
            raise ServiceError(403, "moderation_forbidden", "当前账号没有举报审核权限")
        if not 8 <= len(idempotency_key) <= 128:
            raise ServiceError(400, "invalid_idempotency_key", "幂等键长度必须为8到128个字符")
        request_hash = _request_hash(
            {"report_id": report_id, **payload.model_dump(mode="json")}
        )
        stored = await self.repository.idempotency_get(
            actor_id, "review_publication_report", idempotency_key, request_hash
        )
        if stored:
            return stored[1]
        response = await self.repository.review_publication_report(
            actor_id,
            actor_role,
            report_id,
            expected_revision=payload.revision,
            decision=payload.decision,
            reason=payload.reason,
        )
        await self.repository.idempotency_save(
            actor_id,
            "review_publication_report",
            idempotency_key,
            request_hash,
            200,
            response,
        )
        return response

    async def create_upload_session(
        self,
        *,
        user_id: str,
        device_id: str,
        idempotency_key: str,
        payload: CreateUploadSessionRequest,
    ) -> UploadSessionResponse:
        if not 8 <= len(idempotency_key) <= 128:
            raise ServiceError(400, "invalid_idempotency_key", "幂等键长度必须为8到128个字符")
        if payload.file_size_bytes > self.settings.upload_max_bytes:
            raise ServiceError(413, "file_too_large", "素材文件超过上传大小限制")
        request_hash = _request_hash(payload.model_dump(mode="json"))
        stored = await self.repository.idempotency_get(
            user_id, "create_upload_session", idempotency_key, request_hash
        )
        if stored:
            return UploadSessionResponse.model_validate(stored[1])
        material = await self.repository.get_material(user_id, payload.material_id)
        if (
            material["display_name"] != payload.filename
            or material["mime_type"] != payload.mime_type
            or material["file_size_bytes"] != payload.file_size_bytes
            or material["source_sha256"] != payload.source_sha256
            or material["origin"] != payload.origin
        ):
            raise ServiceError(409, "material_identity_conflict", "上传文件与素材身份不一致")
        session_id = f"upl_{uuid.uuid4().hex}"
        expires_at = datetime.now(UTC) + timedelta(hours=24)
        upload_mode = (
            "multipart"
            if payload.file_size_bytes >= self.settings.multipart_threshold_bytes
            else "single"
        )
        configured_part_size = (
            self.settings.part_size_bytes
            if upload_mode == "multipart"
            else payload.file_size_bytes
        )
        created = await self.repository.create_upload_session(
            user_id,
            device_id,
            session_id,
            payload.material_id,
            upload_mode,
            configured_part_size,
            expires_at,
        )
        if not created["reuse"] and upload_mode == "multipart":
            try:
                internal = await self.upload_gateway.create_multipart(
                    user_id=user_id,
                    business_session_id=session_id,
                    asset_id=material["asset_id"],
                    asset_version=int(material["asset_version"]),
                    filename=material["display_name"],
                    mime_type=material["mime_type"],
                    size_bytes=int(material["file_size_bytes"]),
                    source_sha256=material["source_sha256"],
                )
                internal_id = str(internal.get("id") or "")
                part_size = int(internal.get("part_size_bytes") or configured_part_size)
                internal_expires = _datetime(internal.get("expires_at"))
                if not internal_id or part_size <= 0:
                    raise ServiceError(503, "upload_service_invalid", "上传服务没有返回分片会话")
                await self.repository.attach_internal_upload(
                    user_id,
                    session_id,
                    internal_id,
                    internal_expires,
                    part_size,
                )
                configured_part_size = part_size
                expires_at = internal_expires
            except ServiceError as error:
                await self.repository.mark_upload_result(
                    user_id, session_id, ready=False, error=error.message
                )
                raise
        response = UploadSessionResponse(
            upload_session_id=session_id,
            status="ready" if created["reuse"] else "created",
            upload_mode=upload_mode,
            part_size_bytes=configured_part_size,
            expires_at=expires_at,
            reuse=ReuseResult(type="own_asset" if created["reuse"] else "none"),
            upload={
                "max_parallel_parts": (
                    self.settings.max_parallel_parts if upload_mode == "multipart" else 1
                )
            },
        )
        await self.repository.idempotency_save(
            user_id,
            "create_upload_session",
            idempotency_key,
            request_hash,
            200,
            response.model_dump(mode="json"),
        )
        return response

    async def part_authorizations(
        self,
        *,
        user_id: str,
        device_id: str,
        session_id: str,
        part_numbers: list[int],
    ) -> PartAuthorizationResponse:
        session = await self.repository.get_upload_session(user_id, session_id)
        if session["device_id"] != device_id:
            raise ServiceError(403, "operation_forbidden", "上传会话不属于当前设备")
        if session["status"] in {"canceled", "verifying", "ready", "failed"}:
            raise ServiceError(409, "upload_state_conflict", "当前上传状态不能继续上传")
        if _datetime(session["expires_at"]) <= datetime.now(UTC):
            raise ServiceError(410, "upload_session_expired", "上传会话已过期，请重新创建")
        if session["upload_mode"] == "multipart":
            internal_id = str(session.get("internal_upload_session_id") or "")
            if not internal_id:
                raise ServiceError(409, "upload_not_started", "分片上传尚未初始化")
            authorizations: list[PartAuthorization] = []
            for part_number in part_numbers:
                size_bytes = self._expected_part_size(session, part_number)
                internal = await self.upload_gateway.multipart_part_authorization(
                    user_id, internal_id, part_number, size_bytes
                )
                authorization = self.upload_gateway.public_part_authorization(internal)
                if authorization["part_number"] != part_number:
                    raise ServiceError(503, "upload_service_invalid", "分片授权编号不一致")
                authorizations.append(
                    PartAuthorization(
                        part_number=part_number,
                        url=authorization["url"],
                        headers=authorization["headers"],
                        expires_at=authorization["expires_at"],
                    )
                )
            return PartAuthorizationResponse(authorizations=authorizations)
        if part_numbers != [1]:
            raise ServiceError(422, "invalid_part_number", "整文件上传只接受单段")
        material = await self.repository.get_material(user_id, session["material_id"])
        internal = await self.upload_gateway.create(
            user_id=user_id,
            business_session_id=session_id,
            asset_id=session["asset_id"],
            asset_version=int(session["asset_version"]),
            filename=material["display_name"],
            mime_type=material["mime_type"],
            size_bytes=int(session["expected_size"]),
            source_sha256=session["source_sha256"],
        )
        authorization = self.upload_gateway.public_authorization(internal)
        internal_id = str(internal.get("id") or "")
        if not internal_id:
            raise ServiceError(503, "upload_service_invalid", "上传服务没有返回会话 ID")
        await self.repository.attach_internal_upload(
            user_id, session_id, internal_id, authorization["expires_at"]
        )
        return PartAuthorizationResponse(
            authorizations=[
                PartAuthorization(
                    part_number=1,
                    url=authorization["url"],
                    headers=authorization["headers"],
                    expires_at=authorization["expires_at"],
                )
            ]
        )

    async def complete_part(
        self,
        *,
        user_id: str,
        device_id: str,
        session_id: str,
        payload: CompletePartRequest,
    ) -> dict[str, Any]:
        session = await self.repository.get_upload_session(user_id, session_id)
        if session["device_id"] != device_id:
            raise ServiceError(403, "operation_forbidden", "上传会话不属于当前设备")
        if session["status"] in {"canceled", "verifying", "ready", "failed"}:
            raise ServiceError(409, "upload_state_conflict", "当前上传状态不能提交分段")
        expected_size = self._expected_part_size(session, payload.part_number)
        if payload.size_bytes != expected_size:
            raise ServiceError(422, "invalid_part", "上传分段大小或编号不正确")
        if session["upload_mode"] == "single" and payload.checksum != session["source_sha256"]:
            raise ServiceError(422, "part_checksum_mismatch", "上传分段校验值与素材指纹不一致")
        if session["upload_mode"] == "multipart":
            internal_id = str(session.get("internal_upload_session_id") or "")
            if not internal_id:
                raise ServiceError(409, "upload_not_started", "分片上传尚未初始化")
            await self.upload_gateway.complete_multipart_part(
                user_id,
                internal_id,
                payload.part_number,
                payload.size_bytes,
                payload.etag,
            )
        await self.repository.complete_part(
            user_id,
            session_id,
            payload.part_number,
            payload.size_bytes,
            payload.checksum,
            payload.etag,
        )
        return {"ok": True, "part_number": payload.part_number}

    async def complete_upload(
        self, *, user_id: str, device_id: str, session_id: str
    ) -> UploadCompleteResponse:
        session = await self.repository.get_upload_session(user_id, session_id)
        if session["device_id"] != device_id:
            raise ServiceError(403, "operation_forbidden", "上传会话不属于当前设备")
        if session["status"] in {"verifying", "ready"}:
            return UploadCompleteResponse(
                upload_session_id=session_id,
                status=session["status"],
                cloud_status=session["status"],
            )
        if session["status"] in {"canceled", "failed"}:
            raise ServiceError(409, "upload_state_conflict", "当前上传状态不能完成")
        progress = await self.repository.upload_session_progress(user_id, session_id)
        parts = progress["completed_parts"]
        total_parts = (
            int(session["expected_size"]) + int(session["part_size_bytes"]) - 1
        ) // int(session["part_size_bytes"])
        if (
            len(parts) != total_parts
            or [int(part["part_number"]) for part in parts] != list(range(1, total_parts + 1))
            or int(progress["uploaded_bytes"]) != int(session["expected_size"])
            or (
                session["upload_mode"] == "single"
                and parts[0]["checksum_sha256"] != session["source_sha256"]
            )
        ):
            raise ServiceError(409, "upload_incomplete", "上传文件尚未完整提交")
        internal_id = str(session.get("internal_upload_session_id") or "")
        if not internal_id:
            raise ServiceError(409, "upload_not_started", "上传尚未开始")
        if session["upload_mode"] == "multipart":
            await self.upload_gateway.complete_multipart(user_id, internal_id)
        else:
            await self.upload_gateway.complete(user_id, internal_id)
        await self.repository.mark_upload_verifying(user_id, session_id)
        return UploadCompleteResponse(
            upload_session_id=session_id,
            status="verifying",
            cloud_status="verifying",
        )

    async def verify_upload(self, *, user_id: str, session_id: str) -> None:
        session = await self.repository.get_upload_session(user_id, session_id)
        internal_id = str(session.get("internal_upload_session_id") or "")
        try:
            await self.upload_gateway.verify_sha256(
                user_id,
                internal_id,
                str(session["source_sha256"]),
                int(session["expected_size"]),
            )
        except ServiceError as error:
            await self.repository.mark_upload_result(
                user_id, session_id, ready=False, error=error.message
            )
            return
        await self.repository.mark_upload_result(user_id, session_id, ready=True)
        # File readiness only describes the verified cloud copy. Desktop backups
        # submit their completed local analysis before uploading the video; do not
        # create a second, default-profile pending analysis after verification.
        # Explicit analysis/status-check requests remain available independently.

    async def resume_upload_verification(self, *, user_id: str, session_id: str) -> None:
        key = (user_id, session_id)
        if key in self._active_verifications:
            return
        self._active_verifications.add(key)
        try:
            await self.verify_upload(user_id=user_id, session_id=session_id)
        finally:
            self._active_verifications.discard(key)

    async def cancel_upload(
        self, *, user_id: str, device_id: str, session_id: str
    ) -> dict[str, Any]:
        session = await self.repository.get_upload_session(user_id, session_id)
        if session["device_id"] != device_id:
            raise ServiceError(403, "operation_forbidden", "上传会话不属于当前设备")
        internal_id = str(session.get("internal_upload_session_id") or "")
        if session["upload_mode"] == "multipart" and internal_id:
            await self.upload_gateway.abort_multipart(user_id, internal_id)
        await self.repository.cancel_upload_session(user_id, session_id)
        return {"upload_session_id": session_id, "status": "canceled"}

    async def resume_upload(
        self, *, user_id: str, device_id: str, session_id: str
    ) -> UploadResumeResponse:
        session = await self.repository.get_upload_session(user_id, session_id)
        if session["device_id"] != device_id:
            raise ServiceError(403, "operation_forbidden", "上传会话不属于当前设备")
        if session["status"] not in {"created", "uploading"}:
            raise ServiceError(409, "upload_state_conflict", "当前上传状态不能恢复")
        internal_id = str(session.get("internal_upload_session_id") or "")
        if not internal_id and session["upload_mode"] == "multipart":
            raise ServiceError(409, "upload_not_started", "上传尚未初始化")
        internal_parts: list[dict[str, Any]] = []
        if session["upload_mode"] == "multipart":
            internal = await self.upload_gateway.resume_multipart(user_id, internal_id)
            if str(internal.get("id") or "") != internal_id:
                raise ServiceError(503, "upload_service_invalid", "上传服务返回了错误的会话")
            if str(internal.get("status") or "") != "initiated":
                raise ServiceError(409, "upload_state_conflict", "内部上传会话不能恢复")
            if int(internal.get("part_size_bytes") or 0) != int(session["part_size_bytes"]):
                raise ServiceError(409, "upload_part_size_conflict", "上传分片大小已发生变化")
            raw_parts = internal.get("completed_parts")
            if not isinstance(raw_parts, list):
                raise ServiceError(503, "upload_service_invalid", "上传服务没有返回分片进度")
            seen: set[int] = set()
            for raw in raw_parts:
                if not isinstance(raw, dict):
                    raise ServiceError(503, "upload_service_invalid", "上传服务分片进度无效")
                part_number = int(raw.get("part_number") or 0)
                size_bytes = int(raw.get("size_bytes") or 0)
                if part_number in seen or size_bytes != self._expected_part_size(session, part_number):
                    raise ServiceError(503, "upload_service_invalid", "上传服务分片进度无效")
                etag = str(raw.get("etag") or "").strip('"')
                if not etag:
                    raise ServiceError(503, "upload_service_invalid", "上传服务分片进度无效")
                seen.add(part_number)
                internal_parts.append(
                    {
                        "part_number": part_number,
                        "size_bytes": size_bytes,
                        "etag": etag,
                    }
                )
        else:
            progress = await self.repository.upload_session_progress(user_id, session_id)
            internal_parts = [dict(part) for part in progress["completed_parts"]]
            if internal_id:
                internal = await self.upload_gateway.resume(user_id, internal_id)
                if str(internal.get("id") or "") != internal_id:
                    raise ServiceError(503, "upload_service_invalid", "上传服务返回了错误的会话")
                expires_at = _datetime(internal.get("expires_at"))
            else:
                expires_at = _datetime(session["expires_at"])
        if session["upload_mode"] == "multipart":
            expires_at = _datetime(internal.get("expires_at"))
        progress = await self.repository.resume_upload_session(
            user_id,
            session_id,
            expires_at=expires_at,
            internal_parts=internal_parts,
        )
        return UploadResumeResponse(
            upload_session_id=session_id,
            status=str(progress["status"]),
            upload_mode=str(progress["upload_mode"]),
            part_size_bytes=int(progress["part_size_bytes"]),
            uploaded_bytes=int(progress["uploaded_bytes"]),
            completed_parts=[
                int(part["part_number"]) for part in progress["completed_parts"]
            ],
            expires_at=progress["expires_at"],
        )

    async def resolve_selection(
        self, *, user_id: str, payload: SelectionResolveRequest
    ) -> dict[str, Any]:
        if len(set(payload.material_ids)) != len(payload.material_ids):
            raise ServiceError(422, "duplicate_material", "选择结果中包含重复素材")
        materials = await self.repository.resolve_materials(user_id, payload.material_ids)
        by_id = {item["material_id"]: item for item in materials}
        resolved = []
        unavailable = []
        for material_id in payload.material_ids:
            item = by_id.get(material_id)
            if not item:
                unavailable.append({"material_id": material_id, "reason": "not_found_or_forbidden"})
                continue
            resolved.append(
                {
                    **item,
                    "cloud_ready": item["cloud_status"] == "ready",
                    "download_available": item["cloud_status"] == "ready",
                }
            )
        return {"items": resolved, "unavailable": unavailable}

    async def validate_shot_materials(
        self, *, user_id: str, payload: ShotMaterialValidationRequest
    ) -> dict[str, Any]:
        shot_results: list[dict[str, Any]] = []
        blocker_count = 0
        warning_count = 0

        def issue(
            issues: list[dict[str, Any]],
            *,
            code: str,
            severity: str,
            message: str,
            action: str,
            material_id: str | None = None,
            folder_id: str | None = None,
        ) -> None:
            value: dict[str, Any] = {
                "code": code,
                "severity": severity,
                "message": message,
                "action": action,
            }
            if material_id:
                value["material_id"] = material_id
            if folder_id:
                value["folder_id"] = folder_id
            issues.append(value)

        for shot in payload.shots:
            issues: list[dict[str, Any]] = []
            candidates: list[dict[str, Any]] = []
            bindings = shot.material_bindings
            if shot.download_material:
                if bindings:
                    issue(
                        issues,
                        code="automatic_download_has_bindings",
                        severity="blocker",
                        message="自动下载模式不能同时保留已选素材",
                        action="clear_bindings",
                    )
            elif not bindings:
                issue(
                    issues,
                    code="material_binding_required",
                    severity="blocker",
                    message="使用已选素材时至少需要一个素材或文件夹",
                    action="select_materials",
                )
            else:
                explicit_ids = [
                    binding.material_id
                    for binding in bindings
                    if binding.binding_type == "material" and binding.material_id
                ]
                explicit = await self.repository.resolve_materials(user_id, explicit_ids)
                explicit_by_id = {item["material_id"]: item for item in explicit}
                for binding in bindings:
                    if binding.binding_type == "material":
                        material_id = str(binding.material_id)
                        material = explicit_by_id.get(material_id)
                        if material:
                            candidates.append(material)
                        else:
                            issue(
                                issues,
                                code="material_unavailable",
                                severity="blocker",
                                message="素材不存在、已删除或当前账号无权访问",
                                action="remove_binding",
                                material_id=material_id,
                            )
                        continue
                    folder_id = str(binding.folder_id)
                    folder_result = await self.repository.resolve_folder_materials(
                        user_id,
                        folder_id,
                        include_subfolders=binding.include_subfolders,
                    )
                    if not folder_result["exists"]:
                        issue(
                            issues,
                            code="folder_unavailable",
                            severity="blocker",
                            message="素材文件夹不存在、已删除或当前账号无权访问",
                            action="remove_binding",
                            folder_id=folder_id,
                        )
                        continue
                    folder_materials = folder_result["materials"]
                    if not folder_materials:
                        issue(
                            issues,
                            code="folder_empty",
                            severity="blocker",
                            message="素材文件夹展开后的候选数量为 0",
                            action="select_materials",
                            folder_id=folder_id,
                        )
                        continue
                    candidates.extend(folder_materials)

            unique: dict[tuple[str, int], dict[str, Any]] = {}
            for material in candidates:
                identity = (str(material["asset_id"]), int(material["asset_version"]))
                unique.setdefault(identity, material)
            duplicate_asset_count = max(0, len(candidates) - len(unique))
            if len(unique) > 500:
                issue(
                    issues,
                    code="too_many_candidates",
                    severity="blocker",
                    message="单个分镜展开后的素材不能超过 500 个",
                    action="narrow_selection",
                )
                unique = dict(list(unique.items())[:500])

            resolved = []
            for material in unique.values():
                material_id = str(material["material_id"])
                cloud_status = str(material.get("cloud_status") or "not_uploaded")
                raw_analysis_status = str(material.get("analysis_status") or "pending")
                raw_vector_status = str(material.get("vector_sync_status") or "pending")
                analysis_status = (
                    "ready" if raw_analysis_status in {"ready", "completed"}
                    else raw_analysis_status
                )
                vector_status = (
                    "ready" if raw_vector_status in {"ready", "completed"}
                    else raw_vector_status
                )
                if cloud_status != "ready":
                    issue(
                        issues,
                        code="cloud_copy_not_ready",
                        severity="blocker" if payload.require_cloud_ready else "warning",
                        message="素材尚未完成云端备份",
                        action="upload_cloud_copy",
                        material_id=material_id,
                    )
                if analysis_status != "ready":
                    issue(
                        issues,
                        code="analysis_not_ready",
                        severity="blocker" if payload.require_analysis_ready else "warning",
                        message="素材分析尚未完成",
                        action="analyze_material",
                        material_id=material_id,
                    )
                elif vector_status != "ready":
                    issue(
                        issues,
                        code="vector_sync_not_ready",
                        severity="warning",
                        message="素材分析已完成，但云端向量仍在同步",
                        action="retry_analysis_sync",
                        material_id=material_id,
                    )
                resolved.append(
                    {
                        "material_id": material_id,
                        "asset_id": material["asset_id"],
                        "asset_version": int(material["asset_version"]),
                        "cloud_status": cloud_status,
                        "analysis_status": analysis_status,
                        "vector_sync_status": vector_status,
                    }
                )

            shot_blockers = sum(item["severity"] == "blocker" for item in issues)
            shot_warnings = sum(item["severity"] == "warning" for item in issues)
            blocker_count += shot_blockers
            warning_count += shot_warnings
            shot_results.append(
                {
                    "shot_id": shot.shot_id,
                    "valid": shot_blockers == 0,
                    "download_material": shot.download_material,
                    "binding_count": len(bindings),
                    "resolved_material_count": len(resolved),
                    "duplicate_asset_count": duplicate_asset_count,
                    "materials": resolved,
                    "issues": issues,
                }
            )
        return {
            "valid": blocker_count == 0,
            "summary": {
                "shot_count": len(shot_results),
                "valid_shot_count": sum(item["valid"] for item in shot_results),
                "blocker_count": blocker_count,
                "warning_count": warning_count,
            },
            "shots": shot_results,
        }

    async def create_generation_run(
        self,
        *,
        user_id: str,
        device_id: str,
        idempotency_key: str,
        payload: GenerationRunCreateRequest,
    ) -> dict[str, Any]:
        if not 8 <= len(idempotency_key) <= 128:
            raise ServiceError(400, "invalid_idempotency_key", "幂等键长度必须为8到128个字符")
        request_value = payload.model_dump(mode="json")
        request_checksum = _request_hash(request_value)
        stored = await self.repository.idempotency_get(
            user_id, "create_generation_run", idempotency_key, request_checksum
        )
        if stored:
            return stored[1]
        reusable = await self.repository.reuse_generation_run(
            user_id,
            task_id=payload.task_id,
            task_revision=payload.task_revision,
            request_checksum=request_checksum,
        )
        if reusable:
            await self.repository.idempotency_save(
                user_id,
                "create_generation_run",
                idempotency_key,
                request_checksum,
                201,
                reusable,
            )
            return reusable

        validation_payload = ShotMaterialValidationRequest.model_validate(
            {
                "shots": [shot.model_dump(mode="json") for shot in payload.shots],
                "require_cloud_ready": payload.require_cloud_ready,
                "require_analysis_ready": payload.require_analysis_ready,
            }
        )
        validation = await self.validate_shot_materials(
            user_id=user_id, payload=validation_payload
        )
        if not validation["valid"]:
            raise ServiceError(
                409,
                "generation_material_invalid",
                "生成素材校验未通过",
                action="resolve_validation_issues",
                details=validation,
            )

        resolved_shots: list[dict[str, Any]] = []
        for shot in validation["shots"]:
            material_ids = [item["material_id"] for item in shot["materials"]]
            materials = (
                await self.repository.resolve_materials(user_id, material_ids)
                if material_ids
                else []
            )
            by_id = {item["material_id"]: item for item in materials}
            if len(by_id) != len(material_ids):
                raise ServiceError(
                    409,
                    "material_changed_during_freeze",
                    "素材在生成清单固化期间发生变化，请重新校验",
                    action="retry",
                    details={"shot_id": shot["shot_id"]},
                )
            identities = [
                {
                    "material_id": material_id,
                    "asset_id": by_id[material_id]["asset_id"],
                    "asset_version": int(by_id[material_id]["asset_version"]),
                    "source_sha256": by_id[material_id]["source_sha256"],
                }
                for material_id in material_ids
            ]
            shot_checksum = _request_hash(
                {
                    "shot_id": shot["shot_id"],
                    "download_material": shot["download_material"],
                    "materials": identities,
                }
            )
            resolved_shots.append(
                {
                    "shot_id": shot["shot_id"],
                    "download_material": shot["download_material"],
                    "checksum": shot_checksum,
                    "materials": identities,
                }
            )

        manifest_checksum = _request_hash(
            {
                "schema_version": 1,
                "task_id": payload.task_id,
                "task_revision": payload.task_revision,
                "shots": resolved_shots,
            }
        )
        response = await self.repository.create_generation_run(
            user_id,
            device_id=device_id,
            run_id=f"run_{uuid.uuid4().hex}",
            task_id=payload.task_id,
            task_revision=payload.task_revision,
            request_checksum=request_checksum,
            manifest_checksum=manifest_checksum,
            shots=resolved_shots,
        )
        await self.repository.idempotency_save(
            user_id,
            "create_generation_run",
            idempotency_key,
            request_checksum,
            201,
            response,
        )
        return response

    async def get_generation_run(self, *, user_id: str, run_id: str) -> dict[str, Any]:
        return await self.repository.get_generation_run(user_id, run_id)

    async def update_generation_run(
        self,
        *,
        user_id: str,
        run_id: str,
        idempotency_key: str,
        payload: GenerationRunStatusUpdateRequest,
    ) -> dict[str, Any]:
        if not 8 <= len(idempotency_key) <= 128:
            raise ServiceError(400, "invalid_idempotency_key", "幂等键长度必须为8到128个字符")
        request_checksum = _request_hash(
            {"run_id": run_id, **payload.model_dump(mode="json")}
        )
        stored = await self.repository.idempotency_get(
            user_id, "update_generation_run", idempotency_key, request_checksum
        )
        if stored:
            return stored[1]
        response = await self.repository.update_generation_run(
            user_id,
            run_id,
            expected_revision=payload.revision,
            status=payload.status,
            stage=payload.stage,
            progress=payload.progress,
            current_shot_id=payload.current_shot_id,
            current_material_id=payload.current_material_id,
            error_code=payload.error_code,
            error_message=payload.error_message,
        )
        await self.repository.idempotency_save(
            user_id,
            "update_generation_run",
            idempotency_key,
            request_checksum,
            200,
            response,
        )
        return response

    async def get_generation_manifest(
        self, *, user_id: str, run_id: str
    ) -> dict[str, Any]:
        return await self.repository.get_generation_manifest(user_id, run_id)

    async def freeze_generation_snapshot(
        self, *, user_id: str, payload: GenerationSnapshotRequest
    ) -> dict[str, Any]:
        if len(set(payload.material_ids)) != len(payload.material_ids):
            raise ServiceError(422, "duplicate_material", "生成素材中包含重复项")
        materials = await self.repository.resolve_materials(user_id, payload.material_ids)
        if len(materials) != len(payload.material_ids):
            raise ServiceError(409, "material_unavailable", "部分素材不存在或已无权访问")
        if payload.require_cloud_ready:
            pending = [item["material_id"] for item in materials if item["cloud_status"] != "ready"]
            if pending:
                raise ServiceError(
                    409,
                    "cloud_copy_not_ready",
                    "部分素材尚未完成云端同步",
                    details={"material_ids": pending},
                )
        by_id = {item["material_id"]: item for item in materials}
        ordered = [by_id[material_id] for material_id in payload.material_ids]
        identity = [
            [
                item["material_id"],
                item["asset_id"],
                int(item["asset_version"]),
                item["source_sha256"],
            ]
            for item in ordered
        ]
        checksum = _request_hash(identity)
        stored = await self.repository.freeze_material_snapshot(
            user_id,
            run_id=payload.run_id,
            shot_id=payload.shot_id,
            download_material=payload.download_material,
            materials=ordered,
            checksum=checksum,
        )
        return {
            "run_id": payload.run_id,
            "shot_id": payload.shot_id,
            "checksum": checksum,
            "created": stored["created"],
            "items": identity,
        }

    async def download_session(
        self, *, user_id: str, material_id: str
    ) -> DownloadSessionResponse:
        material = await self.repository.storage_session_for_material(user_id, material_id)
        internal = await self.upload_gateway.download_authorization(
            user_id, material["storage_session_id"]
        )
        url = str(internal.get("url") or "")
        if not url.startswith("https://"):
            raise ServiceError(503, "download_authorization_invalid", "下载授权无效")
        return DownloadSessionResponse(
            download_session_id=f"dls_{uuid.uuid4().hex}",
            url=url,
            expires_at=_datetime(internal.get("expires_at")),
            file_size_bytes=int(material["source_size"]),
            source_sha256=material["source_sha256"],
            mime_type=material["mime_type"],
            range_supported=True,
        )

    @staticmethod
    def _expected_part_size(session: dict[str, Any], part_number: int) -> int:
        part_size = int(session["part_size_bytes"])
        expected_size = int(session["expected_size"])
        total_parts = (expected_size + part_size - 1) // part_size
        if part_number < 1 or part_number > total_parts:
            raise ServiceError(422, "invalid_part_number", "上传分片编号无效")
        start = (part_number - 1) * part_size
        return min(part_size, expected_size - start)
