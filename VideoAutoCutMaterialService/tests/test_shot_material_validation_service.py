from __future__ import annotations

import pytest

from app.models import ShotMaterialValidationRequest
from app.service import MaterialService

from test_material_api import settings


def material(
    material_id: str,
    asset_id: str,
    *,
    cloud_status: str = "ready",
    analysis_status: str = "completed",
    vector_sync_status: str = "completed",
) -> dict[str, object]:
    return {
        "material_id": material_id,
        "asset_id": asset_id,
        "asset_version": 1,
        "cloud_status": cloud_status,
        "analysis_status": analysis_status,
        "vector_sync_status": vector_sync_status,
    }


class FakeRepository:
    async def resolve_materials(self, user_id, material_ids):
        assert user_id == "user-1"
        known = {
            "mat_ready": material("mat_ready", "asset_ready"),
            "mat_valid": material("mat_valid", "asset_valid"),
        }
        return [known[item_id] for item_id in material_ids if item_id in known]

    async def resolve_folder_materials(
        self, user_id, folder_id, *, include_subfolders
    ):
        assert user_id == "user-1"
        if folder_id == "fld_group":
            assert include_subfolders is True
            return {
                "exists": True,
                "materials": [
                    material("mat_alias", "asset_ready"),
                    material(
                        "mat_pending",
                        "asset_pending",
                        cloud_status="not_uploaded",
                        analysis_status="pending",
                        vector_sync_status="pending",
                    ),
                ],
            }
        if folder_id == "fld_empty":
            return {"exists": True, "materials": []}
        return {"exists": False, "materials": []}


@pytest.mark.asyncio
async def test_validation_returns_all_shot_issues_and_deduplicates_asset_versions():
    service = MaterialService(
        settings=settings(), repository=FakeRepository(), upload_gateway=object()
    )
    payload = ShotMaterialValidationRequest.model_validate(
        {
            "shots": [
                {
                    "shot_id": "shot_auto",
                    "download_material": True,
                    "material_bindings": [
                        {"binding_type": "material", "material_id": "mat_ready"}
                    ],
                },
                {
                    "shot_id": "shot_manual",
                    "download_material": False,
                    "material_bindings": [
                        {"binding_type": "material", "material_id": "mat_ready"},
                        {"binding_type": "material", "material_id": "mat_missing"},
                        {
                            "binding_type": "folder",
                            "folder_id": "fld_group",
                            "include_subfolders": True,
                        },
                        {"binding_type": "folder", "folder_id": "fld_empty"},
                    ],
                },
                {
                    "shot_id": "shot_valid",
                    "download_material": False,
                    "material_bindings": [
                        {"binding_type": "material", "material_id": "mat_valid"}
                    ],
                },
            ],
            "require_cloud_ready": False,
            "require_analysis_ready": True,
        }
    )

    result = await service.validate_shot_materials(user_id="user-1", payload=payload)

    assert result["valid"] is False
    assert result["summary"] == {
        "shot_count": 3,
        "valid_shot_count": 1,
        "blocker_count": 4,
        "warning_count": 1,
    }
    automatic = result["shots"][0]
    assert automatic["issues"][0]["action"] == "clear_bindings"
    manual = result["shots"][1]
    assert manual["resolved_material_count"] == 2
    assert manual["duplicate_asset_count"] == 1
    assert [item["asset_id"] for item in manual["materials"]] == [
        "asset_ready",
        "asset_pending",
    ]
    assert {item["code"] for item in manual["issues"]} == {
        "material_unavailable",
        "folder_empty",
        "cloud_copy_not_ready",
        "analysis_not_ready",
    }
    assert all("source_sha256" not in item for item in manual["materials"])


@pytest.mark.asyncio
async def test_cloud_readiness_can_be_promoted_from_warning_to_blocker():
    service = MaterialService(
        settings=settings(), repository=FakeRepository(), upload_gateway=object()
    )
    payload = ShotMaterialValidationRequest.model_validate(
        {
            "shots": [
                {
                    "shot_id": "shot_cloud",
                    "download_material": False,
                    "material_bindings": [
                        {
                            "binding_type": "folder",
                            "folder_id": "fld_group",
                            "include_subfolders": True,
                        }
                    ],
                }
            ],
            "require_cloud_ready": True,
            "require_analysis_ready": False,
        }
    )

    result = await service.validate_shot_materials(user_id="user-1", payload=payload)

    cloud_issue = next(
        item
        for item in result["shots"][0]["issues"]
        if item["code"] == "cloud_copy_not_ready"
    )
    assert cloud_issue["severity"] == "blocker"
    assert result["valid"] is False
