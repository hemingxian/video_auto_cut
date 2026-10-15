from __future__ import annotations

import math
from typing import Any

import httpx

from .errors import ServiceError
from .repository import MaterialRepository


class VectorSearchService:
    def __init__(
        self,
        *,
        repository: MaterialRepository,
        client: httpx.AsyncClient,
        embedding_url: str,
        embedding_token: str,
        embedding_model: str,
        dimension: int,
        cloud_search_url: str,
        cloud_token: str,
        cloud_upsert_url: str = "",
        vector_backend: str = "pgvector",
    ) -> None:
        self.repository = repository
        self.client = client
        self.embedding_url = embedding_url
        self.embedding_token = embedding_token
        self.embedding_model = embedding_model
        self.dimension = dimension
        self.cloud_search_url = cloud_search_url
        self.cloud_token = cloud_token
        self.cloud_upsert_url = cloud_upsert_url
        self.vector_backend = vector_backend

    @property
    def uses_pgvector_index(self) -> bool:
        return self.vector_backend == "pgvector"

    @property
    def cloud_upsert_configured(self) -> bool:
        return bool(self.cloud_upsert_url and self.cloud_token)

    async def upsert_analysis(self, payload: dict[str, Any]) -> None:
        if not self.cloud_upsert_configured:
            raise ServiceError(503, "vector_upsert_unavailable", "云向量写入尚未配置")
        chunks = payload.get("chunks") or []
        items = [
            {
                "id": f"{payload['analysis_id']}:{chunk['chunk_id']}",
                "vector": chunk["embedding"],
                "metadata": {
                    "analysis_id": payload["analysis_id"],
                    "asset_id": payload["asset_id"],
                    "asset_version": payload["asset_version"],
                    "analysis_profile_id": payload["analysis_profile_id"],
                    "chunk_id": chunk["chunk_id"],
                    "start_ms": chunk["start_ms"],
                    "end_ms": chunk["end_ms"],
                    "caption": chunk["caption"],
                },
            }
            for chunk in chunks
        ]
        try:
            response = await self.client.post(
                self.cloud_upsert_url,
                headers={"Authorization": f"Bearer {self.cloud_token}"},
                json={"dimension": self.dimension, "items": items},
                timeout=60,
            )
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise ServiceError(
                503,
                "vector_upsert_unavailable",
                "云向量写入暂时不可用",
                retryable=True,
            ) from exc

    async def embed(self, query: str) -> list[float]:
        if not self.embedding_url or not self.embedding_token:
            raise ServiceError(
                503,
                "embedding_service_unavailable",
                "语义向量服务尚未配置",
                retryable=True,
            )
        try:
            is_dashscope_multimodal = "multimodal-embedding" in self.embedding_url
            request_body = (
                {
                    "model": self.embedding_model,
                    "input": {"contents": [{"text": query}]},
                    "parameters": {"dimension": self.dimension},
                }
                if is_dashscope_multimodal
                else {"model": self.embedding_model, "input": query}
            )
            response = await self.client.post(
                self.embedding_url,
                headers={"Authorization": f"Bearer {self.embedding_token}"},
                json=request_body,
                timeout=30,
            )
            response.raise_for_status()
            payload = response.json()
            if is_dashscope_multimodal:
                embedding = payload["output"]["embeddings"][0]["embedding"]
            else:
                embedding = payload["data"][0]["embedding"]
        except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError) as exc:
            raise ServiceError(
                503,
                "embedding_service_unavailable",
                "语义向量服务暂时不可用",
                retryable=True,
                action="retry",
            ) from exc
        if (
            not isinstance(embedding, list)
            or len(embedding) != self.dimension
            or any(not isinstance(value, (int, float)) or not math.isfinite(value) for value in embedding)
        ):
            raise ServiceError(503, "embedding_response_invalid", "语义向量维度或数值无效")
        return [float(value) for value in embedding]

    async def _cloud_search(
        self,
        embedding: list[float],
        allowed_asset_ids: list[str],
        limit: int,
    ) -> list[dict[str, Any]]:
        if not self.cloud_search_url or not self.cloud_token:
            raise ServiceError(503, "vector_search_unavailable", "云向量检索尚未配置")
        try:
            response = await self.client.post(
                self.cloud_search_url,
                headers={"Authorization": f"Bearer {self.cloud_token}"},
                json={
                    "embedding": embedding,
                    "dimension": self.dimension,
                    "allowed_asset_ids": allowed_asset_ids,
                    "limit": limit,
                },
                timeout=15,
            )
            response.raise_for_status()
            payload = response.json()
            values = payload.get("results") or payload.get("items") or []
            if not isinstance(values, list):
                raise ValueError("invalid vector results")
            return [item for item in values if isinstance(item, dict)]
        except (httpx.HTTPError, ValueError, TypeError) as exc:
            raise ServiceError(
                503,
                "vector_search_unavailable",
                "云向量检索暂时不可用",
                retryable=True,
            ) from exc

    async def search(
        self,
        *,
        user_id: str,
        query: str,
        limit: int,
        folder_id: str | None = None,
    ) -> tuple[list[dict[str, Any]], str]:
        embedding = await self.embed(query)
        allowed = await self.repository.allowed_asset_ids(user_id, folder_id)
        if not allowed:
            return [], "pgvector" if self.uses_pgvector_index else "cloud"
        if self.uses_pgvector_index:
            raw = await self.repository.search_pgvector(
                user_id, embedding, limit, folder_id
            )
            source = "pgvector"
        else:
            try:
                raw = await self._cloud_search(embedding, allowed, limit)
                source = "cloud"
            except ServiceError:
                raw = await self.repository.search_pgvector(
                    user_id, embedding, limit, folder_id
                )
                source = "pgvector_fallback"
        asset_ids = [str(item.get("asset_id") or "") for item in raw]
        permitted = await self.repository.material_ids_for_assets(user_id, asset_ids)
        results: list[dict[str, Any]] = []
        for index, item in enumerate(raw):
            asset_id = str(item.get("asset_id") or "")
            material_id = str(permitted.get(asset_id) or "")
            if not material_id:
                continue
            results.append(
                {
                    "rank": index + 1,
                    "score": float(item.get("score") or 0),
                    "material_id": material_id,
                    "asset_id": asset_id,
                    "start": item.get("start") or item.get("start_ms") or "",
                    "end": item.get("end") or item.get("end_ms") or "",
                    "text": item.get("text") or item.get("caption") or "",
                }
            )
        return results, source
