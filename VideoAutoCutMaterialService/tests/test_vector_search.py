from __future__ import annotations

import httpx
import pytest

from app.vector_search import VectorSearchService


class FakeRepository:
    def __init__(self) -> None:
        self.searches = []

    async def allowed_asset_ids(self, user_id, folder_id):
        assert user_id == "user-1"
        return ["asset-1"]

    async def search_pgvector(self, user_id, embedding, limit, folder_id):
        self.searches.append((user_id, embedding, limit, folder_id))
        return [
            {
                "asset_id": "asset-1",
                "score": 0.91,
                "start_ms": 100,
                "end_ms": 900,
                "caption": "工业机械臂",
            }
        ]

    async def material_ids_for_assets(self, user_id, asset_ids):
        assert (user_id, asset_ids) == ("user-1", ["asset-1"])
        return {"asset-1": "material-1"}


@pytest.mark.asyncio
async def test_dashscope_embedding_and_pgvector_primary_search():
    captured = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = request.read().decode("utf-8")
        return httpx.Response(
            200,
            json={
                "output": {
                    "embeddings": [{"embedding": [0.25] * 768}]
                }
            },
        )

    repository = FakeRepository()
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        service = VectorSearchService(
            repository=repository,
            client=client,
            embedding_url=(
                "https://dashscope.example/api/v1/services/embeddings/"
                "multimodal-embedding/multimodal-embedding"
            ),
            embedding_token="secret",
            embedding_model="qwen3-vl-embedding",
            dimension=768,
            cloud_search_url="",
            cloud_token="",
            vector_backend="pgvector",
        )
        results, source = await service.search(
            user_id="user-1", query="机械臂", limit=5
        )

    assert '"contents":[{"text":"机械臂"}]' in captured["body"]
    assert '"dimension":768' in captured["body"]
    assert source == "pgvector"
    assert results[0]["material_id"] == "material-1"
    assert len(repository.searches[0][1]) == 768
