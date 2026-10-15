from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

import httpx

from .errors import ServiceError


DEVICE_PATTERN = re.compile(r"^dev_[a-f0-9]{32}$")


@dataclass(frozen=True)
class Principal:
    user_id: str
    device_id: str
    role: str


class AuthResolver:
    def __init__(self, auth_me_url: str, client: httpx.AsyncClient) -> None:
        self.auth_me_url = auth_me_url
        self.client = client

    async def resolve(
        self,
        authorization: str | None,
        device_id: str | None,
    ) -> Principal:
        if not authorization or not authorization.startswith("Bearer "):
            raise ServiceError(401, "missing_authorization", "需要登录后才能访问云素材")
        token = authorization[7:].strip()
        if not token:
            raise ServiceError(401, "missing_authorization", "需要登录后才能访问云素材")
        clean_device = (device_id or "").strip()
        if not DEVICE_PATTERN.fullmatch(clean_device):
            raise ServiceError(400, "invalid_device_id", "设备标识格式不正确")
        try:
            response = await self.client.get(
                self.auth_me_url,
                headers={"Authorization": f"Bearer {token}"},
                timeout=12,
            )
        except httpx.HTTPError as exc:
            raise ServiceError(
                503,
                "auth_service_unavailable",
                "登录服务暂时不可用",
                retryable=True,
                action="retry",
            ) from exc
        if response.status_code in {401, 403}:
            raise ServiceError(401, "token_expired", "登录已失效，请重新登录")
        if response.status_code >= 400:
            raise ServiceError(
                503,
                "auth_service_unavailable",
                "登录服务暂时不可用",
                retryable=True,
                action="retry",
            )
        try:
            payload: dict[str, Any] = response.json()
        except ValueError as exc:
            raise ServiceError(503, "auth_response_invalid", "登录服务响应格式异常") from exc
        nested = payload.get("data") if isinstance(payload.get("data"), dict) else payload
        user = nested.get("user") if isinstance(nested.get("user"), dict) else nested
        user_id = str(user.get("id") or "").strip()
        if not user_id or len(user_id) > 128:
            raise ServiceError(401, "token_subject_missing", "登录凭证缺少用户身份")
        return Principal(
            user_id=user_id,
            device_id=clean_device,
            role=str(user.get("role") or "user").strip().lower(),
        )
