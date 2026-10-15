from __future__ import annotations

import hashlib
import json
from typing import Any

from .config import Settings
from .errors import ServiceError
from .models import (
    AnalysisCompleteRequest,
    AnalysisStatusCheckRequest,
    ClientAnalysisResultRequest,
)
from .repository import MaterialRepository
from .upload_gateway import UploadGateway, _datetime
from .vector_search import VectorSearchService


class AnalysisService:
    def __init__(
        self,
        *,
        settings: Settings,
        repository: MaterialRepository,
        upload_gateway: UploadGateway,
        vectors: VectorSearchService,
    ) -> None:
        self.settings = settings
        self.repository = repository
        self.upload_gateway = upload_gateway
        self.vectors = vectors

    async def status_checks(
        self, user_id: str, payload: AnalysisStatusCheckRequest
    ) -> dict[str, Any]:
        if len(set(payload.material_ids)) != len(payload.material_ids):
            raise ServiceError(422, "duplicate_material", "分析检查包含重复素材")
        results = []
        for material_id in payload.material_ids:
            if not payload.trigger_missing:
                material = await self.repository.get_material(user_id, material_id)
                results.append(
                    {
                        "material_id": material_id,
                        "analysis_status": material["analysis_status"],
                        "vector_sync_status": material["vector_sync_status"],
                    }
                )
                continue
            results.append(
                await self.repository.ensure_analysis(
                    user_id,
                    material_id,
                    profile_id=self.settings.analysis_profile_id,
                    model_name=self.settings.analysis_model,
                    dimension=self.settings.vector_dimension,
                )
            )
        return {
            "profile_id": self.settings.analysis_profile_id,
            "dimension": self.settings.vector_dimension,
            "items": results,
        }

    async def claim(self, *, worker_id: str, limit: int) -> dict[str, Any]:
        claimed = await self.repository.claim_analyses(worker_id=worker_id, limit=limit)
        jobs = []
        for analysis in claimed:
            owner_id = str(analysis["requested_by_owner_id"])
            material_id = str(analysis["requested_material_id"])
            try:
                material = await self.repository.storage_session_for_material(
                    owner_id, material_id
                )
                authorization = await self.upload_gateway.download_authorization(
                    owner_id, material["storage_session_id"]
                )
                url = str(authorization.get("url") or "")
                if not url.startswith("https://"):
                    raise ServiceError(503, "download_authorization_invalid", "分析下载授权无效")
                jobs.append(
                    {
                        "analysis_id": analysis["analysis_id"],
                        "asset_id": analysis["asset_id"],
                        "asset_version": int(analysis["asset_version"]),
                        "profile_id": analysis["analysis_profile_id"],
                        "model_name": analysis["model_name"],
                        "dimension": int(analysis["dimension"]),
                        "source": {
                            "url": url,
                            "expires_at": _datetime(authorization.get("expires_at")),
                            "file_size_bytes": int(material["source_size"]),
                            "source_sha256": material["source_sha256"],
                            "mime_type": material["mime_type"],
                        },
                    }
                )
            except ServiceError:
                # The lease expires and becomes claimable again; no unsafe URL is returned.
                continue
        return {"jobs": jobs}

    async def complete(
        self, analysis_id: str, payload: AnalysisCompleteRequest
    ) -> dict[str, Any]:
        chunk_ids = [chunk.chunk_id for chunk in payload.chunks]
        if len(set(chunk_ids)) != len(chunk_ids):
            raise ServiceError(422, "duplicate_chunk", "分析结果包含重复 chunk_id")
        await self.repository.complete_analysis(
            analysis_id=analysis_id,
            worker_id=payload.worker_id,
            chunks=[chunk.model_dump(mode="python") for chunk in payload.chunks],
        )
        cloud_synced = await self._sync_analysis_vector(analysis_id)
        return {
            "analysis_id": analysis_id,
            "analysis_status": "completed",
            "chunk_count": len(payload.chunks),
            "pgvector_status": "completed",
            "cloud_vector_status": "completed" if cloud_synced else "pending",
        }

    async def submit_client_result(
        self,
        *,
        user_id: str,
        device_id: str,
        material_id: str,
        idempotency_key: str,
        payload: ClientAnalysisResultRequest,
    ) -> dict[str, Any]:
        if not 8 <= len(idempotency_key) <= 128:
            raise ServiceError(400, "invalid_idempotency_key", "幂等键长度必须为8到128个字符")
        if payload.dimension != self.settings.vector_dimension:
            raise ServiceError(
                422,
                "vector_dimension_mismatch",
                "分析结果向量维度与素材库配置不一致",
                details={"expected": self.settings.vector_dimension},
            )
        chunk_ids = [chunk.chunk_id for chunk in payload.chunks]
        if len(set(chunk_ids)) != len(chunk_ids):
            raise ServiceError(422, "duplicate_chunk", "分析结果包含重复 chunk_id")

        request_body = payload.model_dump(mode="json")
        request_hash = hashlib.sha256(
            json.dumps(
                {"material_id": material_id, "payload": request_body},
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()
        operation = f"submit_client_analysis:{material_id}"
        stored = await self.repository.idempotency_get(
            user_id, operation, idempotency_key, request_hash
        )
        if stored:
            result = stored[1]
            if result.get("cloud_vector_status") != "completed":
                if await self._sync_analysis_vector(str(result.get("analysis_id") or "")):
                    result = {**result, "cloud_vector_status": "completed"}
            return result

        analysis_id = await self.repository.submit_client_analysis(
            user_id=user_id,
            device_id=device_id,
            material_id=material_id,
            payload=payload,
        )
        cloud_synced = await self._sync_analysis_vector(analysis_id)
        result = {
            "material_id": material_id,
            "analysis_id": analysis_id,
            "analysis_status": "completed",
            "chunk_count": len(payload.chunks),
            "pgvector_status": "completed",
            "cloud_vector_status": "completed" if cloud_synced else "pending",
        }
        await self.repository.idempotency_save(
            user_id,
            operation,
            idempotency_key,
            request_hash,
            200,
            result,
        )
        return result

    async def result_page(
        self,
        *,
        user_id: str,
        material_id: str,
        limit: int,
        cursor: str | None,
    ) -> dict[str, Any]:
        return await self.repository.material_analysis_page(
            user_id,
            material_id,
            limit=limit,
            cursor=cursor,
        )

    async def sync_vector_outbox_once(self, limit: int = 10) -> bool:
        analysis_ids = await self.repository.claim_vector_outbox(limit)
        all_completed = True
        for analysis_id in analysis_ids:
            completed = await self._sync_analysis_vector(analysis_id)
            all_completed = completed and all_completed
        return bool(analysis_ids) and all_completed

    async def _sync_analysis_vector(self, analysis_id: str) -> bool:
        if not analysis_id:
            return False
        try:
            if self.vectors.uses_pgvector_index:
                await self.repository.mark_pgvector_index_ready(analysis_id)
            else:
                payload = await self.repository.vector_payload(analysis_id)
                await self.vectors.upsert_analysis(payload)
                await self.repository.mark_vector_outbox(analysis_id, completed=True)
            return True
        except Exception as error:
            await self.repository.mark_vector_outbox(
                analysis_id,
                completed=False,
                error=str(error) or "cloud vector sync failed",
            )
            return False


__all__ = ["AnalysisService"]
