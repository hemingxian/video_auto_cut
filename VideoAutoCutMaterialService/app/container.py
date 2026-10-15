from __future__ import annotations

from dataclasses import dataclass

import httpx

from .auth import AuthResolver
from .config import Settings
from .repository import MaterialRepository
from .service import MaterialService
from .upload_gateway import UploadGateway
from .vector_search import VectorSearchService
from .analysis_service import AnalysisService


@dataclass
class Container:
    settings: Settings
    http: httpx.AsyncClient
    auth: AuthResolver
    repository: MaterialRepository
    materials: MaterialService
    vectors: VectorSearchService
    upload_gateway: UploadGateway
    analysis: AnalysisService | None = None
