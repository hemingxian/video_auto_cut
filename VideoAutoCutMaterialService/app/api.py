from __future__ import annotations

import uuid
import hmac
from typing import Annotated, Any

from fastapi import APIRouter, BackgroundTasks, Depends, Header, Query, Request, Response

from .auth import Principal
from .container import Container
from .errors import ServiceError
from .models import (
    CompletePartRequest,
    CreateUploadSessionRequest,
    AnalysisCompleteRequest,
    ClientAnalysisResultRequest,
    AnalysisStatusCheckRequest,
    AnalysisWorkerClaimRequest,
    FolderUpdateRequest,
    GenerationRunCreateRequest,
    GenerationRunStatusUpdateRequest,
    GenerationSnapshotRequest,
    HealthResponse,
    MaterialUpdateRequest,
    PartAuthorizationRequest,
    PublicationCreateRequest,
    PublicationModerationRequest,
    PublicationReportCreateRequest,
    PublicationReportReviewRequest,
    PublicationReviewRequest,
    PublicationWithdrawRequest,
    PublicMaterialAddRequest,
    RevisionRequest,
    SemanticSearchRequest,
    SelectionResolveRequest,
    ShotMaterialValidationRequest,
    SyncBatchRequest,
)


router = APIRouter()


def request_id(request: Request) -> str:
    return request.headers.get("X-Request-Id") or f"req_{uuid.uuid4().hex}"


def container(request: Request) -> Container:
    value = getattr(request.app.state, "container", None)
    if value is None:
        raise ServiceError(503, "service_not_ready", "服务尚未完成启动")
    return value


async def principal(
    request: Request,
    authorization: str | None = Header(default=None),
    device_header: str | None = Header(default=None, alias="X-Device-Id"),
) -> Principal:
    services = container(request)
    actor = await services.auth.resolve(authorization, device_header)
    await services.repository.register_device(actor.user_id, actor.device_id)
    return actor


Actor = Annotated[Principal, Depends(principal)]


def analysis_service(request: Request):
    service = container(request).analysis
    if service is None:
        raise ServiceError(503, "analysis_service_not_ready", "分析服务尚未启动")
    return service


async def analysis_worker(
    request: Request,
    worker_token: str | None = Header(default=None, alias="X-Worker-Token"),
) -> str:
    configured = container(request).settings.analysis_worker_token
    if not configured:
        raise ServiceError(503, "analysis_worker_disabled", "分析工作器接口尚未配置")
    if not worker_token or not hmac.compare_digest(worker_token, configured):
        raise ServiceError(401, "worker_unauthorized", "分析工作器认证失败")
    return worker_token


Worker = Annotated[str, Depends(analysis_worker)]


@router.get("/health/live", response_model=HealthResponse)
async def live() -> HealthResponse:
    return HealthResponse(status="ok")


@router.get("/health/ready", response_model=HealthResponse)
async def ready(request: Request) -> HealthResponse:
    await container(request).repository.ping()
    return HealthResponse(status="ready")


@router.get("/v1/material-config")
async def material_config(request: Request, actor: Actor) -> dict[str, Any]:
    settings = container(request).settings
    return {
        "upload": {
            "multipart_threshold_bytes": settings.multipart_threshold_bytes,
            "part_size_bytes": settings.part_size_bytes,
            "max_parallel_parts": settings.max_parallel_parts,
        },
        "limits": {"max_file_bytes": settings.upload_max_bytes, "max_batch_items": 100},
        "analysis": {
            "profile_id": settings.analysis_profile_id,
            "dimension": settings.vector_dimension,
            "worker_enabled": bool(settings.analysis_worker_token),
            "cloud_vector_enabled": bool(
                settings.cloud_vector_search_url and settings.cloud_vector_upsert_url
            ),
        },
        "publications": {
            "consent_version": settings.consent_version,
            "review_required": True,
        },
        "platform_downloads": {
            "auto_sync_enabled": settings.platform_auto_sync_enabled,
        },
    }


@router.get("/v1/devices")
async def list_devices(request: Request, actor: Actor) -> dict[str, Any]:
    items = await container(request).repository.list_devices(actor.user_id)
    return {"items": items}


@router.post("/v1/devices/{device_id}/revoke")
async def revoke_device(device_id: str, request: Request, actor: Actor) -> dict[str, Any]:
    services = container(request)
    await services.repository.revoke_device(actor.user_id, device_id)
    await services.repository.record_audit(
        actor.user_id,
        device_id=actor.device_id,
        action="device.revoke",
        resource_type="device",
        resource_id=device_id,
        result="success",
        request_id=request_id(request),
    )
    return {"device_id": device_id, "revoked": True}


@router.get("/v1/folders")
async def list_folders(request: Request, actor: Actor) -> dict[str, Any]:
    items = await container(request).repository.list_folders(actor.user_id)
    return {"items": items, "next_cursor": None, "has_more": False}


@router.patch("/v1/folders/{folder_id}")
async def update_folder(
    folder_id: str,
    payload: FolderUpdateRequest,
    request: Request,
    actor: Actor,
) -> dict[str, Any]:
    update_parent = "parent_folder_id" in payload.model_fields_set
    if payload.name is None and not update_parent:
        raise ServiceError(422, "empty_update", "没有可更新的文件夹字段")
    return await container(request).repository.update_folder(
        actor.user_id,
        folder_id,
        expected_revision=payload.revision,
        name=payload.name,
        parent_folder_id=payload.parent_folder_id,
        update_parent=update_parent,
    )


@router.delete("/v1/folders/{folder_id}")
async def delete_folder(
    folder_id: str,
    payload: RevisionRequest,
    request: Request,
    actor: Actor,
) -> dict[str, Any]:
    revision = await container(request).repository.delete_folder(
        actor.user_id, folder_id, expected_revision=payload.revision
    )
    await container(request).repository.record_audit(
        actor.user_id,
        device_id=actor.device_id,
        action="folder.delete",
        resource_type="folder",
        resource_id=folder_id,
        result="success",
        request_id=request_id(request),
        details={"revision": revision},
    )
    return {"folder_id": folder_id, "deleted": True, "revision": revision}


@router.get("/v1/materials")
async def list_materials(
    request: Request,
    background_tasks: BackgroundTasks,
    actor: Actor,
    limit: int = Query(default=50, ge=1, le=100),
    cursor: str | None = None,
    folder_id: str | None = None,
    keyword: str | None = Query(default=None, max_length=255),
) -> dict[str, Any]:
    services = container(request)
    for session_id in await services.repository.list_verifying_uploads(actor.user_id):
        background_tasks.add_task(
            services.materials.resume_upload_verification,
            user_id=actor.user_id,
            session_id=session_id,
        )
    items, next_cursor = await services.repository.list_materials(
        actor.user_id,
        limit=limit,
        cursor=cursor,
        folder_id=folder_id,
        keyword=keyword,
    )
    return {"items": items, "next_cursor": next_cursor, "has_more": bool(next_cursor)}


@router.get("/v1/materials/{material_id}")
async def get_material(material_id: str, request: Request, actor: Actor) -> dict[str, Any]:
    return await container(request).repository.get_material(actor.user_id, material_id)


@router.patch("/v1/materials/{material_id}")
async def update_material(
    material_id: str,
    payload: MaterialUpdateRequest,
    request: Request,
    actor: Actor,
) -> dict[str, Any]:
    if payload.display_name is None and payload.folder_id is None:
        raise ServiceError(422, "empty_update", "没有可更新的素材字段")
    return await container(request).repository.update_material(
        actor.user_id,
        material_id,
        expected_revision=payload.revision,
        display_name=payload.display_name,
        folder_id=payload.folder_id,
    )


@router.delete("/v1/materials/{material_id}")
async def delete_material(
    material_id: str,
    payload: RevisionRequest,
    request: Request,
    actor: Actor,
) -> dict[str, Any]:
    revision = await container(request).repository.delete_material(
        actor.user_id, material_id, expected_revision=payload.revision
    )
    await container(request).repository.record_audit(
        actor.user_id,
        device_id=actor.device_id,
        action="material.delete",
        resource_type="material",
        resource_id=material_id,
        result="success",
        request_id=request_id(request),
        details={"revision": revision},
    )
    return {"material_id": material_id, "deleted": True, "revision": revision}


@router.delete("/v1/materials/{material_id}/cloud-copy")
async def delete_material_cloud_copy(
    material_id: str,
    payload: RevisionRequest,
    request: Request,
    actor: Actor,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> dict[str, Any]:
    if not idempotency_key:
        raise ServiceError(400, "missing_idempotency_key", "缺少 Idempotency-Key")
    services = container(request)
    result = await services.materials.delete_cloud_copy(
        user_id=actor.user_id,
        device_id=actor.device_id,
        material_id=material_id,
        expected_revision=payload.revision,
        idempotency_key=idempotency_key,
    )
    await services.repository.record_audit(
        actor.user_id,
        device_id=actor.device_id,
        action="material.cloud_copy.delete",
        resource_type="material",
        resource_id=material_id,
        result="success",
        request_id=request_id(request),
        details={"revision": result["revision"]},
    )
    return result


@router.post("/v1/materials/{material_id}/publications", status_code=201)
async def create_material_publication(
    material_id: str,
    payload: PublicationCreateRequest,
    request: Request,
    actor: Actor,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> dict[str, Any]:
    if not idempotency_key:
        raise ServiceError(400, "missing_idempotency_key", "缺少 Idempotency-Key")
    services = container(request)
    result = await services.materials.create_publication(
        user_id=actor.user_id,
        material_id=material_id,
        idempotency_key=idempotency_key,
        payload=payload,
    )
    await services.repository.record_audit(
        actor.user_id,
        device_id=actor.device_id,
        action="material.publication.submit",
        resource_type="publication",
        resource_id=result["publication_id"],
        result="success",
        request_id=request_id(request),
        details={"material_id": material_id, "revision": result["revision"]},
    )
    return result


@router.post("/v1/moderation/publications/{publication_id}/review")
async def review_material_publication(
    publication_id: str,
    payload: PublicationReviewRequest,
    request: Request,
    actor: Actor,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> dict[str, Any]:
    if not idempotency_key:
        raise ServiceError(400, "missing_idempotency_key", "缺少 Idempotency-Key")
    services = container(request)
    result = await services.materials.review_publication(
        actor_id=actor.user_id,
        actor_role=actor.role,
        publication_id=publication_id,
        idempotency_key=idempotency_key,
        payload=payload,
    )
    await services.repository.record_audit(
        actor.user_id,
        device_id=actor.device_id,
        action="material.publication.review",
        resource_type="publication",
        resource_id=publication_id,
        result="success",
        request_id=request_id(request),
        details={"decision": payload.decision, "revision": result["revision"]},
    )
    return result


@router.get("/v1/public-materials")
async def list_public_materials(
    request: Request,
    actor: Actor,
    limit: int = Query(default=50, ge=1, le=100),
    cursor: str | None = None,
    keyword: str | None = Query(default=None, max_length=255),
) -> dict[str, Any]:
    items, next_cursor = await container(request).repository.list_public_materials(
        actor.user_id,
        limit=limit,
        cursor=cursor,
        keyword=keyword.strip() if keyword and keyword.strip() else None,
    )
    return {"items": items, "next_cursor": next_cursor, "has_more": bool(next_cursor)}


@router.post("/v1/public-materials/{publication_id}/reports", status_code=201)
async def create_publication_report(
    publication_id: str,
    payload: PublicationReportCreateRequest,
    request: Request,
    actor: Actor,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> dict[str, Any]:
    if not idempotency_key:
        raise ServiceError(400, "missing_idempotency_key", "缺少 Idempotency-Key")
    services = container(request)
    result = await services.materials.create_publication_report(
        user_id=actor.user_id,
        publication_id=publication_id,
        idempotency_key=idempotency_key,
        payload=payload,
    )
    await services.repository.record_audit(
        actor.user_id,
        device_id=actor.device_id,
        action="public_material.report",
        resource_type="publication_report",
        resource_id=result["report_id"],
        result="success",
        request_id=request_id(request),
        details={"publication_id": publication_id, "category": payload.category},
    )
    return result


@router.get("/v1/moderation/publication-reports")
async def list_publication_reports(
    request: Request,
    actor: Actor,
    status: str = Query(default="pending"),
    limit: int = Query(default=50, ge=1, le=100),
) -> dict[str, Any]:
    items = await container(request).materials.list_publication_reports(
        actor_id=actor.user_id,
        actor_role=actor.role,
        status=status,
        limit=limit,
    )
    return {"items": items}


@router.post("/v1/moderation/publication-reports/{report_id}/review")
async def review_publication_report(
    report_id: str,
    payload: PublicationReportReviewRequest,
    request: Request,
    actor: Actor,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> dict[str, Any]:
    if not idempotency_key:
        raise ServiceError(400, "missing_idempotency_key", "缺少 Idempotency-Key")
    services = container(request)
    result = await services.materials.review_publication_report(
        actor_id=actor.user_id,
        actor_role=actor.role,
        report_id=report_id,
        idempotency_key=idempotency_key,
        payload=payload,
    )
    await services.repository.record_audit(
        actor.user_id,
        device_id=actor.device_id,
        action="public_material.report.review",
        resource_type="publication_report",
        resource_id=report_id,
        result="success",
        request_id=request_id(request),
        details={"decision": payload.decision, "revision": result["revision"]},
    )
    return result


@router.post("/v1/public-materials/{publication_id}/add")
async def add_public_material(
    publication_id: str,
    payload: PublicMaterialAddRequest,
    request: Request,
    actor: Actor,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> dict[str, Any]:
    if not idempotency_key:
        raise ServiceError(400, "missing_idempotency_key", "缺少 Idempotency-Key")
    services = container(request)
    result = await services.materials.add_public_material(
        user_id=actor.user_id,
        publication_id=publication_id,
        idempotency_key=idempotency_key,
        payload=payload,
    )
    await services.repository.record_audit(
        actor.user_id,
        device_id=actor.device_id,
        action="public_material.add",
        resource_type="publication",
        resource_id=publication_id,
        result="success",
        request_id=request_id(request),
        details={"material_id": result["material_id"], "created": result["created"]},
    )
    return result


@router.delete("/v1/publications/{publication_id}")
async def withdraw_material_publication(
    publication_id: str,
    payload: PublicationWithdrawRequest,
    request: Request,
    actor: Actor,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> dict[str, Any]:
    if not idempotency_key:
        raise ServiceError(400, "missing_idempotency_key", "缺少 Idempotency-Key")
    services = container(request)
    result = await services.materials.withdraw_publication(
        user_id=actor.user_id,
        publication_id=publication_id,
        idempotency_key=idempotency_key,
        payload=payload,
    )
    await services.repository.record_audit(
        actor.user_id,
        device_id=actor.device_id,
        action="material.publication.withdraw",
        resource_type="publication",
        resource_id=publication_id,
        result="success",
        request_id=request_id(request),
        details={"revision": result["revision"]},
    )
    return result


@router.post("/v1/moderation/publications/{publication_id}/status")
async def moderate_material_publication_status(
    publication_id: str,
    payload: PublicationModerationRequest,
    request: Request,
    actor: Actor,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> dict[str, Any]:
    if not idempotency_key:
        raise ServiceError(400, "missing_idempotency_key", "缺少 Idempotency-Key")
    services = container(request)
    result = await services.materials.moderate_publication_status(
        actor_id=actor.user_id,
        actor_role=actor.role,
        publication_id=publication_id,
        idempotency_key=idempotency_key,
        payload=payload,
    )
    await services.repository.record_audit(
        actor.user_id,
        device_id=actor.device_id,
        action="material.publication.moderate",
        resource_type="publication",
        resource_id=publication_id,
        result="success",
        request_id=request_id(request),
        details={
            "action": payload.action,
            "revision": result["revision"],
            "removed_imports": result["removed_imports"],
        },
    )
    return result


@router.post("/v1/sync/batch")
async def sync_batch(
    payload: SyncBatchRequest,
    request: Request,
    actor: Actor,
) -> dict[str, Any]:
    result = await container(request).materials.sync_batch(actor.user_id, payload)
    return result.model_dump(mode="json")


@router.post("/v1/upload-sessions")
async def create_upload_session(
    payload: CreateUploadSessionRequest,
    request: Request,
    response: Response,
    actor: Actor,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> dict[str, Any]:
    if not idempotency_key:
        raise ServiceError(400, "missing_idempotency_key", "创建上传会话必须提供幂等键")
    result = await container(request).materials.create_upload_session(
        user_id=actor.user_id,
        device_id=actor.device_id,
        idempotency_key=idempotency_key,
        payload=payload,
    )
    response.headers["Cache-Control"] = "no-store"
    return result.model_dump(mode="json")


@router.get("/v1/upload-sessions/{session_id}")
async def get_upload_session(session_id: str, request: Request, actor: Actor) -> dict[str, Any]:
    session = await container(request).repository.upload_session_progress(
        actor.user_id, session_id
    )
    completed_parts = [
        {
            "part_number": int(part["part_number"]),
            "size_bytes": int(part["size_bytes"]),
            "etag": part["etag"] or "",
            "checksum": part["checksum_sha256"],
        }
        for part in session["completed_parts"]
    ]
    actions = []
    if session["status"] in {"created", "uploading"}:
        actions = ["resume", "cancel"]
    return {
        "upload_session_id": session["upload_session_id"],
        "status": session["status"],
        "uploaded_bytes": int(session["uploaded_bytes"]),
        "completed_parts": completed_parts,
        "expires_at": session["expires_at"],
        "actions": actions,
    }


@router.post("/v1/upload-sessions/{session_id}/cancel")
async def cancel_upload_session(
    session_id: str,
    request: Request,
    actor: Actor,
) -> dict[str, Any]:
    result = await container(request).materials.cancel_upload(
        user_id=actor.user_id,
        device_id=actor.device_id,
        session_id=session_id,
    )
    await container(request).repository.record_audit(
        actor.user_id,
        device_id=actor.device_id,
        action="upload.cancel",
        resource_type="upload_session",
        resource_id=session_id,
        result="success",
        request_id=request_id(request),
    )
    return result


@router.post("/v1/upload-sessions/{session_id}/resume")
async def resume_upload_session(
    session_id: str,
    request: Request,
    response: Response,
    actor: Actor,
) -> dict[str, Any]:
    result = await container(request).materials.resume_upload(
        user_id=actor.user_id,
        device_id=actor.device_id,
        session_id=session_id,
    )
    response.headers["Cache-Control"] = "no-store"
    await container(request).repository.record_audit(
        actor.user_id,
        device_id=actor.device_id,
        action="upload.resume",
        resource_type="upload_session",
        resource_id=session_id,
        result="success",
        request_id=request_id(request),
        details={"uploaded_bytes": result.uploaded_bytes},
    )
    return result.model_dump(mode="json")


@router.post("/v1/upload-sessions/{session_id}/part-authorizations")
async def part_authorizations(
    session_id: str,
    payload: PartAuthorizationRequest,
    request: Request,
    response: Response,
    actor: Actor,
) -> dict[str, Any]:
    result = await container(request).materials.part_authorizations(
        user_id=actor.user_id,
        device_id=actor.device_id,
        session_id=session_id,
        part_numbers=payload.part_numbers,
    )
    response.headers["Cache-Control"] = "no-store"
    return result.model_dump(mode="json")


@router.post("/v1/upload-sessions/{session_id}/parts/complete")
async def complete_part(
    session_id: str,
    payload: CompletePartRequest,
    request: Request,
    actor: Actor,
) -> dict[str, Any]:
    return await container(request).materials.complete_part(
        user_id=actor.user_id,
        device_id=actor.device_id,
        session_id=session_id,
        payload=payload,
    )


@router.post("/v1/upload-sessions/{session_id}/complete")
async def complete_upload(
    session_id: str,
    request: Request,
    background_tasks: BackgroundTasks,
    actor: Actor,
) -> dict[str, Any]:
    services = container(request)
    result = await services.materials.complete_upload(
        user_id=actor.user_id,
        device_id=actor.device_id,
        session_id=session_id,
    )
    background_tasks.add_task(
        services.materials.resume_upload_verification,
        user_id=actor.user_id,
        session_id=session_id,
    )
    return result.model_dump(mode="json")


@router.post("/v1/materials/{material_id}/download-session")
async def download_session(
    material_id: str,
    request: Request,
    response: Response,
    actor: Actor,
) -> dict[str, Any]:
    result = await container(request).materials.download_session(
        user_id=actor.user_id, material_id=material_id
    )
    await container(request).repository.record_audit(
        actor.user_id,
        device_id=actor.device_id,
        action="material.download_authorize",
        resource_type="material",
        resource_id=material_id,
        result="success",
        request_id=request_id(request),
    )
    response.headers["Cache-Control"] = "no-store"
    return result.model_dump(mode="json")


@router.post("/v1/materials/search/semantic")
async def semantic_search(
    payload: SemanticSearchRequest,
    request: Request,
    actor: Actor,
) -> dict[str, Any]:
    folder_id = None
    if payload.scope:
        folder_id = str(payload.scope.get("folder_id") or "").strip() or None
    results, source = await container(request).vectors.search(
        user_id=actor.user_id,
        query=payload.query.strip(),
        limit=payload.limit,
        folder_id=folder_id,
    )
    return {"results": results, "source": source}


@router.post("/v1/analyses/status-checks")
async def analysis_status_checks(
    payload: AnalysisStatusCheckRequest,
    request: Request,
    actor: Actor,
) -> dict[str, Any]:
    return await analysis_service(request).status_checks(actor.user_id, payload)


@router.post("/v1/materials/{material_id}/analysis-results")
async def submit_client_analysis_result(
    material_id: str,
    payload: ClientAnalysisResultRequest,
    request: Request,
    response: Response,
    actor: Actor,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> dict[str, Any]:
    if not idempotency_key:
        raise ServiceError(400, "missing_idempotency_key", "提交分析结果必须提供幂等键")
    result = await analysis_service(request).submit_client_result(
        user_id=actor.user_id,
        device_id=actor.device_id,
        material_id=material_id,
        idempotency_key=idempotency_key,
        payload=payload,
    )
    await container(request).repository.record_audit(
        actor.user_id,
        device_id=actor.device_id,
        action="material.analysis_result_submit",
        resource_type="material",
        resource_id=material_id,
        result="success",
        request_id=request_id(request),
        details={
            "analysis_id": result["analysis_id"],
            "chunk_count": result["chunk_count"],
            "model_name": payload.model_name,
            "model_version": payload.model_version,
        },
    )
    response.headers["Cache-Control"] = "no-store"
    return result


@router.get("/v1/materials/{material_id}/analysis-results")
async def get_client_analysis_result(
    material_id: str,
    request: Request,
    response: Response,
    actor: Actor,
    limit: int = Query(default=100, ge=1, le=500),
    cursor: str | None = Query(default=None, max_length=512),
) -> dict[str, Any]:
    result = await analysis_service(request).result_page(
        user_id=actor.user_id,
        material_id=material_id,
        limit=limit,
        cursor=cursor,
    )
    if not cursor:
        await container(request).repository.record_audit(
            actor.user_id,
            device_id=actor.device_id,
            action="material.analysis_result_read",
            resource_type="material",
            resource_id=material_id,
            result="success",
            request_id=request_id(request),
            details={"analysis_id": result["analysis_id"]},
        )
    response.headers["Cache-Control"] = "no-store"
    return result


@router.post("/internal/v1/analyses/claim")
async def claim_analysis_jobs(
    payload: AnalysisWorkerClaimRequest,
    request: Request,
    response: Response,
    _worker: Worker,
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "no-store"
    return await analysis_service(request).claim(
        worker_id=payload.worker_id, limit=payload.limit
    )


@router.post("/internal/v1/analyses/{analysis_id}/complete")
async def complete_analysis_job(
    analysis_id: str,
    payload: AnalysisCompleteRequest,
    request: Request,
    response: Response,
    _worker: Worker,
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "no-store"
    return await analysis_service(request).complete(analysis_id, payload)


@router.post("/v1/selections/resolve")
async def resolve_selection(
    payload: SelectionResolveRequest,
    request: Request,
    actor: Actor,
) -> dict[str, Any]:
    return await container(request).materials.resolve_selection(
        user_id=actor.user_id, payload=payload
    )


@router.post("/v1/shot-material-validations")
async def validate_shot_materials(
    payload: ShotMaterialValidationRequest,
    request: Request,
    actor: Actor,
) -> dict[str, Any]:
    return await container(request).materials.validate_shot_materials(
        user_id=actor.user_id, payload=payload
    )


@router.post("/v1/generation-runs", status_code=201)
async def create_generation_run(
    payload: GenerationRunCreateRequest,
    request: Request,
    actor: Actor,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> dict[str, Any]:
    if not idempotency_key:
        raise ServiceError(400, "missing_idempotency_key", "缺少 Idempotency-Key")
    services = container(request)
    result = await services.materials.create_generation_run(
        user_id=actor.user_id,
        device_id=actor.device_id,
        idempotency_key=idempotency_key,
        payload=payload,
    )
    await services.repository.record_audit(
        actor.user_id,
        device_id=actor.device_id,
        action="generation.run.create",
        resource_type="generation_run",
        resource_id=result["run_id"],
        result="success",
        request_id=request_id(request),
        details={
            "task_id": result["task_id"],
            "task_revision": result["task_revision"],
            "manifest_checksum": result["manifest_checksum"],
        },
    )
    return result


@router.get("/v1/generation-runs/{run_id}/material-manifest")
async def get_generation_material_manifest(
    run_id: str,
    request: Request,
    actor: Actor,
) -> dict[str, Any]:
    return await container(request).materials.get_generation_manifest(
        user_id=actor.user_id, run_id=run_id
    )


@router.patch("/v1/generation-runs/{run_id}")
async def update_generation_run(
    run_id: str,
    payload: GenerationRunStatusUpdateRequest,
    request: Request,
    actor: Actor,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> dict[str, Any]:
    if not idempotency_key:
        raise ServiceError(400, "missing_idempotency_key", "缺少 Idempotency-Key")
    services = container(request)
    result = await services.materials.update_generation_run(
        user_id=actor.user_id,
        run_id=run_id,
        idempotency_key=idempotency_key,
        payload=payload,
    )
    await services.repository.record_audit(
        actor.user_id,
        device_id=actor.device_id,
        action="generation.run.status.update",
        resource_type="generation_run",
        resource_id=run_id,
        result="success",
        request_id=request_id(request),
        details={
            "status": result["status"],
            "stage": result["stage"],
            "progress": result["progress"],
            "revision": result["revision"],
        },
    )
    return result


@router.get("/v1/generation-runs/{run_id}")
async def get_generation_run(
    run_id: str,
    request: Request,
    actor: Actor,
) -> dict[str, Any]:
    return await container(request).materials.get_generation_run(
        user_id=actor.user_id, run_id=run_id
    )


@router.post("/v1/generation/material-snapshots")
async def freeze_generation_snapshot(
    payload: GenerationSnapshotRequest,
    request: Request,
    actor: Actor,
) -> dict[str, Any]:
    result = await container(request).materials.freeze_generation_snapshot(
        user_id=actor.user_id, payload=payload
    )
    await container(request).repository.record_audit(
        actor.user_id,
        device_id=actor.device_id,
        action="generation.snapshot.freeze",
        resource_type="generation_run",
        resource_id=payload.run_id,
        result="success",
        request_id=request_id(request),
        details={"shot_id": payload.shot_id, "checksum": result["checksum"]},
    )
    return result


@router.get("/v1/sync/changes")
async def sync_changes(
    request: Request,
    actor: Actor,
    cursor: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
) -> dict[str, Any]:
    changes, more_cursor = await container(request).repository.list_sync_changes(
        actor.user_id, after_sequence=cursor, limit=limit
    )
    next_cursor = int(changes[-1]["sequence_id"]) if changes else cursor
    return {
        "changes": changes,
        "next_cursor": next_cursor,
        "has_more": more_cursor is not None,
    }
