from __future__ import annotations

import base64
import json
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import Any, AsyncIterator

from psycopg.errors import InsufficientPrivilege, UniqueViolation
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from .errors import ServiceError
from .analysis_provenance import provenance_config
from .models import ClientAnalysisResultRequest, FolderSyncItem, MaterialSyncItem


_FOLDER_NAME_CONSTRAINT = "material_folder_owner_id_parent_folder_id_name_key_key"


def _folder_write_error(error: InsufficientPrivilege | UniqueViolation) -> ServiceError | None:
    if isinstance(error, InsufficientPrivilege):
        return ServiceError(
            403,
            "folder_access_denied",
            "文件夹归属或访问权限与当前账号不符，请刷新素材库后重试",
            action="refresh",
        )
    if error.diag.constraint_name == _FOLDER_NAME_CONSTRAINT:
        return ServiceError(409, "folder_name_conflict", "同级文件夹名称已存在")
    return None


def _json_default(value: Any) -> str:
    if isinstance(value, datetime):
        normalized = value if value.tzinfo is not None else value.replace(tzinfo=UTC)
        return normalized.astimezone(UTC).isoformat()
    raise TypeError(f"Object of type {value.__class__.__name__} is not JSON serializable")


def _json_response_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, default=_json_default)


def _cursor_encode(updated_at: datetime, material_id: str) -> str:
    payload = json.dumps(
        [updated_at.astimezone(UTC).isoformat(), material_id], separators=(",", ":")
    ).encode()
    return base64.urlsafe_b64encode(payload).decode().rstrip("=")


def _cursor_decode(value: str | None) -> tuple[datetime, str] | None:
    if not value:
        return None
    try:
        padding = "=" * (-len(value) % 4)
        raw = json.loads(base64.urlsafe_b64decode(value + padding))
        return datetime.fromisoformat(raw[0]), str(raw[1])
    except (ValueError, TypeError, IndexError, json.JSONDecodeError) as exc:
        raise ServiceError(400, "invalid_cursor", "分页游标无效") from exc


def _analysis_cursor_encode(start_ms: int, chunk_id: str) -> str:
    payload = json.dumps([start_ms, chunk_id], separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(payload).decode().rstrip("=")


def _analysis_cursor_decode(value: str | None) -> tuple[int, str] | None:
    if not value:
        return None
    try:
        padding = "=" * (-len(value) % 4)
        raw = json.loads(base64.urlsafe_b64decode(value + padding))
        start_ms, chunk_id = int(raw[0]), str(raw[1])
        if start_ms < 0 or not chunk_id:
            raise ValueError("invalid analysis cursor")
        return start_ms, chunk_id
    except (ValueError, TypeError, IndexError, json.JSONDecodeError) as exc:
        raise ServiceError(400, "invalid_cursor", "分析结果分页游标无效") from exc


class MaterialRepository:
    def __init__(self, database_url: str) -> None:
        self.pool = AsyncConnectionPool(
            conninfo=database_url,
            min_size=1,
            max_size=10,
            open=False,
            kwargs={"row_factory": dict_row},
        )

    async def open(self) -> None:
        await self.pool.open()

    async def close(self) -> None:
        await self.pool.close()

    @asynccontextmanager
    async def connection(self, user_id: str, role: str = "user") -> AsyncIterator[Any]:
        async with self.pool.connection() as connection:
            async with connection.transaction():
                await connection.execute(
                    "SELECT set_config('app.user_id', %s, true)", (user_id,)
                )
                await connection.execute(
                    "SELECT set_config('app.actor_role', %s, true)", (role,)
                )
                yield connection

    @asynccontextmanager
    async def maintenance_connection(self) -> AsyncIterator[Any]:
        async with self.pool.connection() as connection:
            async with connection.transaction():
                yield connection

    async def ping(self) -> None:
        async with self.pool.connection() as connection:
            await connection.execute("SELECT 1")

    async def register_device(self, user_id: str, device_id: str) -> None:
        async with self.connection(user_id) as connection:
            await connection.execute(
                """
                INSERT INTO app_user_device(owner_id, device_id)
                VALUES (%s, %s)
                ON CONFLICT(owner_id, device_id) DO UPDATE
                SET last_seen_at = now()
                WHERE app_user_device.revoked_at IS NULL
                """,
                (user_id, device_id),
            )
            row = await (
                await connection.execute(
                    "SELECT revoked_at FROM app_user_device WHERE owner_id=%s AND device_id=%s",
                    (user_id, device_id),
                )
            ).fetchone()
            if row and row["revoked_at"] is not None:
                raise ServiceError(403, "device_revoked", "当前设备已被撤销")

    async def list_devices(self, user_id: str) -> list[dict[str, Any]]:
        async with self.connection(user_id) as connection:
            rows = await (
                await connection.execute(
                    """
                    SELECT device_id, first_seen_at, last_seen_at, revoked_at
                    FROM app_user_device
                    WHERE owner_id=%s
                    ORDER BY last_seen_at DESC, device_id
                    """,
                    (user_id,),
                )
            ).fetchall()
        return [dict(row) for row in rows]

    async def revoke_device(self, user_id: str, device_id: str) -> None:
        async with self.connection(user_id) as connection:
            row = await (
                await connection.execute(
                    """
                    UPDATE app_user_device
                    SET revoked_at=coalesce(revoked_at, now()), last_seen_at=now()
                    WHERE owner_id=%s AND device_id=%s
                    RETURNING device_id
                    """,
                    (user_id, device_id),
                )
            ).fetchone()
        if not row:
            raise ServiceError(404, "device_not_found", "设备不存在")

    async def record_audit(
        self,
        user_id: str,
        *,
        device_id: str,
        action: str,
        resource_type: str,
        resource_id: str | None,
        result: str,
        request_id: str,
        details: dict[str, Any] | None = None,
    ) -> None:
        async with self.connection(user_id) as connection:
            await connection.execute(
                """
                INSERT INTO audit_log(
                    actor_id, device_id, action, resource_type, resource_id,
                    result, request_id, details
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s::jsonb)
                """,
                (
                    user_id,
                    device_id,
                    action,
                    resource_type,
                    resource_id,
                    result,
                    request_id,
                    json.dumps(details or {}, ensure_ascii=False),
                ),
            )

    async def sync_folder(self, user_id: str, item: FolderSyncItem) -> int:
        async with self.connection(user_id) as connection:
            if item.parent_folder_id:
                parent = await (
                    await connection.execute(
                        "SELECT folder_id FROM material_folder WHERE folder_id=%s AND deleted_at IS NULL",
                        (item.parent_folder_id,),
                    )
                ).fetchone()
                if not parent:
                    raise ServiceError(422, "parent_folder_missing", "父文件夹不存在")
            existing = await (
                await connection.execute(
                    """
                    SELECT revision, name, parent_folder_id, deleted_at
                    FROM material_folder WHERE folder_id=%s
                    FOR UPDATE
                    """,
                    (item.folder_id,),
                )
            ).fetchone()
            if existing:
                current_revision = int(existing["revision"])
                same_content = (
                    existing["name"] == item.name
                    and existing["parent_folder_id"] == item.parent_folder_id
                    and existing["deleted_at"] is None
                )
                if same_content and item.revision <= current_revision:
                    return current_revision
                if existing["deleted_at"] is not None:
                    raise ServiceError(409, "entity_deleted", "文件夹已在其他设备删除")
                if item.revision != current_revision + 1:
                    raise ServiceError(
                        409,
                        "revision_conflict",
                        "文件夹已在其他设备修改",
                        action="refresh",
                        details={"current_revision": current_revision},
                    )
            revision = item.revision
            try:
                row = await (
                    await connection.execute(
                        """
                        INSERT INTO material_folder(
                            folder_id, owner_id, parent_folder_id, name, name_key, revision
                        ) VALUES (%s, %s, %s, %s, lower(%s), %s)
                        ON CONFLICT(folder_id) DO UPDATE SET
                            parent_folder_id=excluded.parent_folder_id,
                            name=excluded.name,
                            name_key=excluded.name_key,
                            revision=excluded.revision,
                            updated_at=now(),
                            deleted_at=NULL
                        RETURNING revision
                        """,
                        (
                            item.folder_id,
                            user_id,
                            item.parent_folder_id,
                            item.name,
                            item.name,
                            revision,
                        ),
                    )
                ).fetchone()
            except (InsufficientPrivilege, UniqueViolation) as exc:
                mapped_error = _folder_write_error(exc)
                if mapped_error is not None:
                    raise mapped_error from exc
                raise
            await connection.execute(
                """
                INSERT INTO sync_change(owner_id, entity_type, entity_id, operation, revision)
                VALUES (%s, 'folder', %s, 'upsert', %s)
                """,
                (user_id, item.folder_id, int(row["revision"])),
            )
            return int(row["revision"])

    async def sync_material(self, user_id: str, item: MaterialSyncItem) -> int:
        async with self.connection(user_id) as connection:
            folder = await (
                await connection.execute(
                    "SELECT folder_id FROM material_folder WHERE folder_id=%s AND deleted_at IS NULL",
                    (item.folder_id,),
                )
            ).fetchone()
            if not folder:
                raise ServiceError(422, "folder_not_found", "素材文件夹不存在")
            existing = await (
                await connection.execute(
                    """
                    SELECT m.revision, m.folder_id, m.asset_id, m.asset_version,
                           m.display_name, m.added_from, m.deleted_at,
                           a.origin, a.mime_type, av.source_sha256, av.source_size
                    FROM material m
                    JOIN asset a ON a.asset_id=m.asset_id
                    JOIN asset_version av
                      ON av.asset_id=m.asset_id AND av.asset_version=m.asset_version
                    WHERE m.material_id=%s
                    FOR UPDATE
                    """,
                    (item.material_id,),
                )
            ).fetchone()
            if existing:
                current_revision = int(existing["revision"])
                same_content = (
                    existing["folder_id"] == item.folder_id
                    and existing["asset_id"] == item.asset_id
                    and int(existing["asset_version"]) == item.asset_version
                    and existing["display_name"] == item.display_name
                    and existing["added_from"] == item.added_from
                    and existing["origin"] == item.origin
                    and existing["mime_type"] == item.mime_type
                    and existing["source_sha256"] == item.source_sha256
                    and int(existing["source_size"]) == item.file_size_bytes
                    and existing["deleted_at"] is None
                )
                if same_content and item.revision <= current_revision:
                    return current_revision
                if existing["deleted_at"] is not None:
                    raise ServiceError(409, "entity_deleted", "素材已在其他设备删除")
                if item.revision != current_revision + 1:
                    raise ServiceError(
                        409,
                        "revision_conflict",
                        "素材已在其他设备修改",
                        action="refresh",
                        details={"current_revision": current_revision},
                    )
            asset_version = await (
                await connection.execute(
                    """
                    SELECT source_sha256, source_size FROM asset_version
                    WHERE asset_id=%s AND asset_version=%s
                    """,
                    (item.asset_id, item.asset_version),
                )
            ).fetchone()
            if asset_version and (
                asset_version["source_sha256"] != item.source_sha256
                or int(asset_version["source_size"]) != item.file_size_bytes
            ):
                raise ServiceError(409, "asset_identity_conflict", "素材资产身份冲突")
            await connection.execute(
                """
                INSERT INTO asset(asset_id, origin, original_file_name, mime_type)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT(asset_id) DO NOTHING
                """,
                (item.asset_id, item.origin, item.display_name, item.mime_type),
            )
            await connection.execute(
                """
                INSERT INTO asset_version(
                    asset_id, asset_version, source_sha256, source_size
                ) VALUES (%s, %s, %s, %s)
                ON CONFLICT(asset_id, asset_version) DO NOTHING
                """,
                (
                    item.asset_id,
                    item.asset_version,
                    item.source_sha256,
                    item.file_size_bytes,
                ),
            )
            revision = item.revision
            row = await (
                await connection.execute(
                    """
                    INSERT INTO material(
                        material_id, owner_id, folder_id, asset_id, asset_version,
                        display_name, added_from, revision
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT(material_id) DO UPDATE SET
                        folder_id=excluded.folder_id,
                        display_name=excluded.display_name,
                        revision=excluded.revision,
                        updated_at=now(),
                        deleted_at=NULL
                    RETURNING revision
                    """,
                    (
                        item.material_id,
                        user_id,
                        item.folder_id,
                        item.asset_id,
                        item.asset_version,
                        item.display_name,
                        item.added_from,
                        revision,
                    ),
                )
            ).fetchone()
            await connection.execute(
                """
                INSERT INTO sync_change(owner_id, entity_type, entity_id, operation, revision)
                VALUES (%s, 'material', %s, 'upsert', %s)
                """,
                (user_id, item.material_id, int(row["revision"])),
            )
            return int(row["revision"])

    async def list_folders(self, user_id: str) -> list[dict[str, Any]]:
        async with self.connection(user_id) as connection:
            rows = await (
                await connection.execute(
                    """
                    SELECT folder_id, parent_folder_id, name, revision, updated_at
                    FROM material_folder
                    WHERE deleted_at IS NULL
                    ORDER BY created_at, folder_id
                    """
                )
            ).fetchall()
            return [dict(row) for row in rows]

    async def update_folder(
        self,
        user_id: str,
        folder_id: str,
        *,
        expected_revision: int,
        name: str | None,
        parent_folder_id: str | None,
        update_parent: bool,
    ) -> dict[str, Any]:
        async with self.connection(user_id) as connection:
            current = await (
                await connection.execute(
                    """
                    SELECT folder_id, parent_folder_id, name, revision
                    FROM material_folder
                    WHERE folder_id=%s AND deleted_at IS NULL
                    FOR UPDATE
                    """,
                    (folder_id,),
                )
            ).fetchone()
            if not current:
                raise ServiceError(404, "folder_not_found", "素材文件夹不存在")
            if int(current["revision"]) != expected_revision:
                raise ServiceError(
                    409,
                    "revision_conflict",
                    "文件夹已在其他设备修改",
                    action="refresh",
                    details={"current_revision": int(current["revision"])},
                )
            next_parent = parent_folder_id if update_parent else current["parent_folder_id"]
            if next_parent:
                if next_parent == folder_id:
                    raise ServiceError(409, "folder_cycle", "文件夹不能移动到自身")
                cycle = await (
                    await connection.execute(
                        """
                        WITH RECURSIVE parents AS (
                            SELECT folder_id, parent_folder_id
                            FROM material_folder
                            WHERE folder_id=%s AND deleted_at IS NULL
                            UNION
                            SELECT f.folder_id, f.parent_folder_id
                            FROM material_folder f
                            JOIN parents p ON f.folder_id=p.parent_folder_id
                            WHERE f.deleted_at IS NULL
                        )
                        SELECT 1 FROM parents WHERE folder_id=%s LIMIT 1
                        """,
                        (next_parent, folder_id),
                    )
                ).fetchone()
                if cycle:
                    raise ServiceError(409, "folder_cycle", "文件夹不能移动到其子文件夹")
                parent = await (
                    await connection.execute(
                        "SELECT 1 FROM material_folder WHERE folder_id=%s AND deleted_at IS NULL",
                        (next_parent,),
                    )
                ).fetchone()
                if not parent:
                    raise ServiceError(422, "parent_folder_missing", "父文件夹不存在")
            next_name = name if name is not None else str(current["name"])
            try:
                row = await (
                    await connection.execute(
                        """
                        UPDATE material_folder
                        SET name=%s, name_key=lower(%s), parent_folder_id=%s,
                            revision=revision+1, updated_at=now()
                        WHERE folder_id=%s
                        RETURNING folder_id, parent_folder_id, name, revision, updated_at
                        """,
                        (next_name, next_name, next_parent, folder_id),
                    )
                ).fetchone()
            except (InsufficientPrivilege, UniqueViolation) as exc:
                mapped_error = _folder_write_error(exc)
                if mapped_error is not None:
                    raise mapped_error from exc
                raise
            await connection.execute(
                """
                INSERT INTO sync_change(owner_id, entity_type, entity_id, operation, revision)
                VALUES (%s, 'folder', %s, 'upsert', %s)
                """,
                (user_id, folder_id, int(row["revision"])),
            )
            return dict(row)

    async def delete_folder(
        self, user_id: str, folder_id: str, *, expected_revision: int
    ) -> int:
        async with self.connection(user_id) as connection:
            current = await (
                await connection.execute(
                    """
                    SELECT revision FROM material_folder
                    WHERE folder_id=%s AND deleted_at IS NULL
                    FOR UPDATE
                    """,
                    (folder_id,),
                )
            ).fetchone()
            if not current:
                raise ServiceError(404, "folder_not_found", "素材文件夹不存在")
            if int(current["revision"]) != expected_revision:
                raise ServiceError(409, "revision_conflict", "文件夹已在其他设备修改", action="refresh")
            occupied = await (
                await connection.execute(
                    """
                    SELECT EXISTS(
                        SELECT 1 FROM material_folder
                        WHERE parent_folder_id=%s AND deleted_at IS NULL
                    ) OR EXISTS(
                        SELECT 1 FROM material
                        WHERE folder_id=%s AND deleted_at IS NULL
                    ) AS occupied
                    """,
                    (folder_id, folder_id),
                )
            ).fetchone()
            if occupied and occupied["occupied"]:
                raise ServiceError(409, "folder_not_empty", "文件夹非空，不能删除")
            revision = expected_revision + 1
            await connection.execute(
                """
                UPDATE material_folder
                SET revision=%s, deleted_at=now(), updated_at=now()
                WHERE folder_id=%s
                """,
                (revision, folder_id),
            )
            await connection.execute(
                """
                INSERT INTO sync_change(owner_id, entity_type, entity_id, operation, revision)
                VALUES (%s, 'folder', %s, 'delete', %s)
                """,
                (user_id, folder_id, revision),
            )
            return revision

    @staticmethod
    def _material_dto(row: dict[str, Any], include_hash: bool = False) -> dict[str, Any]:
        publication_status = {
            "pending_review": "publishing",
            "published": "public",
            "paused": "suspended",
            "removed": "removed",
        }.get(str(row.get("publication_status") or ""), "private")
        result: dict[str, Any] = {
            "material_id": row["material_id"],
            "asset_id": row["asset_id"],
            "asset_version": int(row["asset_version"]),
            "folder_id": row["folder_id"],
            "display_name": row["display_name"],
            "origin": row["origin"],
            "added_from": row["added_from"],
            "mime_type": row["mime_type"],
            "file_size_bytes": int(row["source_size"]),
            "cloud_status": row["cloud_status"],
            "cloud_error": row["last_error"],
            "analysis_status": row.get("analysis_status") or "pending",
            "vector_sync_status": row.get("vector_sync_status") or "pending",
            "publication_status": publication_status,
            "publication_id": row.get("publication_id"),
            "publication_revision": (
                int(row["publication_revision"])
                if row.get("publication_revision") is not None
                else None
            ),
            "publication_review_reason": row.get("publication_review_reason"),
            "revision": int(row["revision"]),
            "updated_at": row["updated_at"],
        }
        if include_hash:
            result["source_sha256"] = row["source_sha256"]
        return result

    async def list_materials(
        self,
        user_id: str,
        *,
        limit: int,
        cursor: str | None,
        folder_id: str | None,
        keyword: str | None,
    ) -> tuple[list[dict[str, Any]], str | None]:
        decoded = _cursor_decode(cursor)
        clauses = ["m.deleted_at IS NULL"]
        parameters: list[Any] = []
        if folder_id:
            clauses.append("m.folder_id=%s")
            parameters.append(folder_id)
        if keyword:
            clauses.append("m.display_name ILIKE %s")
            parameters.append(f"%{keyword}%")
        if decoded:
            clauses.append("(m.updated_at, m.material_id) < (%s, %s)")
            parameters.extend(decoded)
        parameters.append(limit + 1)
        async with self.connection(user_id) as connection:
            rows = await (
                await connection.execute(
                    f"""
                    SELECT m.*, a.origin, a.mime_type, av.source_sha256, av.source_size,
                           av.cloud_status, av.last_error,
                           an.analysis_status, an.vector_sync_status,
                           p.status AS publication_status,
                           p.publication_id,
                           p.revision AS publication_revision,
                           p.review_reason AS publication_review_reason
                    FROM material m
                    JOIN asset a ON a.asset_id=m.asset_id
                    JOIN asset_version av ON av.asset_id=m.asset_id AND av.asset_version=m.asset_version
                    LEFT JOIN LATERAL (
                        SELECT candidate.* FROM analysis candidate
                        WHERE candidate.asset_id=m.asset_id
                          AND candidate.asset_version=m.asset_version
                          AND (candidate.analysis_status <> 'completed' OR (
                              candidate.chunk_count > 0
                              AND candidate.chunk_count = (
                                  SELECT count(*) FROM analysis_chunk chunk
                                  WHERE chunk.analysis_id=candidate.analysis_id
                              )
                          ))
                        ORDER BY (candidate.analysis_status='completed') DESC,
                                 candidate.updated_at DESC, candidate.analysis_id DESC
                        LIMIT 1
                    ) an ON TRUE
                    LEFT JOIN material_publication p ON p.material_id=m.material_id AND p.removed_at IS NULL
                    WHERE {' AND '.join(clauses)}
                    ORDER BY m.updated_at DESC, m.material_id DESC
                    LIMIT %s
                    """,
                    parameters,
                )
            ).fetchall()
        has_more = len(rows) > limit
        page = rows[:limit]
        next_cursor = (
            _cursor_encode(page[-1]["updated_at"], page[-1]["material_id"])
            if has_more and page
            else None
        )
        return [self._material_dto(dict(row), include_hash=True) for row in page], next_cursor

    async def get_material(self, user_id: str, material_id: str) -> dict[str, Any]:
        async with self.connection(user_id) as connection:
            row = await (
                await connection.execute(
                    """
                    SELECT m.*, a.origin, a.mime_type, av.source_sha256, av.source_size,
                           av.cloud_status, av.last_error,
                           an.analysis_status, an.vector_sync_status,
                           p.status AS publication_status,
                           p.publication_id,
                           p.revision AS publication_revision,
                           p.review_reason AS publication_review_reason
                    FROM material m
                    JOIN asset a ON a.asset_id=m.asset_id
                    JOIN asset_version av ON av.asset_id=m.asset_id AND av.asset_version=m.asset_version
                    LEFT JOIN LATERAL (
                        SELECT candidate.* FROM analysis candidate
                        WHERE candidate.asset_id=m.asset_id
                          AND candidate.asset_version=m.asset_version
                          AND (candidate.analysis_status <> 'completed' OR (
                              candidate.chunk_count > 0
                              AND candidate.chunk_count = (
                                  SELECT count(*) FROM analysis_chunk chunk
                                  WHERE chunk.analysis_id=candidate.analysis_id
                              )
                          ))
                        ORDER BY (candidate.analysis_status='completed') DESC,
                                 candidate.updated_at DESC, candidate.analysis_id DESC
                        LIMIT 1
                    ) an ON TRUE
                    LEFT JOIN material_publication p ON p.material_id=m.material_id AND p.removed_at IS NULL
                    WHERE m.material_id=%s AND m.deleted_at IS NULL
                    """,
                    (material_id,),
                )
            ).fetchone()
        if not row:
            raise ServiceError(404, "material_not_found", "素材不存在")
        return self._material_dto(dict(row), include_hash=True)

    async def update_material(
        self,
        user_id: str,
        material_id: str,
        *,
        expected_revision: int,
        display_name: str | None,
        folder_id: str | None,
    ) -> dict[str, Any]:
        async with self.connection(user_id) as connection:
            current = await (
                await connection.execute(
                    """
                    SELECT display_name, folder_id, revision
                    FROM material
                    WHERE material_id=%s AND deleted_at IS NULL
                    FOR UPDATE
                    """,
                    (material_id,),
                )
            ).fetchone()
            if not current:
                raise ServiceError(404, "material_not_found", "素材不存在")
            if int(current["revision"]) != expected_revision:
                raise ServiceError(
                    409,
                    "revision_conflict",
                    "素材已在其他设备修改",
                    action="refresh",
                    details={"current_revision": int(current["revision"])},
                )
            next_folder = folder_id or str(current["folder_id"])
            folder = await (
                await connection.execute(
                    "SELECT 1 FROM material_folder WHERE folder_id=%s AND deleted_at IS NULL",
                    (next_folder,),
                )
            ).fetchone()
            if not folder:
                raise ServiceError(422, "folder_not_found", "素材文件夹不存在")
            row = await (
                await connection.execute(
                    """
                    UPDATE material
                    SET display_name=%s, folder_id=%s, revision=revision+1, updated_at=now()
                    WHERE material_id=%s
                    RETURNING revision
                    """,
                    (display_name or str(current["display_name"]), next_folder, material_id),
                )
            ).fetchone()
            await connection.execute(
                """
                INSERT INTO sync_change(owner_id, entity_type, entity_id, operation, revision)
                VALUES (%s, 'material', %s, 'upsert', %s)
                """,
                (user_id, material_id, int(row["revision"])),
            )
        return await self.get_material(user_id, material_id)

    async def delete_material(
        self, user_id: str, material_id: str, *, expected_revision: int
    ) -> int:
        async with self.connection(user_id) as connection:
            current = await (
                await connection.execute(
                    """
                    SELECT revision FROM material
                    WHERE material_id=%s AND deleted_at IS NULL
                    FOR UPDATE
                    """,
                    (material_id,),
                )
            ).fetchone()
            if not current:
                raise ServiceError(404, "material_not_found", "素材不存在")
            if int(current["revision"]) != expected_revision:
                raise ServiceError(409, "revision_conflict", "素材已在其他设备修改", action="refresh")
            revision = expected_revision + 1
            await connection.execute(
                """
                UPDATE material
                SET revision=%s, deleted_at=now(), updated_at=now()
                WHERE material_id=%s
                """,
                (revision, material_id),
            )
            await connection.execute(
                """
                INSERT INTO sync_change(owner_id, entity_type, entity_id, operation, revision)
                VALUES (%s, 'material', %s, 'delete', %s)
                """,
                (user_id, material_id, revision),
            )
            return revision

    async def begin_cloud_copy_delete(
        self,
        user_id: str,
        material_id: str,
        *,
        expected_revision: int,
        operation_id: str,
    ) -> dict[str, Any]:
        async with self.connection(user_id) as connection:
            current = await (
                await connection.execute(
                    """
                    SELECT m.revision, av.cloud_status, av.storage_session_id,
                           av.cloud_delete_operation_id,
                           EXISTS (
                               SELECT 1 FROM material_publication p
                               WHERE p.material_id=m.material_id
                                 AND p.removed_at IS NULL
                                 AND p.status IN ('pending_review', 'published', 'paused')
                           ) AS has_active_publication
                    FROM material m
                    JOIN asset_version av
                      ON av.asset_id=m.asset_id AND av.asset_version=m.asset_version
                    WHERE m.material_id=%s AND m.deleted_at IS NULL
                    FOR UPDATE OF m, av
                    """,
                    (material_id,),
                )
            ).fetchone()
            if not current:
                raise ServiceError(404, "material_not_found", "素材不存在")
            if (
                current["cloud_status"] == "deleting"
                and current["cloud_delete_operation_id"] == operation_id
                and current["storage_session_id"]
            ):
                return {
                    "storage_session_id": str(current["storage_session_id"]),
                    "revision": int(current["revision"]),
                }
            if int(current["revision"]) != expected_revision:
                raise ServiceError(
                    409,
                    "revision_conflict",
                    "素材已在其他设备修改",
                    action="refresh",
                    details={"current_revision": int(current["revision"])},
                )
            if current["has_active_publication"]:
                raise ServiceError(
                    409,
                    "publication_requires_cloud_copy",
                    "素材正在发布或已公开，请先撤回公开素材",
                )
            if current["cloud_status"] != "ready" or not current["storage_session_id"]:
                if current["cloud_status"] == "deleting":
                    raise ServiceError(409, "cloud_copy_delete_in_progress", "云端副本正在删除")
                raise ServiceError(409, "cloud_copy_not_ready", "素材云端文件尚未就绪")
            await connection.execute(
                """
                UPDATE asset_version
                SET cloud_status='deleting', cloud_delete_operation_id=%s,
                    last_error=NULL, updated_at=now()
                WHERE asset_id=(SELECT asset_id FROM material WHERE material_id=%s)
                  AND asset_version=(SELECT asset_version FROM material WHERE material_id=%s)
                """,
                (operation_id, material_id, material_id),
            )
            return {
                "storage_session_id": str(current["storage_session_id"]),
                "revision": int(current["revision"]),
            }

    async def finish_cloud_copy_delete(
        self,
        user_id: str,
        material_id: str,
        *,
        storage_session_id: str,
        operation_id: str,
    ) -> int:
        async with self.connection(user_id) as connection:
            current = await (
                await connection.execute(
                    """
                    SELECT m.revision, av.cloud_status, av.storage_session_id,
                           av.cloud_delete_operation_id
                    FROM material m
                    JOIN asset_version av
                      ON av.asset_id=m.asset_id AND av.asset_version=m.asset_version
                    WHERE m.material_id=%s AND m.deleted_at IS NULL
                    FOR UPDATE OF m, av
                    """,
                    (material_id,),
                )
            ).fetchone()
            if not current:
                raise ServiceError(404, "material_not_found", "素材不存在")
            if (
                current["cloud_status"] == "not_uploaded"
                and current["storage_session_id"] is None
                and current["cloud_delete_operation_id"] == operation_id
            ):
                return int(current["revision"])
            if (
                current["cloud_status"] != "deleting"
                or current["storage_session_id"] != storage_session_id
                or current["cloud_delete_operation_id"] != operation_id
            ):
                raise ServiceError(409, "cloud_copy_delete_conflict", "云端副本删除状态已变化")
            await connection.execute(
                """
                UPDATE asset_version
                SET cloud_status='not_uploaded', storage_session_id=NULL,
                    verified_at=NULL, last_error=NULL, updated_at=now()
                WHERE asset_id=(SELECT asset_id FROM material WHERE material_id=%s)
                  AND asset_version=(SELECT asset_version FROM material WHERE material_id=%s)
                """,
                (material_id, material_id),
            )
            row = await (
                await connection.execute(
                    """
                    UPDATE material
                    SET revision=revision+1, updated_at=now()
                    WHERE material_id=%s
                    RETURNING revision
                    """,
                    (material_id,),
                )
            ).fetchone()
            revision = int(row["revision"])
            await connection.execute(
                """
                INSERT INTO sync_change(owner_id, entity_type, entity_id, operation, revision)
                VALUES (%s, 'material', %s, 'upsert', %s)
                """,
                (user_id, material_id, revision),
            )
            return revision

    async def create_publication(
        self,
        user_id: str,
        material_id: str,
        *,
        publication_id: str,
        expected_revision: int,
        consent_version: str,
    ) -> dict[str, Any]:
        async with self.connection(user_id) as connection:
            material = await (
                await connection.execute(
                    """
                    SELECT m.revision, av.cloud_status,
                           coalesce(an.analysis_status, 'pending') AS analysis_status
                    FROM material m
                    JOIN asset_version av
                      ON av.asset_id=m.asset_id AND av.asset_version=m.asset_version
                    LEFT JOIN LATERAL (
                        SELECT candidate.* FROM analysis candidate
                        WHERE candidate.asset_id=m.asset_id
                          AND candidate.asset_version=m.asset_version
                          AND (candidate.analysis_status <> 'completed' OR (
                              candidate.chunk_count > 0
                              AND candidate.chunk_count = (
                                  SELECT count(*) FROM analysis_chunk chunk
                                  WHERE chunk.analysis_id=candidate.analysis_id
                              )
                          ))
                        ORDER BY (candidate.analysis_status='completed') DESC,
                                 candidate.updated_at DESC, candidate.analysis_id DESC
                        LIMIT 1
                    ) an ON TRUE
                    WHERE m.material_id=%s AND m.deleted_at IS NULL
                    FOR UPDATE OF m, av
                    """,
                    (material_id,),
                )
            ).fetchone()
            if not material:
                raise ServiceError(404, "material_not_found", "素材不存在")
            if int(material["revision"]) != expected_revision:
                raise ServiceError(
                    409,
                    "revision_conflict",
                    "素材已在其他设备修改",
                    action="refresh",
                    details={"current_revision": int(material["revision"])},
                )
            if material["cloud_status"] != "ready":
                raise ServiceError(409, "cloud_copy_not_ready", "公开素材前必须先完成云端备份")
            if material["analysis_status"] != "completed":
                raise ServiceError(409, "analysis_not_ready", "公开素材前必须先完成素材分析")
            existing = await (
                await connection.execute(
                    """
                    SELECT * FROM material_publication
                    WHERE material_id=%s AND removed_at IS NULL
                    FOR UPDATE
                    """,
                    (material_id,),
                )
            ).fetchone()
            if existing and existing["status"] != "rejected":
                raise ServiceError(409, "publication_exists", "素材已有进行中的公开申请")
            if existing:
                publication = await (
                    await connection.execute(
                        """
                        UPDATE material_publication
                        SET status='pending_review', consent_version=%s,
                            rights_confirmed=TRUE, reviewer_id=NULL,
                            review_reason=NULL, reviewed_at=NULL,
                            revision=revision+1, updated_at=now()
                        WHERE publication_id=%s
                        RETURNING *
                        """,
                        (consent_version, existing["publication_id"]),
                    )
                ).fetchone()
            else:
                publication = await (
                    await connection.execute(
                        """
                        INSERT INTO material_publication(
                            publication_id, owner_id, material_id, status,
                            consent_version, rights_confirmed
                        ) VALUES (%s, %s, %s, 'pending_review', %s, TRUE)
                        RETURNING *
                        """,
                        (publication_id, user_id, material_id, consent_version),
                    )
                ).fetchone()
            material_revision = await (
                await connection.execute(
                    """
                    UPDATE material SET revision=revision+1, updated_at=now()
                    WHERE material_id=%s RETURNING revision
                    """,
                    (material_id,),
                )
            ).fetchone()
            await connection.execute(
                """
                INSERT INTO sync_change(owner_id, entity_type, entity_id, operation, revision)
                VALUES (%s, 'material', %s, 'upsert', %s)
                """,
                (user_id, material_id, int(material_revision["revision"])),
            )
        return {
            "publication_id": str(publication["publication_id"]),
            "material_id": material_id,
            "status": str(publication["status"]),
            "revision": int(publication["revision"]),
            "material_revision": int(material_revision["revision"]),
            "consent_version": str(publication["consent_version"]),
            "rights_confirmed": bool(publication["rights_confirmed"]),
        }

    async def review_publication(
        self,
        actor_id: str,
        actor_role: str,
        publication_id: str,
        *,
        expected_revision: int,
        decision: str,
        reason: str,
    ) -> dict[str, Any]:
        async with self.connection(actor_id, role=actor_role) as connection:
            current = await (
                await connection.execute(
                    """
                    SELECT p.*, m.asset_id, m.asset_version,
                           av.cloud_status,
                           coalesce(an.analysis_status, 'pending') AS analysis_status
                    FROM material_publication p
                    JOIN material m ON m.material_id=p.material_id AND m.deleted_at IS NULL
                    JOIN asset_version av
                      ON av.asset_id=m.asset_id AND av.asset_version=m.asset_version
                    LEFT JOIN LATERAL (
                        SELECT candidate.* FROM analysis candidate
                        WHERE candidate.asset_id=m.asset_id
                          AND candidate.asset_version=m.asset_version
                          AND (candidate.analysis_status <> 'completed' OR (
                              candidate.chunk_count > 0
                              AND candidate.chunk_count = (
                                  SELECT count(*) FROM analysis_chunk chunk
                                  WHERE chunk.analysis_id=candidate.analysis_id
                              )
                          ))
                        ORDER BY (candidate.analysis_status='completed') DESC,
                                 candidate.updated_at DESC, candidate.analysis_id DESC
                        LIMIT 1
                    ) an ON TRUE
                    WHERE p.publication_id=%s AND p.removed_at IS NULL
                    FOR UPDATE OF p, m, av
                    """,
                    (publication_id,),
                )
            ).fetchone()
            if not current:
                raise ServiceError(404, "publication_not_found", "公开申请不存在")
            if int(current["revision"]) != expected_revision:
                raise ServiceError(
                    409,
                    "revision_conflict",
                    "公开申请已被其他审核员处理",
                    action="refresh",
                    details={"current_revision": int(current["revision"])},
                )
            if current["status"] != "pending_review":
                raise ServiceError(409, "publication_not_pending", "公开申请已不在待审核状态")
            if decision == "approve":
                if current["cloud_status"] != "ready":
                    raise ServiceError(409, "cloud_copy_not_ready", "素材云端副本不可用，不能通过审核")
                if current["analysis_status"] != "completed":
                    raise ServiceError(409, "analysis_not_ready", "素材分析未完成，不能通过审核")
            next_status = "published" if decision == "approve" else "rejected"
            publication = await (
                await connection.execute(
                    """
                    UPDATE material_publication
                    SET status=%s, reviewer_id=%s, review_reason=%s,
                        reviewed_at=now(),
                        published_at=CASE WHEN %s='published' THEN now() ELSE NULL END,
                        revision=revision+1, updated_at=now()
                    WHERE publication_id=%s
                    RETURNING *
                    """,
                    (next_status, actor_id, reason or None, next_status, publication_id),
                )
            ).fetchone()
            material_revision = await (
                await connection.execute(
                    """
                    UPDATE material SET revision=revision+1, updated_at=now()
                    WHERE material_id=%s RETURNING revision
                    """,
                    (current["material_id"],),
                )
            ).fetchone()
            await connection.execute(
                """
                INSERT INTO sync_change(owner_id, entity_type, entity_id, operation, revision)
                VALUES (%s, 'material', %s, 'upsert', %s)
                """,
                (
                    current["owner_id"],
                    current["material_id"],
                    int(material_revision["revision"]),
                ),
            )
        return {
            "publication_id": publication_id,
            "material_id": str(current["material_id"]),
            "status": str(publication["status"]),
            "revision": int(publication["revision"]),
            "material_revision": int(material_revision["revision"]),
            "review_reason": str(publication["review_reason"] or ""),
        }

    async def list_public_materials(
        self,
        user_id: str,
        *,
        limit: int,
        cursor: str | None,
        keyword: str | None,
    ) -> tuple[list[dict[str, Any]], str | None]:
        decoded = _cursor_decode(cursor)
        clauses = ["p.status='published'", "p.removed_at IS NULL", "av.cloud_status='ready'"]
        parameters: list[Any] = []
        if keyword:
            clauses.append("m.display_name ILIKE %s")
            parameters.append(f"%{keyword}%")
        if decoded:
            clauses.append("(p.published_at, p.publication_id) < (%s, %s)")
            parameters.extend(decoded)
        parameters.append(limit + 1)
        async with self.connection(user_id) as connection:
            rows = await (
                await connection.execute(
                    f"""
                    SELECT p.publication_id, p.published_at,
                           m.display_name, a.mime_type,
                           av.source_size AS file_size_bytes,
                           coalesce(an.analysis_status, 'pending') AS analysis_status,
                           p.owner_id <> current_setting('app.user_id', true) AS can_report,
                           (
                               SELECT r.status
                               FROM material_publication_report r
                               WHERE r.publication_id=p.publication_id
                                 AND r.reporter_id=current_setting('app.user_id', true)
                                 AND r.status IN ('pending', 'reviewing')
                               LIMIT 1
                           ) AS report_status
                    FROM material_publication p
                    JOIN material m ON m.material_id=p.material_id AND m.deleted_at IS NULL
                    JOIN asset a ON a.asset_id=m.asset_id
                    JOIN asset_version av
                      ON av.asset_id=m.asset_id AND av.asset_version=m.asset_version
                    LEFT JOIN LATERAL (
                        SELECT candidate.* FROM analysis candidate
                        WHERE candidate.asset_id=m.asset_id
                          AND candidate.asset_version=m.asset_version
                          AND (candidate.analysis_status <> 'completed' OR (
                              candidate.chunk_count > 0
                              AND candidate.chunk_count = (
                                  SELECT count(*) FROM analysis_chunk chunk
                                  WHERE chunk.analysis_id=candidate.analysis_id
                              )
                          ))
                        ORDER BY (candidate.analysis_status='completed') DESC,
                                 candidate.updated_at DESC, candidate.analysis_id DESC
                        LIMIT 1
                    ) an ON TRUE
                    WHERE {' AND '.join(clauses)}
                    ORDER BY p.published_at DESC, p.publication_id DESC
                    LIMIT %s
                    """,
                    parameters,
                )
            ).fetchall()
        has_more = len(rows) > limit
        page = rows[:limit]
        next_cursor = (
            _cursor_encode(page[-1]["published_at"], str(page[-1]["publication_id"]))
            if has_more and page
            else None
        )
        return [
            {
                "publication_id": str(row["publication_id"]),
                "display_name": str(row["display_name"]),
                "mime_type": str(row["mime_type"]),
                "file_size_bytes": int(row["file_size_bytes"]),
                "analysis_status": "ready" if row["analysis_status"] == "completed" else "pending",
                "published_at": row["published_at"],
                "can_report": bool(row["can_report"]),
                "report_status": str(row["report_status"]) if row["report_status"] else None,
            }
            for row in page
        ], next_cursor

    async def create_publication_report(
        self,
        user_id: str,
        publication_id: str,
        *,
        report_id: str,
        category: str,
        description: str,
    ) -> dict[str, Any]:
        async with self.connection(user_id) as connection:
            publication = await (
                await connection.execute(
                    """
                    SELECT publication_id, owner_id
                    FROM material_publication
                    WHERE publication_id=%s AND status='published' AND removed_at IS NULL
                    FOR SHARE
                    """,
                    (publication_id,),
                )
            ).fetchone()
            if not publication:
                raise ServiceError(404, "public_material_not_found", "公共素材不存在或已下架")
            if publication["owner_id"] == user_id:
                raise ServiceError(422, "cannot_report_own_material", "不能举报自己公开的素材")
            created = await (
                await connection.execute(
                    """
                    INSERT INTO material_publication_report(
                        report_id, publication_id, reporter_id, category, description
                    ) VALUES (%s, %s, %s, %s, %s)
                    ON CONFLICT (reporter_id, publication_id)
                    WHERE status IN ('pending', 'reviewing')
                    DO NOTHING
                    RETURNING report_id, publication_id, category, status, revision, created_at
                    """,
                    (report_id, publication_id, user_id, category, description),
                )
            ).fetchone()
            report = created
            if not report:
                report = await (
                    await connection.execute(
                        """
                        SELECT report_id, publication_id, category, status, revision, created_at
                        FROM material_publication_report
                        WHERE reporter_id=%s AND publication_id=%s
                          AND status IN ('pending', 'reviewing')
                        """,
                        (user_id, publication_id),
                    )
                ).fetchone()
            if not report:
                raise ServiceError(409, "report_submission_conflict", "举报状态已变化，请重试")
        return {
            "report_id": str(report["report_id"]),
            "publication_id": str(report["publication_id"]),
            "category": str(report["category"]),
            "status": str(report["status"]),
            "revision": int(report["revision"]),
            "created_at": report["created_at"],
            "created": created is not None,
        }

    async def list_publication_reports(
        self,
        actor_id: str,
        actor_role: str,
        *,
        status: str,
        limit: int,
    ) -> list[dict[str, Any]]:
        async with self.connection(actor_id, role=actor_role) as connection:
            rows = await (
                await connection.execute(
                    """
                    SELECT r.report_id, r.publication_id, r.category, r.description,
                           r.status, r.revision, r.created_at, r.review_reason,
                           m.display_name, p.status AS publication_status,
                           p.revision AS publication_revision
                    FROM material_publication_report r
                    JOIN material_publication p ON p.publication_id=r.publication_id
                    JOIN material m ON m.material_id=p.material_id
                    WHERE r.status=%s
                    ORDER BY r.created_at ASC, r.report_id ASC
                    LIMIT %s
                    """,
                    (status, limit),
                )
            ).fetchall()
        return [
            {
                "report_id": str(row["report_id"]),
                "publication_id": str(row["publication_id"]),
                "category": str(row["category"]),
                "description": str(row["description"]),
                "status": str(row["status"]),
                "revision": int(row["revision"]),
                "created_at": row["created_at"],
                "review_reason": str(row["review_reason"] or ""),
                "display_name": str(row["display_name"]),
                "publication_status": str(row["publication_status"]),
                "publication_revision": int(row["publication_revision"]),
            }
            for row in rows
        ]

    async def review_publication_report(
        self,
        actor_id: str,
        actor_role: str,
        report_id: str,
        *,
        expected_revision: int,
        decision: str,
        reason: str,
    ) -> dict[str, Any]:
        async with self.connection(actor_id, role=actor_role) as connection:
            current = await (
                await connection.execute(
                    """
                    SELECT r.*, p.status AS publication_status,
                           p.revision AS publication_revision
                    FROM material_publication_report r
                    JOIN material_publication p ON p.publication_id=r.publication_id
                    WHERE r.report_id=%s
                    FOR UPDATE OF r, p
                    """,
                    (report_id,),
                )
            ).fetchone()
            if not current:
                raise ServiceError(404, "publication_report_not_found", "举报记录不存在")
            if int(current["revision"]) != expected_revision:
                raise ServiceError(
                    409,
                    "revision_conflict",
                    "举报已被其他审核员处理",
                    action="refresh",
                    details={"current_revision": int(current["revision"])},
                )
            if current["status"] not in {"pending", "reviewing"}:
                raise ServiceError(409, "report_already_reviewed", "举报已经完成审核")
            next_status = "upheld" if decision == "uphold" else "dismissed"
            report = await (
                await connection.execute(
                    """
                    UPDATE material_publication_report
                    SET status=%s, reviewer_id=%s, review_reason=%s,
                        reviewed_at=now(), revision=revision+1, updated_at=now()
                    WHERE report_id=%s
                    RETURNING revision, reviewed_at
                    """,
                    (next_status, actor_id, reason, report_id),
                )
            ).fetchone()
        publication_status = str(current["publication_status"])
        next_actions: list[str] = []
        if next_status == "upheld":
            if publication_status == "published":
                next_actions = ["pause_publication", "remove_publication"]
            elif publication_status == "paused":
                next_actions = ["remove_publication"]
        return {
            "report_id": report_id,
            "publication_id": str(current["publication_id"]),
            "status": next_status,
            "revision": int(report["revision"]),
            "reviewed_at": report["reviewed_at"],
            "publication_status": publication_status,
            "publication_revision": int(current["publication_revision"]),
            "next_actions": next_actions,
        }

    async def add_public_material(
        self,
        user_id: str,
        publication_id: str,
        *,
        folder_id: str,
        material_id: str,
    ) -> dict[str, Any]:
        async with self.connection(user_id) as connection:
            source = await (
                await connection.execute(
                    """
                    SELECT p.publication_id, p.owner_id AS source_owner_id,
                           m.material_id AS source_material_id, m.asset_id,
                           m.asset_version, m.display_name,
                           m.revision AS source_material_revision,
                           av.cloud_status,
                           coalesce(an.analysis_status, 'pending') AS analysis_status
                    FROM material_publication p
                    JOIN material m ON m.material_id=p.material_id AND m.deleted_at IS NULL
                    JOIN asset_version av
                      ON av.asset_id=m.asset_id AND av.asset_version=m.asset_version
                    LEFT JOIN LATERAL (
                        SELECT candidate.* FROM analysis candidate
                        WHERE candidate.asset_id=m.asset_id
                          AND candidate.asset_version=m.asset_version
                          AND (candidate.analysis_status <> 'completed' OR (
                              candidate.chunk_count > 0
                              AND candidate.chunk_count = (
                                  SELECT count(*) FROM analysis_chunk chunk
                                  WHERE chunk.analysis_id=candidate.analysis_id
                              )
                          ))
                        ORDER BY (candidate.analysis_status='completed') DESC,
                                 candidate.updated_at DESC, candidate.analysis_id DESC
                        LIMIT 1
                    ) an ON TRUE
                    WHERE p.publication_id=%s AND p.status='published'
                      AND p.removed_at IS NULL
                    FOR SHARE OF p, m, av
                    """,
                    (publication_id,),
                )
            ).fetchone()
            if not source:
                raise ServiceError(404, "public_material_not_found", "公共素材不存在或已下架")
            if source["cloud_status"] != "ready":
                raise ServiceError(409, "public_material_unavailable", "公共素材云端文件暂不可用")
            if source["source_owner_id"] == user_id:
                return {
                    "publication_id": publication_id,
                    "material_id": str(source["source_material_id"]),
                    "created": False,
                    "cloud_status": "ready",
                    "analysis_status": "ready" if source["analysis_status"] == "completed" else "pending",
                    "revision": int(source["source_material_revision"]),
                }
            existing = await (
                await connection.execute(
                    """
                    SELECT i.material_id, m.revision,
                           av.cloud_status,
                           coalesce(an.analysis_status, 'pending') AS analysis_status
                    FROM public_material_import i
                    JOIN material m ON m.material_id=i.material_id AND m.deleted_at IS NULL
                    JOIN asset_version av
                      ON av.asset_id=m.asset_id AND av.asset_version=m.asset_version
                    LEFT JOIN LATERAL (
                        SELECT candidate.* FROM analysis candidate
                        WHERE candidate.asset_id=m.asset_id
                          AND candidate.asset_version=m.asset_version
                          AND (candidate.analysis_status <> 'completed' OR (
                              candidate.chunk_count > 0
                              AND candidate.chunk_count = (
                                  SELECT count(*) FROM analysis_chunk chunk
                                  WHERE chunk.analysis_id=candidate.analysis_id
                              )
                          ))
                        ORDER BY (candidate.analysis_status='completed') DESC,
                                 candidate.updated_at DESC, candidate.analysis_id DESC
                        LIMIT 1
                    ) an ON TRUE
                    WHERE i.owner_id=%s AND i.publication_id=%s
                    """,
                    (user_id, publication_id),
                )
            ).fetchone()
            if existing:
                return {
                    "publication_id": publication_id,
                    "material_id": str(existing["material_id"]),
                    "created": False,
                    "cloud_status": str(existing["cloud_status"]),
                    "analysis_status": "ready" if existing["analysis_status"] == "completed" else "pending",
                    "revision": int(existing["revision"]),
                }
            folder = await (
                await connection.execute(
                    """
                    SELECT folder_id FROM material_folder
                    WHERE folder_id=%s AND deleted_at IS NULL
                    """,
                    (folder_id,),
                )
            ).fetchone()
            if not folder:
                raise ServiceError(422, "folder_not_found", "目标素材文件夹不存在")
            await connection.execute(
                """
                INSERT INTO material(
                    material_id, owner_id, folder_id, asset_id, asset_version,
                    display_name, added_from, revision
                ) VALUES (%s, %s, %s, %s, %s, %s, 'public_library', 1)
                """,
                (
                    material_id,
                    user_id,
                    folder_id,
                    source["asset_id"],
                    source["asset_version"],
                    source["display_name"],
                ),
            )
            await connection.execute(
                """
                INSERT INTO public_material_import(owner_id, publication_id, material_id)
                VALUES (%s, %s, %s)
                """,
                (user_id, publication_id, material_id),
            )
            await connection.execute(
                """
                INSERT INTO sync_change(owner_id, entity_type, entity_id, operation, revision)
                VALUES (%s, 'material', %s, 'upsert', 1)
                """,
                (user_id, material_id),
            )
        return {
            "publication_id": publication_id,
            "material_id": material_id,
            "created": True,
            "cloud_status": "ready",
            "analysis_status": "ready" if source["analysis_status"] == "completed" else "pending",
            "revision": 1,
        }

    async def withdraw_publication(
        self,
        user_id: str,
        publication_id: str,
        *,
        expected_revision: int,
        reason: str,
    ) -> dict[str, Any]:
        async with self.connection(user_id) as connection:
            current = await (
                await connection.execute(
                    """
                    SELECT p.*, m.revision AS material_revision
                    FROM material_publication p
                    JOIN material m ON m.material_id=p.material_id AND m.deleted_at IS NULL
                    WHERE p.publication_id=%s AND p.removed_at IS NULL
                    FOR UPDATE OF p, m
                    """,
                    (publication_id,),
                )
            ).fetchone()
            if not current:
                raise ServiceError(404, "publication_not_found", "公开申请不存在")
            if int(current["revision"]) != expected_revision:
                raise ServiceError(
                    409,
                    "revision_conflict",
                    "公开申请已发生变化",
                    action="refresh",
                    details={"current_revision": int(current["revision"])},
                )
            if current["status"] in {"withdrawn", "removed"}:
                raise ServiceError(409, "publication_not_active", "公开申请已结束")
            publication = await (
                await connection.execute(
                    """
                    UPDATE material_publication
                    SET status='withdrawn', review_reason=%s,
                        removed_at=now(), revision=revision+1, updated_at=now()
                    WHERE publication_id=%s
                    RETURNING revision
                    """,
                    (reason or None, publication_id),
                )
            ).fetchone()
            material = await (
                await connection.execute(
                    """
                    UPDATE material SET revision=revision+1, updated_at=now()
                    WHERE material_id=%s RETURNING revision
                    """,
                    (current["material_id"],),
                )
            ).fetchone()
            await connection.execute(
                """
                INSERT INTO sync_change(owner_id, entity_type, entity_id, operation, revision)
                VALUES (%s, 'material', %s, 'upsert', %s)
                """,
                (user_id, current["material_id"], int(material["revision"])),
            )
        return {
            "publication_id": publication_id,
            "material_id": str(current["material_id"]),
            "status": "withdrawn",
            "revision": int(publication["revision"]),
            "material_revision": int(material["revision"]),
        }

    async def moderate_publication_status(
        self,
        actor_id: str,
        actor_role: str,
        publication_id: str,
        *,
        expected_revision: int,
        action: str,
        reason: str,
    ) -> dict[str, Any]:
        transitions = {
            "pause": ({"published"}, "paused"),
            "resume": ({"paused"}, "published"),
            "remove": ({"published", "paused"}, "removed"),
        }
        allowed, next_status = transitions[action]
        async with self.connection(actor_id, role=actor_role) as connection:
            current = await (
                await connection.execute(
                    """
                    SELECT p.*, av.cloud_status
                    FROM material_publication p
                    JOIN material m ON m.material_id=p.material_id AND m.deleted_at IS NULL
                    JOIN asset_version av
                      ON av.asset_id=m.asset_id AND av.asset_version=m.asset_version
                    WHERE p.publication_id=%s AND p.removed_at IS NULL
                    FOR UPDATE OF p, m, av
                    """,
                    (publication_id,),
                )
            ).fetchone()
            if not current:
                raise ServiceError(404, "publication_not_found", "公开素材不存在")
            if int(current["revision"]) != expected_revision:
                raise ServiceError(
                    409,
                    "revision_conflict",
                    "公开素材已被其他审核员处理",
                    action="refresh",
                    details={"current_revision": int(current["revision"])},
                )
            if current["status"] not in allowed:
                raise ServiceError(409, "publication_transition_invalid", "公开素材当前状态不支持该操作")
            if action == "resume" and current["cloud_status"] != "ready":
                raise ServiceError(409, "cloud_copy_not_ready", "云端副本不可用，不能恢复公开")
            publication = await (
                await connection.execute(
                    """
                    UPDATE material_publication
                    SET status=%s, reviewer_id=%s, review_reason=%s,
                        reviewed_at=now(),
                        published_at=CASE WHEN %s='published' THEN coalesce(published_at, now()) ELSE published_at END,
                        removed_at=CASE WHEN %s='removed' THEN now() ELSE NULL END,
                        revision=revision+1, updated_at=now()
                    WHERE publication_id=%s
                    RETURNING revision
                    """,
                    (next_status, actor_id, reason or None, next_status, next_status, publication_id),
                )
            ).fetchone()
            material = await (
                await connection.execute(
                    """
                    UPDATE material SET revision=revision+1, updated_at=now()
                    WHERE material_id=%s RETURNING revision
                    """,
                    (current["material_id"],),
                )
            ).fetchone()
            await connection.execute(
                """
                INSERT INTO sync_change(owner_id, entity_type, entity_id, operation, revision)
                VALUES (%s, 'material', %s, 'upsert', %s)
                """,
                (current["owner_id"], current["material_id"], int(material["revision"])),
            )
            removed_imports = 0
            if action == "remove":
                imports = await (
                    await connection.execute(
                        """
                        SELECT i.owner_id, i.material_id, m.revision
                        FROM public_material_import i
                        JOIN material m ON m.material_id=i.material_id AND m.deleted_at IS NULL
                        WHERE i.publication_id=%s
                        FOR UPDATE OF i, m
                        """,
                        (publication_id,),
                    )
                ).fetchall()
                for imported in imports:
                    next_revision = int(imported["revision"]) + 1
                    await connection.execute(
                        """
                        UPDATE material
                        SET revision=%s, deleted_at=now(), updated_at=now()
                        WHERE material_id=%s
                        """,
                        (next_revision, imported["material_id"]),
                    )
                    await connection.execute(
                        """
                        INSERT INTO sync_change(owner_id, entity_type, entity_id, operation, revision)
                        VALUES (%s, 'material', %s, 'delete', %s)
                        """,
                        (imported["owner_id"], imported["material_id"], next_revision),
                    )
                    removed_imports += 1
        return {
            "publication_id": publication_id,
            "material_id": str(current["material_id"]),
            "status": next_status,
            "revision": int(publication["revision"]),
            "material_revision": int(material["revision"]),
            "removed_imports": removed_imports,
        }

    async def resolve_materials(
        self, user_id: str, material_ids: list[str]
    ) -> list[dict[str, Any]]:
        if not material_ids:
            return []
        async with self.connection(user_id) as connection:
            rows = await (
                await connection.execute(
                    """
                    SELECT m.*, a.origin, a.mime_type, av.source_sha256, av.source_size,
                           av.cloud_status, av.last_error,
                           an.analysis_status, an.vector_sync_status,
                           p.status AS publication_status,
                           p.publication_id,
                           p.revision AS publication_revision,
                           p.review_reason AS publication_review_reason
                    FROM material m
                    JOIN asset a ON a.asset_id=m.asset_id
                    JOIN asset_version av ON av.asset_id=m.asset_id AND av.asset_version=m.asset_version
                    LEFT JOIN LATERAL (
                        SELECT candidate.* FROM analysis candidate
                        WHERE candidate.asset_id=m.asset_id
                          AND candidate.asset_version=m.asset_version
                          AND (candidate.analysis_status <> 'completed' OR (
                              candidate.chunk_count > 0
                              AND candidate.chunk_count = (
                                  SELECT count(*) FROM analysis_chunk chunk
                                  WHERE chunk.analysis_id=candidate.analysis_id
                              )
                          ))
                        ORDER BY (candidate.analysis_status='completed') DESC,
                                 candidate.updated_at DESC, candidate.analysis_id DESC
                        LIMIT 1
                    ) an ON TRUE
                    LEFT JOIN material_publication p ON p.material_id=m.material_id AND p.removed_at IS NULL
                    WHERE m.material_id = ANY(%s) AND m.deleted_at IS NULL
                    """,
                    (material_ids,),
                )
            ).fetchall()
        by_id = {
            str(row["material_id"]): self._material_dto(dict(row), include_hash=True)
            for row in rows
        }
        return [by_id[item_id] for item_id in material_ids if item_id in by_id]

    async def resolve_folder_materials(
        self, user_id: str, folder_id: str, *, include_subfolders: bool
    ) -> dict[str, Any]:
        async with self.connection(user_id) as connection:
            folder = await (
                await connection.execute(
                    """
                    SELECT folder_id FROM material_folder
                    WHERE folder_id=%s AND deleted_at IS NULL
                    """,
                    (folder_id,),
                )
            ).fetchone()
            if not folder:
                return {"exists": False, "materials": []}
            if include_subfolders:
                rows = await (
                    await connection.execute(
                        """
                        WITH RECURSIVE folder_tree AS (
                            SELECT folder_id
                            FROM material_folder
                            WHERE folder_id=%s AND deleted_at IS NULL
                            UNION ALL
                            SELECT child.folder_id
                            FROM material_folder child
                            JOIN folder_tree parent ON child.parent_folder_id=parent.folder_id
                            WHERE child.deleted_at IS NULL
                        )
                        SELECT m.*, a.origin, a.mime_type,
                               av.source_sha256, av.source_size,
                               av.cloud_status, av.last_error,
                               an.analysis_status, an.vector_sync_status,
                               p.status AS publication_status,
                               p.publication_id,
                               p.revision AS publication_revision,
                               p.review_reason AS publication_review_reason
                        FROM material m
                        JOIN folder_tree tree ON tree.folder_id=m.folder_id
                        JOIN asset a ON a.asset_id=m.asset_id
                        JOIN asset_version av
                          ON av.asset_id=m.asset_id AND av.asset_version=m.asset_version
                        LEFT JOIN LATERAL (
                        SELECT candidate.* FROM analysis candidate
                        WHERE candidate.asset_id=m.asset_id
                          AND candidate.asset_version=m.asset_version
                          AND (candidate.analysis_status <> 'completed' OR (
                              candidate.chunk_count > 0
                              AND candidate.chunk_count = (
                                  SELECT count(*) FROM analysis_chunk chunk
                                  WHERE chunk.analysis_id=candidate.analysis_id
                              )
                          ))
                        ORDER BY (candidate.analysis_status='completed') DESC,
                                 candidate.updated_at DESC, candidate.analysis_id DESC
                        LIMIT 1
                    ) an ON TRUE
                        LEFT JOIN material_publication p
                          ON p.material_id=m.material_id AND p.removed_at IS NULL
                        WHERE m.deleted_at IS NULL
                        ORDER BY m.material_id
                        LIMIT 501
                        """,
                        (folder_id,),
                    )
                ).fetchall()
            else:
                rows = await (
                    await connection.execute(
                        """
                        SELECT m.*, a.origin, a.mime_type,
                               av.source_sha256, av.source_size,
                               av.cloud_status, av.last_error,
                               an.analysis_status, an.vector_sync_status,
                               p.status AS publication_status,
                               p.publication_id,
                               p.revision AS publication_revision,
                               p.review_reason AS publication_review_reason
                        FROM material m
                        JOIN asset a ON a.asset_id=m.asset_id
                        JOIN asset_version av
                          ON av.asset_id=m.asset_id AND av.asset_version=m.asset_version
                        LEFT JOIN LATERAL (
                        SELECT candidate.* FROM analysis candidate
                        WHERE candidate.asset_id=m.asset_id
                          AND candidate.asset_version=m.asset_version
                          AND (candidate.analysis_status <> 'completed' OR (
                              candidate.chunk_count > 0
                              AND candidate.chunk_count = (
                                  SELECT count(*) FROM analysis_chunk chunk
                                  WHERE chunk.analysis_id=candidate.analysis_id
                              )
                          ))
                        ORDER BY (candidate.analysis_status='completed') DESC,
                                 candidate.updated_at DESC, candidate.analysis_id DESC
                        LIMIT 1
                    ) an ON TRUE
                        LEFT JOIN material_publication p
                          ON p.material_id=m.material_id AND p.removed_at IS NULL
                        WHERE m.folder_id=%s AND m.deleted_at IS NULL
                        ORDER BY m.material_id
                        LIMIT 501
                        """,
                        (folder_id,),
                    )
                ).fetchall()
        return {
            "exists": True,
            "materials": [
                self._material_dto(dict(row), include_hash=True) for row in rows
            ],
        }

    @staticmethod
    def _generation_run_dto(row: dict[str, Any], *, created: bool | None = None) -> dict[str, Any]:
        error = None
        if row.get("error_code") or row.get("error_message"):
            error = {
                "code": row.get("error_code"),
                "message": row.get("error_message"),
                "shot_id": row.get("current_shot_id"),
                "material_id": row.get("current_material_id"),
            }
        result: dict[str, Any] = {
            "run_id": row["run_id"],
            "task_id": row["task_id"],
            "task_revision": int(row["task_revision"]),
            "status": row["status"],
            "stage": row["stage"],
            "progress": float(row["progress"]),
            "revision": int(row["revision"]),
            "manifest_checksum": row["manifest_checksum"],
            "error": error,
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "started_at": row.get("started_at"),
            "finished_at": row.get("finished_at"),
        }
        if created is not None:
            result["created"] = created
        return result

    async def create_generation_run(
        self,
        user_id: str,
        *,
        device_id: str,
        run_id: str,
        task_id: str,
        task_revision: int,
        request_checksum: str,
        manifest_checksum: str,
        shots: list[dict[str, Any]],
    ) -> dict[str, Any]:
        async with self.connection(user_id) as connection:
            inserted = await (
                await connection.execute(
                    """
                    INSERT INTO generation_run(
                        run_id, owner_id, device_id, task_id, task_revision,
                        request_checksum, manifest_checksum
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT(owner_id, task_id, task_revision) DO NOTHING
                    RETURNING *
                    """,
                    (
                        run_id,
                        user_id,
                        device_id,
                        task_id,
                        task_revision,
                        request_checksum,
                        manifest_checksum,
                    ),
                )
            ).fetchone()
            if not inserted:
                existing = await (
                    await connection.execute(
                        """
                        SELECT * FROM generation_run
                        WHERE owner_id=%s AND task_id=%s AND task_revision=%s
                        """,
                        (user_id, task_id, task_revision),
                    )
                ).fetchone()
                if not existing:
                    raise ServiceError(409, "run_id_conflict", "生成运行标识已被占用")
                if existing["request_checksum"] != request_checksum:
                    raise ServiceError(
                        409,
                        "task_revision_conflict",
                        "相同任务修订已经固化为另一份素材清单",
                        action="save_new_task_revision",
                        details={"existing_run_id": str(existing["run_id"])},
                    )
                return self._generation_run_dto(dict(existing), created=False)

            for shot_order, shot in enumerate(shots):
                await connection.execute(
                    """
                    INSERT INTO render_material_snapshot(
                        run_id, shot_id, owner_id, download_material,
                        checksum, shot_order
                    ) VALUES (%s, %s, %s, %s, %s, %s)
                    """,
                    (
                        run_id,
                        shot["shot_id"],
                        user_id,
                        shot["download_material"],
                        shot["checksum"],
                        shot_order,
                    ),
                )
                for material_order, material in enumerate(shot["materials"]):
                    await connection.execute(
                        """
                        INSERT INTO render_material_snapshot_item(
                            run_id, shot_id, material_id, asset_id,
                            asset_version, source_sha256, material_order
                        ) VALUES (%s, %s, %s, %s, %s, %s, %s)
                        """,
                        (
                            run_id,
                            shot["shot_id"],
                            material["material_id"],
                            material["asset_id"],
                            material["asset_version"],
                            material["source_sha256"],
                            material_order,
                        ),
                    )
        return self._generation_run_dto(dict(inserted), created=True)

    async def reuse_generation_run(
        self,
        user_id: str,
        *,
        task_id: str,
        task_revision: int,
        request_checksum: str,
    ) -> dict[str, Any] | None:
        async with self.connection(user_id) as connection:
            row = await (
                await connection.execute(
                    """
                    SELECT * FROM generation_run
                    WHERE owner_id=%s AND task_id=%s AND task_revision=%s
                    """,
                    (user_id, task_id, task_revision),
                )
            ).fetchone()
        if not row:
            return None
        if row["request_checksum"] != request_checksum:
            raise ServiceError(
                409,
                "task_revision_conflict",
                "相同任务修订已经固化为另一份素材清单",
                action="save_new_task_revision",
                details={"existing_run_id": str(row["run_id"])},
            )
        return self._generation_run_dto(dict(row), created=False)

    async def get_generation_run(self, user_id: str, run_id: str) -> dict[str, Any]:
        async with self.connection(user_id) as connection:
            row = await (
                await connection.execute(
                    "SELECT * FROM generation_run WHERE run_id=%s",
                    (run_id,),
                )
            ).fetchone()
        if not row:
            raise ServiceError(404, "generation_run_not_found", "生成运行不存在")
        return self._generation_run_dto(dict(row))

    async def update_generation_run(
        self,
        user_id: str,
        run_id: str,
        *,
        expected_revision: int,
        status: str,
        stage: str,
        progress: float,
        current_shot_id: str | None,
        current_material_id: str | None,
        error_code: str | None,
        error_message: str | None,
    ) -> dict[str, Any]:
        async with self.connection(user_id) as connection:
            current = await (
                await connection.execute(
                    "SELECT * FROM generation_run WHERE run_id=%s FOR UPDATE",
                    (run_id,),
                )
            ).fetchone()
            if not current:
                raise ServiceError(404, "generation_run_not_found", "生成运行不存在")
            current_revision = int(current["revision"])
            if current_revision != expected_revision:
                raise ServiceError(
                    409,
                    "generation_run_revision_conflict",
                    "生成运行状态已更新，请刷新后重试",
                    action="refresh",
                    details={
                        "current_revision": current_revision,
                        "current_status": str(current["status"]),
                    },
                )
            terminal = {"succeeded", "failed", "canceled"}
            if str(current["status"]) in terminal:
                if str(current["status"]) == status:
                    return self._generation_run_dto(dict(current))
                raise ServiceError(409, "generation_run_terminal", "生成运行已结束，状态不能再修改")
            if progress < float(current["progress"]):
                raise ServiceError(409, "generation_progress_regression", "生成进度不能倒退")
            if current_shot_id:
                shot = await (
                    await connection.execute(
                        """
                        SELECT 1 FROM render_material_snapshot
                        WHERE run_id=%s AND shot_id=%s
                        """,
                        (run_id, current_shot_id),
                    )
                ).fetchone()
                if not shot:
                    raise ServiceError(422, "generation_shot_invalid", "运行状态包含未知分镜")
            if current_material_id:
                if not current_shot_id:
                    raise ServiceError(
                        422,
                        "generation_material_without_shot",
                        "上报当前素材时必须同时提供分镜",
                    )
                material = await (
                    await connection.execute(
                        """
                        SELECT 1 FROM render_material_snapshot_item
                        WHERE run_id=%s AND shot_id=%s AND material_id=%s
                        """,
                        (run_id, current_shot_id, current_material_id),
                    )
                ).fetchone()
                if not material:
                    raise ServiceError(422, "generation_material_invalid", "运行状态包含未知素材")
            next_revision = current_revision + 1
            finished = status in terminal
            updated = await (
                await connection.execute(
                    """
                    UPDATE generation_run
                    SET status=%s, stage=%s, progress=%s, revision=%s,
                        current_shot_id=%s, current_material_id=%s,
                        error_code=%s, error_message=%s,
                        started_at=coalesce(started_at, now()),
                        finished_at=CASE WHEN %s THEN coalesce(finished_at, now()) ELSE NULL END,
                        updated_at=now()
                    WHERE run_id=%s
                    RETURNING *
                    """,
                    (
                        status,
                        stage,
                        progress,
                        next_revision,
                        current_shot_id,
                        current_material_id,
                        error_code,
                        error_message,
                        finished,
                        run_id,
                    ),
                )
            ).fetchone()
            await connection.execute(
                """
                INSERT INTO generation_run_event(
                    owner_id, run_id, revision, status, stage, progress,
                    current_shot_id, current_material_id, error_code, error_message
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    user_id,
                    run_id,
                    next_revision,
                    status,
                    stage,
                    progress,
                    current_shot_id,
                    current_material_id,
                    error_code,
                    error_message,
                ),
            )
        return self._generation_run_dto(dict(updated))

    async def get_generation_manifest(self, user_id: str, run_id: str) -> dict[str, Any]:
        async with self.connection(user_id) as connection:
            run = await (
                await connection.execute(
                    "SELECT * FROM generation_run WHERE run_id=%s",
                    (run_id,),
                )
            ).fetchone()
            if not run:
                raise ServiceError(404, "generation_run_not_found", "生成运行不存在")
            snapshots = await (
                await connection.execute(
                    """
                    SELECT shot_id, download_material, checksum, shot_order, created_at
                    FROM render_material_snapshot
                    WHERE run_id=%s
                    ORDER BY shot_order, shot_id
                    """,
                    (run_id,),
                )
            ).fetchall()
            items = await (
                await connection.execute(
                    """
                    SELECT shot_id, material_id, asset_id, asset_version,
                           source_sha256, material_order
                    FROM render_material_snapshot_item
                    WHERE run_id=%s
                    ORDER BY shot_id, material_order, material_id
                    """,
                    (run_id,),
                )
            ).fetchall()
        by_shot: dict[str, list[dict[str, Any]]] = {}
        for row in items:
            by_shot.setdefault(str(row["shot_id"]), []).append(
                {
                    "material_id": row["material_id"],
                    "asset_id": row["asset_id"],
                    "asset_version": int(row["asset_version"]),
                    "source_sha256": row["source_sha256"],
                }
            )
        return {
            "schema_version": 1,
            "run_id": run["run_id"],
            "task_id": run["task_id"],
            "task_revision": int(run["task_revision"]),
            "manifest_checksum": run["manifest_checksum"],
            "created_at": run["created_at"],
            "shots": [
                {
                    "shot_id": row["shot_id"],
                    "download_material": bool(row["download_material"]),
                    "checksum": row["checksum"],
                    "materials": by_shot.get(str(row["shot_id"]), []),
                }
                for row in snapshots
            ],
        }

    async def freeze_material_snapshot(
        self,
        user_id: str,
        *,
        run_id: str,
        shot_id: str,
        download_material: bool,
        materials: list[dict[str, Any]],
        checksum: str,
    ) -> dict[str, Any]:
        async with self.connection(user_id) as connection:
            existing = await (
                await connection.execute(
                    """
                    SELECT checksum FROM render_material_snapshot
                    WHERE run_id=%s AND shot_id=%s
                    """,
                    (run_id, shot_id),
                )
            ).fetchone()
            if existing:
                if existing["checksum"] != checksum:
                    raise ServiceError(409, "snapshot_conflict", "该分镜已冻结为另一组素材")
                return {"created": False, "checksum": checksum}
            await connection.execute(
                """
                INSERT INTO render_material_snapshot(
                    run_id, shot_id, owner_id, download_material, checksum
                ) VALUES (%s, %s, %s, %s, %s)
                """,
                (run_id, shot_id, user_id, download_material, checksum),
            )
            for item in materials:
                await connection.execute(
                    """
                    INSERT INTO render_material_snapshot_item(
                        run_id, shot_id, material_id, asset_id, asset_version, source_sha256
                    ) VALUES (%s, %s, %s, %s, %s, %s)
                    """,
                    (
                        run_id,
                        shot_id,
                        item["material_id"],
                        item["asset_id"],
                        item["asset_version"],
                        item["source_sha256"],
                    ),
                )
            return {"created": True, "checksum": checksum}

    async def create_upload_session(
        self,
        user_id: str,
        device_id: str,
        upload_session_id: str,
        material_id: str,
        upload_mode: str,
        part_size: int,
        expires_at: datetime,
    ) -> dict[str, Any]:
        material = await self.get_material(user_id, material_id)
        if material["cloud_status"] == "ready":
            return {"reuse": True, "material": material}
        if material["cloud_status"] == "deleting":
            raise ServiceError(409, "cloud_copy_delete_in_progress", "云端副本正在删除")
        async with self.connection(user_id) as connection:
            await connection.execute(
                """
                INSERT INTO upload_session(
                    upload_session_id, owner_id, device_id, material_id,
                    asset_id, asset_version, upload_mode, part_size_bytes,
                    expected_size, source_sha256, status, expires_at
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'created', %s)
                """,
                (
                    upload_session_id,
                    user_id,
                    device_id,
                    material_id,
                    material["asset_id"],
                    material["asset_version"],
                    upload_mode,
                    part_size,
                    material["file_size_bytes"],
                    material["source_sha256"],
                    expires_at,
                ),
            )
            await connection.execute(
                """
                UPDATE asset_version
                SET cloud_status='uploading', cloud_delete_operation_id=NULL,
                    last_error=NULL, updated_at=now()
                WHERE asset_id=%s AND asset_version=%s
                """,
                (material["asset_id"], material["asset_version"]),
            )
        return {"reuse": False, "material": material}

    async def get_upload_session(self, user_id: str, session_id: str) -> dict[str, Any]:
        async with self.connection(user_id) as connection:
            row = await (
                await connection.execute(
                    "SELECT * FROM upload_session WHERE upload_session_id=%s", (session_id,)
                )
            ).fetchone()
        if not row:
            raise ServiceError(404, "upload_session_not_found", "上传会话不存在")
        return dict(row)

    async def upload_session_progress(self, user_id: str, session_id: str) -> dict[str, Any]:
        session = await self.get_upload_session(user_id, session_id)
        async with self.connection(user_id) as connection:
            parts = await (
                await connection.execute(
                    """
                    SELECT part_number, size_bytes, checksum_sha256, etag, completed_at
                    FROM upload_part
                    WHERE upload_session_id=%s
                    ORDER BY part_number
                    """,
                    (session_id,),
                )
            ).fetchall()
        session["completed_parts"] = [dict(row) for row in parts]
        session["uploaded_bytes"] = sum(int(row["size_bytes"]) for row in parts)
        return session

    async def resume_upload_session(
        self,
        user_id: str,
        session_id: str,
        *,
        expires_at: datetime,
        internal_parts: list[dict[str, Any]],
    ) -> dict[str, Any]:
        async with self.connection(user_id) as connection:
            session = await (
                await connection.execute(
                    "SELECT * FROM upload_session WHERE upload_session_id=%s FOR UPDATE",
                    (session_id,),
                )
            ).fetchone()
            if not session:
                raise ServiceError(404, "upload_session_not_found", "上传会话不存在")
            existing = await (
                await connection.execute(
                    """
                    SELECT part_number, size_bytes, etag
                    FROM upload_part
                    WHERE upload_session_id=%s
                    ORDER BY part_number
                    """,
                    (session_id,),
                )
            ).fetchall()
            internal_by_number = {
                int(item["part_number"]): item for item in internal_parts
            }
            for part in existing:
                internal = internal_by_number.get(int(part["part_number"]))
                if (
                    not internal
                    or int(internal["size_bytes"]) != int(part["size_bytes"])
                    or str(internal.get("etag") or "").strip('"')
                    != str(part["etag"] or "").strip('"')
                ):
                    raise ServiceError(
                        409,
                        "upload_part_state_conflict",
                        "上传分片记录与存储服务不一致，请取消后重新上传",
                    )
            for part_number, item in internal_by_number.items():
                await connection.execute(
                    """
                    INSERT INTO upload_part(
                        upload_session_id, part_number, size_bytes,
                        checksum_sha256, etag, recovered_at
                    ) VALUES (%s, %s, %s, NULL, %s, now())
                    ON CONFLICT(upload_session_id, part_number) DO NOTHING
                    """,
                    (
                        session_id,
                        part_number,
                        int(item["size_bytes"]),
                        str(item.get("etag") or "").strip('"'),
                    ),
                )
            await connection.execute(
                """
                UPDATE upload_session
                SET status='created', expires_at=%s, updated_at=now()
                WHERE upload_session_id=%s
                """,
                (expires_at, session_id),
            )
        return await self.upload_session_progress(user_id, session_id)

    async def list_verifying_uploads(self, user_id: str, limit: int = 20) -> list[str]:
        async with self.connection(user_id) as connection:
            rows = await (
                await connection.execute(
                    """
                    SELECT upload_session_id FROM upload_session
                    WHERE owner_id=%s AND status='verifying'
                    ORDER BY updated_at
                    LIMIT %s
                    """,
                    (user_id, limit),
                )
            ).fetchall()
        return [str(row["upload_session_id"]) for row in rows]

    async def cancel_upload_session(self, user_id: str, session_id: str) -> None:
        session = await self.get_upload_session(user_id, session_id)
        if session["status"] in {"verifying", "ready"}:
            raise ServiceError(409, "upload_cannot_cancel", "当前上传状态不能取消")
        async with self.connection(user_id) as connection:
            await connection.execute(
                """
                UPDATE upload_session
                SET status='canceled', updated_at=now()
                WHERE upload_session_id=%s
                """,
                (session_id,),
            )
            await connection.execute(
                """
                UPDATE asset_version
                SET cloud_status='not_uploaded', last_error=NULL, updated_at=now()
                WHERE asset_id=%s AND asset_version=%s
                """,
                (session["asset_id"], session["asset_version"]),
            )

    async def attach_internal_upload(
        self,
        user_id: str,
        session_id: str,
        internal_session_id: str,
        expires_at: datetime,
        part_size: int | None = None,
    ) -> None:
        async with self.connection(user_id) as connection:
            await connection.execute(
                """
                UPDATE upload_session
                SET internal_upload_session_id=%s, expires_at=%s,
                    part_size_bytes=coalesce(%s, part_size_bytes), updated_at=now()
                WHERE upload_session_id=%s
                """,
                (internal_session_id, expires_at, part_size, session_id),
            )

    async def complete_part(
        self,
        user_id: str,
        session_id: str,
        part_number: int,
        size_bytes: int,
        checksum: str,
        etag: str,
    ) -> None:
        await self.get_upload_session(user_id, session_id)
        async with self.connection(user_id) as connection:
            await connection.execute(
                """
                INSERT INTO upload_part(upload_session_id, part_number, size_bytes, checksum_sha256, etag)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT(upload_session_id, part_number) DO UPDATE SET
                    size_bytes=excluded.size_bytes,
                    checksum_sha256=excluded.checksum_sha256,
                    etag=excluded.etag,
                    completed_at=now()
                """,
                (session_id, part_number, size_bytes, checksum, etag),
            )

    async def list_sync_changes(
        self, user_id: str, *, after_sequence: int, limit: int
    ) -> tuple[list[dict[str, Any]], int | None]:
        async with self.connection(user_id) as connection:
            rows = await (
                await connection.execute(
                    """
                    SELECT sequence_id, entity_type, entity_id, operation, revision, created_at
                    FROM sync_change
                    WHERE owner_id=%s AND sequence_id>%s
                    ORDER BY sequence_id
                    LIMIT %s
                    """,
                    (user_id, after_sequence, limit + 1),
                )
            ).fetchall()
        has_more = len(rows) > limit
        page = [dict(row) for row in rows[:limit]]
        next_cursor = int(page[-1]["sequence_id"]) if page else None
        return page, next_cursor if has_more else None

    async def mark_upload_verifying(self, user_id: str, session_id: str) -> None:
        session = await self.get_upload_session(user_id, session_id)
        async with self.connection(user_id) as connection:
            await connection.execute(
                "UPDATE upload_session SET status='verifying', updated_at=now() WHERE upload_session_id=%s",
                (session_id,),
            )
            await connection.execute(
                """
                UPDATE asset_version SET cloud_status='verifying', updated_at=now()
                WHERE asset_id=%s AND asset_version=%s
                """,
                (session["asset_id"], session["asset_version"]),
            )

    async def mark_upload_result(
        self, user_id: str, session_id: str, *, ready: bool, error: str = ""
    ) -> None:
        session = await self.get_upload_session(user_id, session_id)
        status = "ready" if ready else "failed"
        async with self.connection(user_id) as connection:
            await connection.execute(
                """
                UPDATE upload_session SET status=%s, last_error=%s, updated_at=now()
                WHERE upload_session_id=%s
                """,
                (status, error or None, session_id),
            )
            await connection.execute(
                """
                WITH changed_asset AS (
                    UPDATE asset_version
                    SET cloud_status=%s, storage_session_id=%s, verified_at=%s,
                        last_error=%s, updated_at=now()
                    WHERE asset_id=%s AND asset_version=%s
                      AND (cloud_status IS DISTINCT FROM %s
                           OR storage_session_id IS DISTINCT FROM %s
                           OR last_error IS DISTINCT FROM %s)
                    RETURNING asset_id, asset_version
                ), changed_materials AS (
                    UPDATE material m SET revision=m.revision+1, updated_at=now()
                    FROM changed_asset a
                    WHERE m.asset_id=a.asset_id AND m.asset_version=a.asset_version
                      AND m.owner_id=%s AND m.deleted_at IS NULL
                    RETURNING m.owner_id, m.material_id, m.revision
                )
                INSERT INTO sync_change(owner_id, entity_type, entity_id, operation, revision)
                SELECT owner_id, 'material', material_id, 'upsert', revision
                FROM changed_materials
                """,
                (
                    status,
                    session["internal_upload_session_id"] if ready else None,
                    datetime.now(UTC) if ready else None,
                    error or None,
                    session["asset_id"],
                    session["asset_version"],
                    status,
                    session["internal_upload_session_id"] if ready else None,
                    error or None,
                    user_id,
                ),
            )

    async def storage_session_for_material(self, user_id: str, material_id: str) -> dict[str, Any]:
        async with self.connection(user_id) as connection:
            row = await (
                await connection.execute(
                    """
                    SELECT m.material_id, a.mime_type, av.source_sha256, av.source_size,
                           av.cloud_status, av.storage_session_id
                    FROM material m
                    JOIN asset a ON a.asset_id=m.asset_id
                    JOIN asset_version av ON av.asset_id=m.asset_id AND av.asset_version=m.asset_version
                    WHERE m.material_id=%s AND m.deleted_at IS NULL
                    """,
                    (material_id,),
                )
            ).fetchone()
        if not row:
            raise ServiceError(404, "material_not_found", "素材不存在")
        if row["cloud_status"] != "ready" or not row["storage_session_id"]:
            raise ServiceError(409, "cloud_copy_not_ready", "素材云端文件尚未就绪")
        return dict(row)

    async def search_pgvector(
        self,
        user_id: str,
        embedding: list[float],
        limit: int,
        folder_id: str | None = None,
    ) -> list[dict[str, Any]]:
        vector = "[" + ",".join(f"{value:.9g}" for value in embedding) + "]"
        async with self.connection(user_id) as connection:
            rows = await (
                await connection.execute(
                    """
                    SELECT m.material_id, m.asset_id, ac.chunk_id, ac.start_ms, ac.end_ms, ac.caption,
                           1 - (ac.embedding <=> %s::vector) AS score
                    FROM material m
                    JOIN asset_version av ON av.asset_id=m.asset_id AND av.asset_version=m.asset_version
                    JOIN analysis an ON an.asset_id=m.asset_id AND an.asset_version=m.asset_version
                    JOIN analysis_chunk ac ON ac.analysis_id=an.analysis_id
                    WHERE m.deleted_at IS NULL
                      AND av.cloud_status='ready'
                      AND an.analysis_status='completed'
                      AND an.chunk_count > 0
                      AND an.chunk_count = (
                          SELECT count(*) FROM analysis_chunk valid_chunk
                          WHERE valid_chunk.analysis_id=an.analysis_id
                      )
                      AND (%s::text IS NULL OR m.folder_id=%s::text)
                    ORDER BY ac.embedding <=> %s::vector
                    LIMIT %s
                    """,
                    (vector, folder_id, folder_id, vector, limit),
                )
            ).fetchall()
        return [dict(row) for row in rows]

    async def ensure_analysis(
        self,
        user_id: str,
        material_id: str,
        *,
        profile_id: str,
        model_name: str,
        dimension: int,
    ) -> dict[str, Any]:
        material = await self.get_material(user_id, material_id)
        if material["cloud_status"] != "ready":
            return {
                "material_id": material_id,
                "analysis_status": "blocked",
                "reason": "cloud_copy_not_ready",
            }
        analysis_id = f"ana_{material['asset_id']}_{material['asset_version']}_{profile_id}"
        async with self.connection(user_id) as connection:
            row = await (
                await connection.execute(
                    """
                    INSERT INTO analysis(
                        analysis_id, asset_id, asset_version, analysis_profile_id,
                        model_name, dimension, requested_by_owner_id,
                        requested_material_id
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT(asset_id, asset_version, analysis_profile_id) DO UPDATE SET
                        requested_by_owner_id=CASE
                            WHEN analysis.analysis_status='completed'
                              THEN analysis.requested_by_owner_id
                            ELSE excluded.requested_by_owner_id END,
                        requested_material_id=CASE
                            WHEN analysis.analysis_status='completed'
                              THEN analysis.requested_material_id
                            ELSE excluded.requested_material_id END,
                        updated_at=now()
                    RETURNING analysis_id, analysis_status, vector_sync_status,
                              chunk_count, last_error
                    """,
                    (
                        analysis_id,
                        material["asset_id"],
                        material["asset_version"],
                        profile_id,
                        model_name,
                        dimension,
                        user_id,
                        material_id,
                    ),
                )
            ).fetchone()
        return {"material_id": material_id, **dict(row)}

    async def claim_analyses(
        self, *, worker_id: str, limit: int, lease_seconds: int = 900
    ) -> list[dict[str, Any]]:
        async with self.maintenance_connection() as connection:
            rows = await (
                await connection.execute(
                    """
                    SELECT analysis_id, asset_id, asset_version, analysis_profile_id,
                           model_name, dimension, requested_by_owner_id,
                           requested_material_id
                    FROM analysis
                    WHERE requested_by_owner_id IS NOT NULL
                      AND requested_material_id IS NOT NULL
                      AND (
                        analysis_status='pending'
                        OR (analysis_status='analyzing' AND lease_expires_at<now())
                      )
                    ORDER BY created_at
                    FOR UPDATE SKIP LOCKED
                    LIMIT %s
                    """,
                    (limit,),
                )
            ).fetchall()
            claimed: list[dict[str, Any]] = []
            for row in rows:
                await connection.execute(
                    """
                    UPDATE analysis
                    SET analysis_status='analyzing', lease_owner=%s,
                        lease_expires_at=now()+(%s * interval '1 second'),
                        attempt_count=attempt_count+1, last_error=NULL, updated_at=now()
                    WHERE analysis_id=%s
                    """,
                    (worker_id, lease_seconds, row["analysis_id"]),
                )
                claimed.append(dict(row))
            return claimed

    async def complete_analysis(
        self,
        *,
        analysis_id: str,
        worker_id: str,
        chunks: list[dict[str, Any]],
    ) -> None:
        async with self.maintenance_connection() as connection:
            analysis = await (
                await connection.execute(
                    """
                    SELECT analysis_id, lease_owner, lease_expires_at,
                           requested_by_owner_id
                    FROM analysis WHERE analysis_id=%s
                    FOR UPDATE
                    """,
                    (analysis_id,),
                )
            ).fetchone()
            if not analysis:
                raise ServiceError(404, "analysis_not_found", "分析任务不存在")
            if analysis["lease_owner"] != worker_id:
                raise ServiceError(409, "analysis_lease_conflict", "分析任务租约不属于当前工作器")
            await connection.execute(
                "DELETE FROM analysis_chunk WHERE analysis_id=%s", (analysis_id,)
            )
            for chunk in chunks:
                vector = "[" + ",".join(f"{value:.9g}" for value in chunk["embedding"]) + "]"
                await connection.execute(
                    """
                    INSERT INTO analysis_chunk(
                        analysis_id, chunk_id, start_ms, end_ms, caption,
                        embedding, cloud_vector_status
                    ) VALUES (%s, %s, %s, %s, %s, %s::vector, 'pending')
                    """,
                    (
                        analysis_id,
                        chunk["chunk_id"],
                        chunk["start_ms"],
                        chunk["end_ms"],
                        chunk["caption"],
                        vector,
                    ),
                )
            await connection.execute(
                """
                UPDATE analysis
                SET analysis_status='completed', vector_sync_status='pending',
                    chunk_count=%s, lease_owner=NULL, lease_expires_at=NULL,
                    last_error=NULL, updated_at=now()
                WHERE analysis_id=%s
                """,
                (len(chunks), analysis_id),
            )
            await connection.execute(
                """
                INSERT INTO vector_outbox(analysis_id, status, next_retry_at)
                VALUES (%s, 'queued', now())
                ON CONFLICT(analysis_id) DO UPDATE SET
                    status='queued', next_retry_at=now(), last_error=NULL, updated_at=now()
                """,
                (analysis_id,),
            )
            await self._notify_analysis_materials(
                connection, analysis_id, analysis["requested_by_owner_id"]
            )

    async def _notify_analysis_materials(
        self, connection: Any, analysis_id: str, owner_id: str | None
    ) -> None:
        """Publish owned material aliases in the same analysis transaction.

        Background indexing uses a maintenance connection, but material and
        sync_change enforce RLS. Re-enter only the recorded requesting owner's
        scope, rather than bypassing RLS or leaking changes to another account.
        """
        if not owner_id:
            return
        await connection.execute(
            "SELECT set_config('app.user_id', %s, true)", (owner_id,)
        )
        await connection.execute(
            """
            WITH changed_materials AS (
                UPDATE material m
                SET revision=m.revision+1, updated_at=now()
                FROM analysis an
                WHERE an.analysis_id=%s
                  AND m.asset_id=an.asset_id AND m.asset_version=an.asset_version
                  AND m.owner_id=%s AND m.deleted_at IS NULL
                RETURNING m.owner_id, m.material_id, m.revision
            )
            INSERT INTO sync_change(owner_id, entity_type, entity_id, operation, revision)
            SELECT owner_id, 'material', material_id, 'upsert', revision
            FROM changed_materials
            """,
            (analysis_id, owner_id),
        )

    async def submit_client_analysis(
        self,
        *,
        user_id: str,
        device_id: str,
        material_id: str,
        payload: ClientAnalysisResultRequest,
    ) -> str:
        async with self.connection(user_id) as connection:
            material = await (
                await connection.execute(
                    """
                    SELECT m.asset_id, m.asset_version, av.source_sha256, av.source_size
                    FROM material m
                    JOIN asset_version av
                      ON av.asset_id=m.asset_id AND av.asset_version=m.asset_version
                    WHERE m.material_id=%s AND m.owner_id=%s AND m.deleted_at IS NULL
                    FOR UPDATE
                    """,
                    (material_id, user_id),
                )
            ).fetchone()
            if not material:
                raise ServiceError(404, "material_not_found", "素材不存在")
            if (
                material["asset_id"] != payload.asset_id
                or int(material["asset_version"]) != payload.asset_version
                or material["source_sha256"] != payload.source_sha256
                or int(material["source_size"]) != payload.file_size_bytes
            ):
                raise ServiceError(409, "material_identity_conflict", "分析结果与素材文件身份不一致")

            existing = await (
                await connection.execute(
                    """
                    SELECT analysis_id, embedding_backend, model_name, model_version, dimension,
                           result_schema_version, analysis_provenance
                    FROM analysis
                    WHERE asset_id=%s AND asset_version=%s AND analysis_profile_id=%s
                    FOR UPDATE
                    """,
                    (
                        payload.asset_id,
                        payload.asset_version,
                        payload.analysis_profile_id,
                    ),
                )
            ).fetchone()
            if existing and (
                existing["embedding_backend"] != payload.embedding_backend
                or existing["model_name"] != payload.model_name
                or existing["model_version"] != payload.model_version
                or int(existing["dimension"]) != payload.dimension
                or int(existing["result_schema_version"]) != payload.result_schema_version
                or provenance_config(existing.get("analysis_provenance")) != provenance_config(payload.analysis_provenance)
            ):
                raise ServiceError(
                    409,
                    "analysis_profile_conflict",
                    "分析配置已变化，请使用新的 analysis_profile_id",
                )

            analysis_id = (
                str(existing["analysis_id"])
                if existing
                else f"ana_{payload.asset_id}_{payload.asset_version}_{payload.analysis_profile_id}"
            )
            await connection.execute(
                """
                INSERT INTO analysis(
                    analysis_id, asset_id, asset_version, analysis_profile_id,
                    embedding_backend, model_name, model_version, dimension,
                    result_schema_version, submitted_by_device_id,
                    requested_by_owner_id, requested_material_id,
                    analysis_status, vector_sync_status, chunk_count, last_error, analysis_provenance
                ) VALUES (
                    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                    'completed', 'pending', %s, NULL, %s::jsonb
                )
                ON CONFLICT(asset_id, asset_version, analysis_profile_id) DO UPDATE SET
                    result_schema_version=excluded.result_schema_version,
                    analysis_provenance=excluded.analysis_provenance,
                    submitted_by_device_id=excluded.submitted_by_device_id,
                    requested_by_owner_id=excluded.requested_by_owner_id,
                    requested_material_id=excluded.requested_material_id,
                    analysis_status='completed', vector_sync_status='pending',
                    chunk_count=excluded.chunk_count, lease_owner=NULL,
                    lease_expires_at=NULL, last_error=NULL, updated_at=now()
                """,
                (
                    analysis_id,
                    payload.asset_id,
                    payload.asset_version,
                    payload.analysis_profile_id,
                    payload.embedding_backend,
                    payload.model_name,
                    payload.model_version,
                    payload.dimension,
                    payload.result_schema_version,
                    device_id,
                    user_id,
                    material_id,
                    len(payload.chunks),
                    json.dumps(payload.analysis_provenance, allow_nan=False) if payload.analysis_provenance is not None else None,
                ),
            )
            await connection.execute(
                "DELETE FROM analysis_chunk WHERE analysis_id=%s", (analysis_id,)
            )
            for chunk in payload.chunks:
                vector = "[" + ",".join(f"{value:.9g}" for value in chunk.embedding) + "]"
                await connection.execute(
                    """
                    INSERT INTO analysis_chunk(
                        analysis_id, chunk_id, start_ms, end_ms, caption,
                        embedding, cloud_vector_status
                    ) VALUES (%s, %s, %s, %s, %s, %s::vector, 'pending')
                    """,
                    (
                        analysis_id,
                        chunk.chunk_id,
                        chunk.start_ms,
                        chunk.end_ms,
                        chunk.caption,
                        vector,
                    ),
                )
            await connection.execute(
                """
                INSERT INTO vector_outbox(analysis_id, status, next_retry_at)
                VALUES (%s, 'queued', now())
                ON CONFLICT(analysis_id) DO UPDATE SET
                    status='queued', attempt_count=0, next_retry_at=now(),
                    last_error=NULL, updated_at=now()
                """,
                (analysis_id,),
            )
            await self._notify_analysis_materials(connection, analysis_id, user_id)
        return analysis_id

    async def material_analysis_page(
        self,
        user_id: str,
        material_id: str,
        *,
        limit: int,
        cursor: str | None,
    ) -> dict[str, Any]:
        decoded = _analysis_cursor_decode(cursor)
        async with self.connection(user_id) as connection:
            material = await (
                await connection.execute(
                    """
                    SELECT m.asset_id, m.asset_version, av.source_sha256, av.source_size
                    FROM material m
                    JOIN asset_version av
                      ON av.asset_id=m.asset_id AND av.asset_version=m.asset_version
                    WHERE m.material_id=%s AND m.owner_id=%s AND m.deleted_at IS NULL
                    """,
                    (material_id, user_id),
                )
            ).fetchone()
            if not material:
                raise ServiceError(404, "material_not_found", "素材不存在")
            analysis = await (
                await connection.execute(
                    """
                    SELECT analysis_id, analysis_profile_id, embedding_backend,
                           model_name, model_version, dimension, result_schema_version,
                           updated_at, analysis_provenance
                    FROM analysis
                    WHERE asset_id=%s AND asset_version=%s AND analysis_status='completed'
                      AND chunk_count > 0
                      AND chunk_count = (
                          SELECT count(*) FROM analysis_chunk chunk
                          WHERE chunk.analysis_id=analysis.analysis_id
                      )
                    ORDER BY updated_at DESC, analysis_id DESC
                    LIMIT 1
                    """,
                    (material["asset_id"], material["asset_version"]),
                )
            ).fetchone()
            if not analysis:
                raise ServiceError(409, "analysis_not_ready", "素材分析结果尚未就绪")

            clauses = ["analysis_id=%s"]
            parameters: list[Any] = [analysis["analysis_id"]]
            if decoded:
                clauses.append("(start_ms, chunk_id)>(%s, %s)")
                parameters.extend(decoded)
            parameters.append(limit + 1)
            rows = await (
                await connection.execute(
                    f"""
                    SELECT chunk_id, start_ms, end_ms, caption, embedding::text AS embedding
                    FROM analysis_chunk
                    WHERE {' AND '.join(clauses)}
                    ORDER BY start_ms, chunk_id
                    LIMIT %s
                    """,
                    parameters,
                )
            ).fetchall()

        has_more = len(rows) > limit
        page = rows[:limit]
        next_cursor = (
            _analysis_cursor_encode(int(page[-1]["start_ms"]), str(page[-1]["chunk_id"]))
            if has_more and page
            else None
        )
        return {
            "material_id": material_id,
            "asset_id": material["asset_id"],
            "asset_version": int(material["asset_version"]),
            "source_sha256": material["source_sha256"],
            "file_size_bytes": int(material["source_size"]),
            "analysis_id": analysis["analysis_id"],
            "analysis_result_version": analysis["updated_at"],
            "analysis_profile_id": analysis["analysis_profile_id"],
            "embedding_backend": analysis["embedding_backend"],
            "model_name": analysis["model_name"],
            "model_version": analysis["model_version"],
            "dimension": int(analysis["dimension"]),
            "result_schema_version": int(analysis["result_schema_version"]),
            "analysis_provenance": analysis.get("analysis_provenance"),
            "chunks": [
                {**dict(row), "embedding": json.loads(row["embedding"])}
                for row in page
            ],
            "next_cursor": next_cursor,
            "has_more": has_more,
        }

    async def claim_vector_outbox(self, limit: int = 10) -> list[str]:
        async with self.maintenance_connection() as connection:
            rows = await (
                await connection.execute(
                    """
                    SELECT analysis_id FROM vector_outbox
                    WHERE status IN ('queued', 'failed') AND next_retry_at<=now()
                    ORDER BY updated_at
                    FOR UPDATE SKIP LOCKED
                    LIMIT %s
                    """,
                    (limit,),
                )
            ).fetchall()
            ids = [str(row["analysis_id"]) for row in rows]
            if ids:
                await connection.execute(
                    """
                    UPDATE vector_outbox SET status='processing', updated_at=now()
                    WHERE analysis_id=ANY(%s)
                    """,
                    (ids,),
                )
            return ids

    async def vector_payload(self, analysis_id: str) -> dict[str, Any]:
        async with self.maintenance_connection() as connection:
            analysis = await (
                await connection.execute(
                    """
                    SELECT analysis_id, asset_id, asset_version, analysis_profile_id
                    FROM analysis WHERE analysis_id=%s AND analysis_status='completed'
                    """,
                    (analysis_id,),
                )
            ).fetchone()
            if not analysis:
                raise ServiceError(404, "analysis_not_found", "分析任务不存在")
            rows = await (
                await connection.execute(
                    """
                    SELECT chunk_id, start_ms, end_ms, caption, embedding::text AS embedding
                    FROM analysis_chunk WHERE analysis_id=%s ORDER BY start_ms, chunk_id
                    """,
                    (analysis_id,),
                )
            ).fetchall()
        return {
            **dict(analysis),
            "chunks": [
                {**dict(row), "embedding": json.loads(row["embedding"])} for row in rows
            ],
        }

    async def mark_vector_outbox(
        self, analysis_id: str, *, completed: bool, error: str = ""
    ) -> None:
        async with self.maintenance_connection() as connection:
            if completed:
                await connection.execute(
                    """
                    UPDATE vector_outbox SET status='completed', last_error=NULL, updated_at=now()
                    WHERE analysis_id=%s
                    """,
                    (analysis_id,),
                )
                changed = await (
                    await connection.execute(
                        """
                        UPDATE analysis SET vector_sync_status='completed', updated_at=now()
                        WHERE analysis_id=%s AND vector_sync_status <> 'completed'
                        RETURNING requested_by_owner_id
                        """,
                        (analysis_id,),
                    )
                ).fetchone()
                await connection.execute(
                    """
                    UPDATE analysis_chunk SET cloud_vector_status='completed', updated_at=now()
                    WHERE analysis_id=%s
                    """,
                    (analysis_id,),
                )
                if changed:
                    await self._notify_analysis_materials(
                        connection, analysis_id, changed["requested_by_owner_id"]
                    )
                return
            await connection.execute(
                """
                UPDATE vector_outbox
                SET status='failed', attempt_count=attempt_count+1,
                    next_retry_at=now()+(
                      least(3600, 15 * power(2, least(8, attempt_count))) * interval '1 second'
                    ), last_error=%s, updated_at=now()
                WHERE analysis_id=%s
                """,
                (error[:1000], analysis_id),
            )
            await connection.execute(
                """
                UPDATE analysis SET vector_sync_status='failed', last_error=%s, updated_at=now()
                WHERE analysis_id=%s
                """,
                (error[:1000], analysis_id),
            )

    async def mark_pgvector_index_ready(self, analysis_id: str) -> None:
        async with self.maintenance_connection() as connection:
            analysis = await (
                await connection.execute(
                    """
                    SELECT analysis_status, chunk_count, vector_sync_status,
                           requested_by_owner_id
                    FROM analysis WHERE analysis_id=%s
                    FOR UPDATE
                    """,
                    (analysis_id,),
                )
            ).fetchone()
            if not analysis or analysis["analysis_status"] != "completed":
                raise ServiceError(409, "analysis_not_ready", "分析结果尚未完成")
            chunk_count = int(
                (
                    await (
                        await connection.execute(
                            "SELECT count(*) AS value FROM analysis_chunk WHERE analysis_id=%s",
                            (analysis_id,),
                        )
                    ).fetchone()
                )["value"]
            )
            if chunk_count <= 0 or chunk_count != int(analysis["chunk_count"]):
                raise ServiceError(
                    409,
                    "vector_index_incomplete",
                    "向量索引分段不完整",
                    retryable=True,
                )
            await connection.execute(
                """
                UPDATE analysis
                SET vector_sync_status='completed', last_error=NULL, updated_at=now()
                WHERE analysis_id=%s
                """,
                (analysis_id,),
            )
            if analysis["vector_sync_status"] != "completed":
                await self._notify_analysis_materials(
                    connection, analysis_id, analysis["requested_by_owner_id"]
                )
            await connection.execute(
                """
                UPDATE analysis_chunk
                SET cloud_vector_status='completed', updated_at=now()
                WHERE analysis_id=%s
                """,
                (analysis_id,),
            )
            await connection.execute(
                """
                UPDATE vector_outbox
                SET status='completed', last_error=NULL, updated_at=now()
                WHERE analysis_id=%s
                """,
                (analysis_id,),
            )

    async def allowed_asset_ids(
        self, user_id: str, folder_id: str | None = None
    ) -> list[str]:
        async with self.connection(user_id) as connection:
            rows = await (
                await connection.execute(
                    """
                    SELECT DISTINCT m.asset_id FROM material m
                    JOIN asset_version av ON av.asset_id=m.asset_id AND av.asset_version=m.asset_version
                    WHERE m.deleted_at IS NULL AND av.cloud_status='ready'
                      AND (%s::text IS NULL OR m.folder_id=%s::text)
                      AND EXISTS (
                          SELECT 1 FROM analysis an
                          WHERE an.asset_id=m.asset_id AND an.asset_version=m.asset_version
                            AND an.analysis_status='completed' AND an.chunk_count > 0
                            AND an.chunk_count = (
                                SELECT count(*) FROM analysis_chunk chunk
                                WHERE chunk.analysis_id=an.analysis_id
                            )
                      )
                    """,
                    (folder_id, folder_id),
                )
            ).fetchall()
        return [str(row["asset_id"]) for row in rows]

    async def material_ids_for_assets(
        self, user_id: str, asset_ids: list[str]
    ) -> dict[str, str]:
        if not asset_ids:
            return {}
        async with self.connection(user_id) as connection:
            rows = await (
                await connection.execute(
                    """
                    SELECT m.asset_id, min(m.material_id) AS material_id
                    FROM material m
                    JOIN asset_version av ON av.asset_id=m.asset_id AND av.asset_version=m.asset_version
                    WHERE m.deleted_at IS NULL AND av.cloud_status='ready'
                      AND m.asset_id = ANY(%s)
                      AND EXISTS (
                          SELECT 1 FROM analysis an
                          WHERE an.asset_id=m.asset_id AND an.asset_version=m.asset_version
                            AND an.analysis_status='completed' AND an.chunk_count > 0
                            AND an.chunk_count = (
                                SELECT count(*) FROM analysis_chunk chunk
                                WHERE chunk.analysis_id=an.analysis_id
                            )
                      )
                    GROUP BY m.asset_id
                    """,
                    (asset_ids,),
                )
            ).fetchall()
        return {str(row["asset_id"]): str(row["material_id"]) for row in rows}

    async def idempotency_get(
        self, user_id: str, operation: str, key: str, request_hash: str
    ) -> tuple[int, dict[str, Any]] | None:
        async with self.connection(user_id) as connection:
            row = await (
                await connection.execute(
                    """
                    SELECT request_hash, response_status, response_json
                    FROM idempotency_record
                    WHERE owner_id=%s AND operation=%s AND idempotency_key=%s AND expires_at>now()
                    """,
                    (user_id, operation, key),
                )
            ).fetchone()
        if not row:
            return None
        if row["request_hash"] != request_hash:
            raise ServiceError(409, "idempotency_conflict", "幂等键对应的请求内容不一致")
        return int(row["response_status"]), dict(row["response_json"])

    async def idempotency_save(
        self,
        user_id: str,
        operation: str,
        key: str,
        request_hash: str,
        status: int,
        response: dict[str, Any],
    ) -> None:
        async with self.connection(user_id) as connection:
            await connection.execute(
                """
                INSERT INTO idempotency_record(
                    owner_id, operation, idempotency_key, request_hash,
                    response_status, response_json, expires_at
                ) VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s)
                ON CONFLICT(owner_id, operation, idempotency_key) DO NOTHING
                """,
                (
                    user_id,
                    operation,
                    key,
                    request_hash,
                    status,
                    _json_response_dumps(response),
                    datetime.now(UTC) + timedelta(hours=24),
                ),
            )
