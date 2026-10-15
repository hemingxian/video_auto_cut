from __future__ import annotations

import hashlib
from datetime import UTC, datetime
from typing import Any

import httpx

from .errors import ServiceError


def _datetime(value: Any) -> datetime:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
    except ValueError as exc:
        raise ServiceError(503, "upload_service_invalid", "上传服务返回了无效时间") from exc


class UploadGateway:
    def __init__(
        self,
        base_url: str,
        service_token: str,
        client: httpx.AsyncClient,
    ) -> None:
        self.base_url = base_url
        self.service_token = service_token
        self.client = client

    def _headers(self, user_id: str, idempotency_key: str | None = None) -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self.service_token}",
            "X-Actor-Id": user_id,
        }
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        return headers

    async def _json(
        self,
        method: str,
        path: str,
        user_id: str,
        *,
        body: dict[str, Any] | None = None,
        idempotency_key: str | None = None,
        timeout: float = 30,
    ) -> dict[str, Any]:
        try:
            response = await self.client.request(
                method,
                f"{self.base_url}{path}",
                headers=self._headers(user_id, idempotency_key),
                json=body,
                timeout=timeout,
            )
        except httpx.HTTPError as exc:
            raise ServiceError(
                503,
                "storage_unavailable",
                "云存储服务暂时不可用",
                retryable=True,
                action="retry",
            ) from exc
        if response.status_code >= 400:
            try:
                error = response.json().get("error", {})
                message = str(error.get("message") or "云存储服务请求失败")
            except ValueError:
                message = "云存储服务请求失败"
            raise ServiceError(
                503 if response.status_code >= 500 else response.status_code,
                "storage_request_failed",
                message,
                retryable=response.status_code >= 500,
                action="retry" if response.status_code >= 500 else None,
            )
        try:
            return response.json()
        except ValueError as exc:
            raise ServiceError(503, "upload_service_invalid", "云存储服务响应格式异常") from exc

    async def create(
        self,
        *,
        user_id: str,
        business_session_id: str,
        asset_id: str,
        asset_version: int,
        filename: str,
        mime_type: str,
        size_bytes: int,
        source_sha256: str,
    ) -> dict[str, Any]:
        return await self._json(
            "POST",
            "/v1/upload-sessions",
            user_id,
            idempotency_key=business_session_id,
            body={
                "scope": "private",
                "filename": filename,
                "object_path": f"assets/{asset_id}/v{asset_version}/{business_session_id}/{filename}",
                "content_type": mime_type,
                "size_bytes": size_bytes,
                "metadata": {
                    "business_session_id": business_session_id,
                    "asset_id": asset_id,
                    "asset_version": str(asset_version),
                    "source_sha256": source_sha256,
                },
            },
        )

    async def complete(self, user_id: str, internal_session_id: str) -> dict[str, Any]:
        return await self._json(
            "POST",
            f"/v1/upload-sessions/{internal_session_id}/complete",
            user_id,
            timeout=90,
        )

    async def resume(self, user_id: str, internal_session_id: str) -> dict[str, Any]:
        return await self._json(
            "POST",
            f"/v1/upload-sessions/{internal_session_id}/resume",
            user_id,
        )

    async def create_multipart(
        self,
        *,
        user_id: str,
        business_session_id: str,
        asset_id: str,
        asset_version: int,
        filename: str,
        mime_type: str,
        size_bytes: int,
        source_sha256: str,
    ) -> dict[str, Any]:
        return await self._json(
            "POST",
            "/v1/multipart-sessions",
            user_id,
            idempotency_key=business_session_id,
            body={
                "scope": "private",
                "filename": filename,
                "object_path": f"assets/{asset_id}/v{asset_version}/{business_session_id}/{filename}",
                "content_type": mime_type,
                "size_bytes": size_bytes,
                "metadata": {
                    "business_session_id": business_session_id,
                    "asset_id": asset_id,
                    "asset_version": str(asset_version),
                    "source_sha256": source_sha256,
                },
            },
        )

    async def multipart_part_authorization(
        self,
        user_id: str,
        internal_session_id: str,
        part_number: int,
        size_bytes: int,
    ) -> dict[str, Any]:
        return await self._json(
            "POST",
            f"/v1/multipart-sessions/{internal_session_id}/part-authorization",
            user_id,
            body={"part_number": part_number, "size_bytes": size_bytes},
        )

    async def resume_multipart(
        self, user_id: str, internal_session_id: str
    ) -> dict[str, Any]:
        return await self._json(
            "POST",
            f"/v1/multipart-sessions/{internal_session_id}/resume",
            user_id,
        )

    async def complete_multipart_part(
        self,
        user_id: str,
        internal_session_id: str,
        part_number: int,
        size_bytes: int,
        etag: str,
    ) -> dict[str, Any]:
        return await self._json(
            "POST",
            f"/v1/multipart-sessions/{internal_session_id}/parts/complete",
            user_id,
            body={"part_number": part_number, "size_bytes": size_bytes, "etag": etag},
        )

    async def complete_multipart(
        self, user_id: str, internal_session_id: str
    ) -> dict[str, Any]:
        return await self._json(
            "POST",
            f"/v1/multipart-sessions/{internal_session_id}/complete",
            user_id,
            timeout=180,
        )

    async def abort_multipart(
        self, user_id: str, internal_session_id: str
    ) -> dict[str, Any]:
        return await self._json(
            "POST",
            f"/v1/multipart-sessions/{internal_session_id}/abort",
            user_id,
        )

    async def download_authorization(
        self, user_id: str, internal_session_id: str
    ) -> dict[str, Any]:
        return await self._json(
            "POST",
            f"/v1/upload-sessions/{internal_session_id}/download-url",
            user_id,
        )

    async def delete_cloud_copy(
        self,
        user_id: str,
        internal_session_id: str,
        idempotency_key: str,
    ) -> dict[str, Any]:
        return await self._json(
            "DELETE",
            f"/v1/upload-sessions/{internal_session_id}",
            user_id,
            idempotency_key=idempotency_key,
            timeout=90,
        )

    async def verify_sha256(
        self,
        user_id: str,
        internal_session_id: str,
        expected_sha256: str,
        expected_size: int,
    ) -> None:
        authorization = await self.download_authorization(user_id, internal_session_id)
        url = str(authorization.get("url") or "")
        if not url.startswith("https://"):
            raise ServiceError(503, "download_authorization_invalid", "云存储下载授权无效")
        digest = hashlib.sha256()
        size = 0
        try:
            async with self.client.stream("GET", url, timeout=300) as response:
                if response.status_code >= 400:
                    raise ServiceError(503, "storage_verify_failed", "云端文件读取失败")
                async for chunk in response.aiter_bytes(4 * 1024 * 1024):
                    size += len(chunk)
                    if size > expected_size:
                        raise ServiceError(422, "checksum_mismatch", "云端文件大小校验失败")
                    digest.update(chunk)
        except httpx.HTTPError as exc:
            raise ServiceError(
                503,
                "storage_unavailable",
                "云存储校验暂时不可用",
                retryable=True,
            ) from exc
        if size != expected_size or digest.hexdigest() != expected_sha256:
            raise ServiceError(422, "checksum_mismatch", "云端文件 SHA-256 校验失败")

    @staticmethod
    def public_authorization(internal: dict[str, Any]) -> dict[str, Any]:
        url = str(internal.get("upload_url") or "")
        if not url.startswith("https://"):
            raise ServiceError(503, "upload_authorization_invalid", "云存储上传授权无效")
        return {
            "url": url,
            "headers": {
                str(key): str(value)
                for key, value in dict(internal.get("required_headers") or {}).items()
            },
            "expires_at": _datetime(internal.get("expires_at")),
        }

    @staticmethod
    def public_part_authorization(internal: dict[str, Any]) -> dict[str, Any]:
        url = str(internal.get("url") or "")
        if not url.startswith("https://"):
            raise ServiceError(503, "upload_authorization_invalid", "云存储分片授权无效")
        return {
            "part_number": int(internal.get("part_number") or 0),
            "url": url,
            "headers": {
                str(key): str(value)
                for key, value in dict(internal.get("required_headers") or {}).items()
            },
            "expires_at": _datetime(internal.get("expires_at")),
        }


__all__ = ["UploadGateway", "_datetime"]
