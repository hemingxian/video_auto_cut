from __future__ import annotations

from datetime import datetime
import math
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from .analysis_provenance import validate_provenance


OpaqueId = Annotated[str, Field(min_length=5, max_length=96, pattern=r"^[A-Za-z0-9_-]+$")]
Sha256 = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]


def _validate_display_name(value: str) -> str:
    if value != value.strip() or value in {".", ".."}:
        raise ValueError("name has unsafe leading/trailing characters")
    if any(character in value for character in '<>:"/\\|?*'):
        raise ValueError("name contains an unsafe character")
    if value.endswith(".") or value.endswith(" "):
        raise ValueError("name has an unsafe suffix")
    if any(ord(character) <= 31 for character in value):
        raise ValueError("name contains a control character")
    return value


class FolderSyncItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    folder_id: OpaqueId
    parent_folder_id: OpaqueId | None = None
    name: str = Field(min_length=1, max_length=255)
    revision: int = Field(ge=1)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        return _validate_display_name(value)


class FolderUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str | None = Field(default=None, min_length=1, max_length=255)
    parent_folder_id: OpaqueId | None = None
    revision: int = Field(ge=1)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str | None) -> str | None:
        return _validate_display_name(value) if value is not None else None


class RevisionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(ge=1)


class PublicationCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(ge=1)
    consent_version: str = Field(min_length=1, max_length=64)
    rights_confirmed: Literal[True]


class PublicationReviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(ge=1)
    decision: Literal["approve", "reject"]
    reason: str = Field(default="", max_length=1000)

    @model_validator(mode="after")
    def rejection_requires_reason(self) -> "PublicationReviewRequest":
        if self.decision == "reject" and not self.reason.strip():
            raise ValueError("rejection reason is required")
        self.reason = self.reason.strip()
        return self


class PublicMaterialAddRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    folder_id: OpaqueId


class PublicationWithdrawRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(ge=1)
    reason: str = Field(default="", max_length=1000)

    @field_validator("reason")
    @classmethod
    def clean_reason(cls, value: str) -> str:
        return value.strip()


class PublicationModerationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(ge=1)
    action: Literal["pause", "resume", "remove"]
    reason: str = Field(default="", max_length=1000)

    @model_validator(mode="after")
    def destructive_action_requires_reason(self) -> "PublicationModerationRequest":
        if self.action in {"pause", "remove"} and not self.reason.strip():
            raise ValueError("moderation reason is required")
        self.reason = self.reason.strip()
        return self


class PublicationReportCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    category: Literal["copyright", "privacy", "harmful", "other"]
    description: str = Field(min_length=10, max_length=2000)

    @field_validator("description")
    @classmethod
    def clean_description(cls, value: str) -> str:
        value = value.strip()
        if len(value) < 10:
            raise ValueError("report description is too short")
        return value


class PublicationReportReviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(ge=1)
    decision: Literal["uphold", "dismiss"]
    reason: str = Field(min_length=2, max_length=1000)

    @field_validator("reason")
    @classmethod
    def clean_reason(cls, value: str) -> str:
        value = value.strip()
        if len(value) < 2:
            raise ValueError("review reason is too short")
        return value


class MaterialSyncItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    material_id: OpaqueId
    asset_id: OpaqueId
    asset_version: int = Field(ge=1)
    folder_id: OpaqueId
    display_name: str = Field(min_length=1, max_length=255)
    origin: Literal["user_upload", "platform_download"]
    added_from: Literal["user_import", "task_download", "cloud_restore", "public_library"]
    mime_type: str = Field(min_length=3, max_length=150)
    file_size_bytes: int = Field(gt=0)
    source_sha256: Sha256
    revision: int = Field(ge=1)


class MaterialUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    display_name: str | None = Field(default=None, min_length=1, max_length=255)
    folder_id: OpaqueId | None = None
    revision: int = Field(ge=1)

    @field_validator("display_name")
    @classmethod
    def clean_display_name(cls, value: str | None) -> str | None:
        return _validate_display_name(value) if value is not None else None


class SyncBatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    folders: list[FolderSyncItem] = Field(default_factory=list, max_length=100)
    materials: list[MaterialSyncItem] = Field(default_factory=list, max_length=100)


class SyncBatchResult(BaseModel):
    entity_type: Literal["folder", "material"]
    entity_id: str
    ok: bool
    revision: int | None = None
    error: dict[str, str] | None = None


class SyncBatchResponse(BaseModel):
    results: list[SyncBatchResult]


class CreateUploadSessionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    material_id: OpaqueId
    filename: str = Field(min_length=1, max_length=255)
    mime_type: str = Field(min_length=3, max_length=150)
    file_size_bytes: int = Field(gt=0)
    source_sha256: Sha256
    origin: Literal["user_upload", "platform_download"]
    metadata: dict[str, str | int | float | bool | None] = Field(default_factory=dict)


class ReuseResult(BaseModel):
    type: Literal["none", "own_asset"] = "none"


class UploadSessionResponse(BaseModel):
    upload_session_id: str
    status: str
    upload_mode: Literal["single", "multipart"]
    part_size_bytes: int
    expires_at: datetime
    reuse: ReuseResult
    upload: dict[str, int] = Field(default_factory=dict)


class UploadResumeResponse(BaseModel):
    upload_session_id: str
    status: str
    upload_mode: Literal["single", "multipart"]
    part_size_bytes: int
    uploaded_bytes: int
    completed_parts: list[int]
    expires_at: datetime


class PartAuthorizationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    part_numbers: list[int] = Field(min_length=1, max_length=100)


class PartAuthorization(BaseModel):
    part_number: int
    method: Literal["PUT"] = "PUT"
    url: str
    headers: dict[str, str]
    expires_at: datetime


class PartAuthorizationResponse(BaseModel):
    authorizations: list[PartAuthorization]


class CompletePartRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    part_number: int = Field(ge=1)
    size_bytes: int = Field(gt=0)
    etag: str = Field(default="", max_length=256)
    checksum: Sha256


class UploadCompleteResponse(BaseModel):
    upload_session_id: str
    status: str
    cloud_status: str


class DownloadSessionResponse(BaseModel):
    download_session_id: str
    url: str
    expires_at: datetime
    file_size_bytes: int
    source_sha256: Sha256
    mime_type: str
    range_supported: bool = True


class SemanticSearchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    query: str = Field(min_length=1, max_length=2000)
    limit: int = Field(default=20, ge=1, le=100)
    scope: dict[str, object] | None = None


class SelectionResolveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    material_ids: list[OpaqueId] = Field(min_length=1, max_length=500)


class ShotMaterialBinding(BaseModel):
    model_config = ConfigDict(extra="forbid")
    binding_type: Literal["material", "folder"]
    material_id: OpaqueId | None = None
    folder_id: OpaqueId | None = None
    include_subfolders: bool = False

    @model_validator(mode="after")
    def valid_binding_target(self) -> "ShotMaterialBinding":
        if self.binding_type == "material":
            if not self.material_id or self.folder_id is not None or self.include_subfolders:
                raise ValueError("material binding requires only material_id")
        elif not self.folder_id or self.material_id is not None:
            raise ValueError("folder binding requires only folder_id")
        return self


class ShotMaterialValidationItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    shot_id: OpaqueId
    download_material: bool
    material_bindings: list[ShotMaterialBinding] = Field(default_factory=list, max_length=100)


class ShotMaterialValidationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    shots: list[ShotMaterialValidationItem] = Field(min_length=1, max_length=100)
    require_cloud_ready: bool = False
    require_analysis_ready: bool = True

    @field_validator("shots")
    @classmethod
    def unique_shot_ids(
        cls, value: list[ShotMaterialValidationItem]
    ) -> list[ShotMaterialValidationItem]:
        shot_ids = [item.shot_id for item in value]
        if len(set(shot_ids)) != len(shot_ids):
            raise ValueError("shot_id must be unique")
        if sum(len(item.material_bindings) for item in value) > 500:
            raise ValueError("too many material bindings")
        return value


class GenerationRunCreateRequest(ShotMaterialValidationRequest):
    task_id: OpaqueId
    task_revision: int = Field(ge=1)


class GenerationRunStatusUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(ge=1)
    status: Literal["running", "succeeded", "failed", "canceled"]
    stage: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    progress: float = Field(ge=0, le=100)
    current_shot_id: OpaqueId | None = None
    current_material_id: OpaqueId | None = None
    error_code: str | None = Field(default=None, max_length=128)
    error_message: str | None = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def valid_terminal_details(self) -> "GenerationRunStatusUpdateRequest":
        self.error_code = self.error_code.strip() if self.error_code else None
        self.error_message = self.error_message.strip() if self.error_message else None
        if self.status == "failed" and (not self.error_code or not self.error_message):
            raise ValueError("failed status requires error_code and error_message")
        if self.status != "failed" and (self.error_code or self.error_message):
            raise ValueError("only failed status accepts error details")
        if self.status == "succeeded" and self.progress != 100:
            raise ValueError("succeeded status requires progress 100")
        return self


class GenerationSnapshotRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    run_id: OpaqueId
    shot_id: OpaqueId
    material_ids: list[OpaqueId] = Field(min_length=1, max_length=500)
    download_material: bool = False
    require_cloud_ready: bool = False


class AnalysisStatusCheckRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    material_ids: list[OpaqueId] = Field(min_length=1, max_length=100)
    trigger_missing: bool = True


class AnalysisWorkerClaimRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    worker_id: OpaqueId
    limit: int = Field(default=4, ge=1, le=20)


class AnalysisChunkInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    chunk_id: OpaqueId
    start_ms: int = Field(ge=0)
    end_ms: int = Field(gt=0)
    caption: str = Field(default="", max_length=10_000)
    embedding: list[float] = Field(min_length=768, max_length=768)

    @field_validator("embedding")
    @classmethod
    def finite_embedding(cls, value: list[float]) -> list[float]:
        if not all(math.isfinite(item) for item in value):
            raise ValueError("embedding values must be finite")
        return value

    @model_validator(mode="after")
    def valid_range(self) -> "AnalysisChunkInput":
        if self.end_ms <= self.start_ms:
            raise ValueError("end_ms must be greater than start_ms")
        return self


class AnalysisCompleteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    worker_id: OpaqueId
    chunks: list[AnalysisChunkInput] = Field(min_length=1, max_length=10_000)


class ClientAnalysisResultRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    asset_id: OpaqueId
    asset_version: int = Field(ge=1)
    source_sha256: Sha256
    file_size_bytes: int = Field(gt=0)
    analysis_profile_id: OpaqueId
    embedding_backend: Literal["qwen-cloud"] = "qwen-cloud"
    model_name: str = Field(min_length=1, max_length=128)
    model_version: str = Field(min_length=1, max_length=128)
    dimension: int = Field(ge=1, le=4096)
    result_schema_version: int = Field(default=1, ge=1, le=100)
    chunks: list[AnalysisChunkInput] = Field(min_length=1, max_length=10_000)
    analysis_provenance: dict[str, object] | None = None

    @model_validator(mode="after")
    def validate_analysis_provenance(self) -> "ClientAnalysisResultRequest":
        validate_provenance(self.analysis_provenance, source_sha256=self.source_sha256,
            file_size_bytes=self.file_size_bytes, model_name=self.model_name, dimension=self.dimension)
        return self


class PageResponse(BaseModel):
    items: list[dict[str, object]]
    next_cursor: str | None = None
    has_more: bool = False


class HealthResponse(BaseModel):
    status: str
