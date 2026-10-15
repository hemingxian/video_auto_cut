"""ChromaDB vector store."""

import hashlib
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

import chromadb


def _default_db_path() -> Path:
    data_root = os.environ.get("VIDEOAUTO_DATA_ROOT", "").strip()
    if data_root:
        return Path(data_root) / "video" / "vector-db" / "sentrysearch"
    return Path.home() / ".sentrysearch" / "db"


DEFAULT_DB_PATH = _default_db_path()

# Chroma collection names allow [a-zA-Z0-9._-] only.
_CHROMA_NAME_UNSAFE = re.compile(r"[^a-zA-Z0-9._-]+")


def _chroma_collection_slug(name: str) -> str:
    """Sanitize *name* for use inside a ChromaDB collection name segment."""
    s = _CHROMA_NAME_UNSAFE.sub("_", (name or "").strip())
    s = re.sub(r"_+", "_", s).strip("_")
    return s or "default"


class BackendMismatchError(RuntimeError):
    """Raised when search backend/model doesn't match the indexed backend/model."""


def _collection_name(backend: str, model: str | None = None) -> str:
    """Return ChromaDB collection name for a backend and optional model."""
    if backend == "gemini":
        return "dashcam_chunks"
    if backend == "qwen-cloud":
        slug = _chroma_collection_slug(model or "qwen3-vl-embedding")
        return f"dashcam_chunks_qwen_cloud_{slug}"
    if model:
        return f"dashcam_chunks_local_{model}"
    # Legacy: local backend without model distinction
    return "dashcam_chunks_local"


def detect_index(db_path: str | Path | None = None) -> tuple[str | None, str | None]:
    """Return ``(backend, model)`` for the first index with data.

    Returns ``(None, None)`` when no index contains data.
    Checks gemini first, then DashScope ``qwen-cloud`` collections, then
    model-specific local collections, then the legacy ``dashcam_chunks_local``
    collection (treated as qwen8b).
    """
    db_path = str(db_path or DEFAULT_DB_PATH)
    if not Path(db_path).exists():
        return None, None
    client = chromadb.PersistentClient(path=db_path)
    existing = {c.name for c in client.list_collections()}

    # Gemini first (default / legacy)
    if "dashcam_chunks" in existing:
        col = client.get_collection("dashcam_chunks")
        if col.count() > 0:
            return "gemini", None

    # DashScope qwen-cloud (dashcam_chunks_qwen_cloud_<model>)
    for name in sorted(existing):
        if name.startswith("dashcam_chunks_qwen_cloud_"):
            col = client.get_collection(name)
            if col.count() > 0:
                meta = col.metadata or {}
                model = meta.get("embedding_model")
                if model is None:
                    model = name.removeprefix("dashcam_chunks_qwen_cloud_")
                return "qwen-cloud", model

    # Model-specific local collections (dashcam_chunks_local_<model>)
    for name in sorted(existing):
        if name.startswith("dashcam_chunks_local_"):
            col = client.get_collection(name)
            if col.count() > 0:
                meta = col.metadata or {}
                model = meta.get("embedding_model")
                if model is None:
                    model = name.removeprefix("dashcam_chunks_local_")
                return "local", model

    # Legacy local collection (no model suffix) — treat as qwen8b
    if "dashcam_chunks_local" in existing:
        col = client.get_collection("dashcam_chunks_local")
        if col.count() > 0:
            meta = col.metadata or {}
            return "local", meta.get("embedding_model", "qwen8b")

    return None, None


def detect_backend(db_path: str | Path | None = None) -> str | None:
    """Return the backend that has indexed data, or None if empty."""
    backend, _ = detect_index(db_path)
    return backend


def _make_chunk_id(source_file: str, start_time: float) -> str:
    """Deterministic chunk ID from source file + start time."""
    raw = f"{source_file}:{start_time}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


class SentryStore:
    """Persistent vector store backed by ChromaDB."""

    def __init__(self, db_path: str | Path | None = None, backend: str = "gemini",
                 model: str | None = None):
        db_path = str(db_path or DEFAULT_DB_PATH)
        Path(db_path).mkdir(parents=True, exist_ok=True)
        self._client = chromadb.PersistentClient(path=db_path)
        self._backend = backend
        self._model = model
        # Separate collection per backend+model so incompatible vectors never mix.
        col_name = _collection_name(backend, model)
        metadata = {"hnsw:space": "cosine", "embedding_backend": backend}
        if model:
            metadata["embedding_model"] = model
        self._collection = self._client.get_or_create_collection(
            name=col_name,
            metadata=metadata,
        )

    @property
    def collection(self) -> chromadb.Collection:
        return self._collection

    def get_backend(self) -> str:
        """Return the backend this index was built with."""
        meta = self._collection.metadata or {}
        return meta.get("embedding_backend", "gemini")

    def get_model(self) -> str | None:
        """Return the model this index was built with, or None."""
        meta = self._collection.metadata or {}
        return meta.get("embedding_model")

    def check_backend(self, backend: str) -> None:
        """Raise BackendMismatchError if *backend* doesn't match the index."""
        indexed_backend = self.get_backend()
        if indexed_backend != backend:
            raise BackendMismatchError(
                f"This index was built with the {indexed_backend} backend. "
                f"Search with --backend {indexed_backend} or re-index with "
                f"--backend {backend}."
            )

    # ------------------------------------------------------------------
    # Write
    # ------------------------------------------------------------------

    def add_chunk(
        self,
        chunk_id: str,
        embedding: list[float],
        metadata: dict,
    ) -> None:
        """Store a single chunk embedding with metadata.

        Required metadata keys: source_file, start_time, end_time.
        An indexed_at ISO timestamp is added automatically.
        """
        meta = {
            "source_file": metadata["source_file"],
            "start_time": float(metadata["start_time"]),
            "end_time": float(metadata["end_time"]),
            "indexed_at": datetime.now(timezone.utc).isoformat(),
        }
        # Carry over any extra metadata the caller provides
        for key in metadata:
            if key not in meta and key != "embedding":
                meta[key] = metadata[key]

        try:
            self._collection.upsert(
                ids=[chunk_id],
                embeddings=[embedding],
                metadatas=[meta],
            )
        except BaseException as exc:
            debug_path = Path.home() / ".sentrysearch" / "last_upsert_error.txt"
            try:
                debug_path.parent.mkdir(parents=True, exist_ok=True)
                debug_path.write_text(
                    f"upsert failed: {type(exc).__name__}: {exc}\n"
                    f"chunk_id={chunk_id}\n"
                    f"embedding_len={len(embedding) if embedding is not None else None}\n"
                    f"embedding_first={embedding[:5] if embedding else None}\n"
                    f"meta={meta!r}\n",
                    encoding="utf-8",
                )
            except Exception:
                pass
            raise

    def add_chunks(self, chunks: list[dict]) -> None:
        """Batch-store chunks. Each dict must have 'embedding' and metadata keys."""
        now = datetime.now(timezone.utc).isoformat()
        ids = []
        embeddings = []
        metadatas = []

        for chunk in chunks:
            chunk_id = _make_chunk_id(chunk["source_file"], chunk["start_time"])
            ids.append(chunk_id)
            embeddings.append(chunk["embedding"])
            metadatas.append({
                "source_file": chunk["source_file"],
                "start_time": float(chunk["start_time"]),
                "end_time": float(chunk["end_time"]),
                "indexed_at": now,
            })

        self._collection.upsert(
            ids=ids,
            embeddings=embeddings,
            metadatas=metadatas,
        )

    # ------------------------------------------------------------------
    # Read
    # ------------------------------------------------------------------

    def search(
        self,
        query_embedding: list[float],
        n_results: int = 5,
        include_embeddings: bool = False,
        allowed_source_files: list[str] | None = None,
    ) -> list[dict]:
        """Return top N results with distances and metadata."""
        if allowed_source_files is not None and not allowed_source_files:
            return []
        count = self._collection.count()
        if count == 0:
            return []

        include = ["metadatas", "distances"]
        if include_embeddings:
            include.append("embeddings")

        query_options = {}
        if allowed_source_files is not None:
            query_options["where"] = {
                "source_file": {"$in": [os.path.abspath(item) for item in allowed_source_files]}
            }

        results = self._collection.query(
            query_embeddings=[query_embedding],
            n_results=min(n_results, count),
            include=include,
            **query_options,
        )

        hits = []
        for i in range(len(results["ids"][0])):
            meta = results["metadatas"][0][i]
            distance = results["distances"][0][i]
            hit = {
                "source_file": meta["source_file"],
                "start_time": meta["start_time"],
                "end_time": meta["end_time"],
                "score": 1.0 - distance,  # cosine distance → similarity
                "distance": distance,
            }
            if include_embeddings:
                hit["embedding"] = results["embeddings"][0][i]
            hits.append(hit)
        return hits

    def is_indexed(self, source_file: str) -> bool:
        """Check whether any chunks from source_file are already stored."""
        results = self._collection.get(
            where={"source_file": source_file},
            limit=1,
        )
        return len(results["ids"]) > 0

    def has_chunk(self, chunk_id: str) -> bool:
        """Check whether a specific chunk ID is already stored."""
        results = self._collection.get(ids=[chunk_id], limit=1)
        return len(results["ids"]) > 0

    def make_chunk_id(self, source_file: str, start_time: float) -> str:
        """Return the deterministic chunk ID used by this store."""
        return _make_chunk_id(source_file, start_time)

    def remove_file(self, source_file: str) -> int:
        """Remove all chunks for a given source file. Returns count removed."""
        results = self._collection.get(where={"source_file": source_file})
        ids = results["ids"]
        if ids:
            self._collection.delete(ids=ids)
        return len(ids)

    def export_file_chunks(self, source_file: str) -> list[dict]:
        """Return one file's ordered chunks without exposing its local path."""
        normalized = os.path.abspath(source_file)
        results = self._collection.get(
            where={"source_file": normalized},
            include=["metadatas", "embeddings"],
        )
        metadatas = results.get("metadatas") or []
        embeddings = results.get("embeddings")
        if embeddings is None:
            embeddings = []
        chunks = []
        for index, chunk_id in enumerate(results.get("ids") or []):
            metadata = metadatas[index] if index < len(metadatas) else {}
            embedding = embeddings[index] if index < len(embeddings) else []
            if hasattr(embedding, "tolist"):
                embedding = embedding.tolist()
            chunks.append({
                "chunk_id": str(chunk_id),
                "start_ms": round(float(metadata.get("start_time", 0)) * 1000),
                "end_ms": round(float(metadata.get("end_time", 0)) * 1000),
                "caption": str(metadata.get("caption", "")),
                "embedding": [float(value) for value in embedding],
            })
        return sorted(chunks, key=lambda item: (item["start_ms"], item["chunk_id"]))

    def cache_records(self, analysis_key: str) -> list[dict]:
        """Recover only vectors whose stored receipt proves the exact cache key."""
        from .analysis_cache import receipt
        results = self._collection.get(where={"analysis_key": analysis_key}, include=["metadatas", "embeddings"])
        records = []
        vectors = results.get("embeddings")
        if vectors is None:
            vectors = []
        for metadata, vector in zip(results.get("metadatas") or [], vectors):
            try:
                # HNSW cosine storage can renormalize float32 values by a few
                # ULPs. Preserve the signed analysis receipt independently.
                item = (json.loads(metadata["analysis_receipt"]) if metadata.get("analysis_receipt")
                        else receipt(metadata["start_time"], metadata["end_time"], vector))
                if item["sha256"] == metadata.get("analysis_receipt_sha256"):
                    records.append({"index": metadata.get("analysis_chunk_index"), "receipt": item})
            except (ValueError, TypeError, KeyError, OverflowError):
                continue
        return records

    def set_analysis_provenance(self, source_file: str, provenance_json: str) -> None:
        results = self._collection.get(where={"source_file": os.path.abspath(source_file)}, include=["metadatas"])
        ids = results.get("ids") or []
        if ids:
            self._collection.update(ids=ids, metadatas=[
                {**meta, "analysis_provenance": provenance_json} for meta in results["metadatas"]
            ])

    def export_analysis_provenance(self, source_file: str) -> dict | None:
        results = self._collection.get(where={"source_file": os.path.abspath(source_file)}, include=["metadatas"])
        values = {meta.get("analysis_provenance", "") for meta in results.get("metadatas") or []}
        if len(values) != 1 or not next(iter(values), ""):
            return None
        try:
            return json.loads(next(iter(values)))
        except (ValueError, TypeError):
            return None

    def import_file_chunks(self, source_file: str, chunks: list[dict], analysis_manifest: dict | None = None) -> int:
        """Replace one local file's chunks with a validated cloud backup."""
        normalized = os.path.abspath(source_file)
        prepared = []
        seen_ranges = set()
        for chunk in chunks:
            start_ms = int(chunk["start_ms"])
            end_ms = int(chunk["end_ms"])
            embedding = [float(value) for value in chunk["embedding"]]
            range_key = (start_ms, end_ms)
            if start_ms < 0 or end_ms <= start_ms or range_key in seen_ranges:
                raise ValueError("invalid or duplicate analysis chunk range")
            if not embedding:
                raise ValueError("analysis chunk embedding is empty")
            seen_ranges.add(range_key)
            prepared.append({
                "chunk_id": _make_chunk_id(normalized, start_ms / 1000),
                "embedding": embedding,
                "metadata": {
                    "source_file": normalized,
                    "start_time": start_ms / 1000,
                    "end_time": end_ms / 1000,
                    "caption": str(chunk.get("caption", "")),
                    "restored_from_cloud": True,
                },
            })
        if analysis_manifest is not None:
            from .analysis_cache import canonical, provenance
            by_range = {(round(r["start_time"] * 1000), round(r["end_time"] * 1000)): (int(i), r)
                        for i, r in analysis_manifest["chunks"].items() if r["status"] == "embedded"}
            for item in prepared:
                meta = item["metadata"]
                index, record = by_range[(round(meta["start_time"] * 1000), round(meta["end_time"] * 1000))]
                meta.update(start_time=record["start_time"], end_time=record["end_time"],
                            analysis_key=analysis_manifest["key"], analysis_chunk_index=index,
                            analysis_receipt_sha256=record["sha256"],
                            analysis_receipt=canonical(record),
                            analysis_provenance=canonical(provenance(analysis_manifest)))
                item["chunk_id"] = _make_chunk_id(normalized, record["start_time"])
                item["embedding"] = record["embedding"]
        if not prepared:
            raise ValueError("analysis result has no chunks")

        existing = self._collection.get(where={"source_file": normalized})
        existing_ids = existing.get("ids") or []
        if existing_ids:
            self._collection.delete(ids=existing_ids)
        for offset in range(0, len(prepared), 500):
            batch = prepared[offset:offset + 500]
            self._collection.upsert(
                ids=[item["chunk_id"] for item in batch],
                embeddings=[item["embedding"] for item in batch],
                metadatas=[item["metadata"] for item in batch],
            )
        return len(prepared)

    def get_stats(self) -> dict:
        """Return store statistics."""
        total = self._collection.count()
        if total == 0:
            return {"total_chunks": 0, "unique_source_files": 0, "source_files": []}

        # Fetch all metadata (only the fields we need)
        all_meta = self._collection.get(include=["metadatas"])
        source_files = sorted({m["source_file"] for m in all_meta["metadatas"]})
        return {
            "total_chunks": total,
            "unique_source_files": len(source_files),
            "source_files": source_files,
        }
