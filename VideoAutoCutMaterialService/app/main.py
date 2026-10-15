from __future__ import annotations

import asyncio
import uuid
from contextlib import suppress
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .api import router
from .auth import AuthResolver
from .config import Settings
from .container import Container
from .errors import ServiceError
from .repository import MaterialRepository
from .service import MaterialService
from .upload_gateway import UploadGateway
from .vector_search import VectorSearchService
from .analysis_service import AnalysisService


def create_app(settings: Settings | None = None, injected: Container | None = None) -> FastAPI:
    configured = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if injected is not None:
            app.state.container = injected
            yield
            return
        configured.validate_runtime()
        http = httpx.AsyncClient(follow_redirects=False)
        repository = MaterialRepository(configured.database_url)
        await repository.open()
        gateway = UploadGateway(
            configured.upload_service_url,
            configured.upload_service_token,
            http,
        )
        materials = MaterialService(
            settings=configured,
            repository=repository,
            upload_gateway=gateway,
        )
        vectors = VectorSearchService(
            repository=repository,
            client=http,
            embedding_url=configured.embedding_url,
            embedding_token=configured.embedding_token,
            embedding_model=configured.embedding_model,
            dimension=configured.vector_dimension,
            cloud_search_url=configured.cloud_vector_search_url,
            cloud_token=configured.cloud_vector_token,
            cloud_upsert_url=configured.cloud_vector_upsert_url,
            vector_backend=configured.vector_backend,
        )
        analysis = AnalysisService(
            settings=configured,
            repository=repository,
            upload_gateway=gateway,
            vectors=vectors,
        )
        app.state.container = Container(
            settings=configured,
            http=http,
            auth=AuthResolver(configured.auth_me_url, http),
            repository=repository,
            materials=materials,
            vectors=vectors,
            upload_gateway=gateway,
            analysis=analysis,
        )
        async def vector_outbox_loop() -> None:
            while True:
                try:
                    await analysis.sync_vector_outbox_once()
                except Exception:
                    pass
                await asyncio.sleep(30)

        vector_task = asyncio.create_task(vector_outbox_loop())
        try:
            yield
        finally:
            vector_task.cancel()
            with suppress(asyncio.CancelledError):
                await vector_task
            await repository.close()
            await http.aclose()

    app = FastAPI(title="VideoAutoCut Material Service", version="1.0", lifespan=lifespan)

    @app.exception_handler(ServiceError)
    async def service_error_handler(request: Request, error: ServiceError) -> JSONResponse:
        request_id = request.headers.get("X-Request-Id") or f"req_{uuid.uuid4().hex}"
        return JSONResponse(
            status_code=error.status_code,
            content={
                "error": {
                    "code": error.code,
                    "message": error.message,
                    "request_id": request_id,
                    "retryable": error.retryable,
                    "action": error.action,
                    "details": error.details,
                }
            },
            headers={"X-Request-Id": request_id},
        )

    app.include_router(router)
    return app


app = create_app()
