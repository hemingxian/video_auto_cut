from copy import deepcopy
import pytest
from pydantic import ValidationError
from test_client_analysis_service import payload


def provenance():
    return {"schema_version": 1,
        "source_identity": {"source_sha256": "a" * 64, "source_size": 1024, "normalization_profile": None},
        "analysis_profile": {"contract": "sentry-analysis-v1", "backend": "qwen-cloud",
            "model": "qwen3-vl-embedding", "dimensions": 768, "chunk_duration": 30, "future_parameter": {"value": True}},
        "duration": 2.0, "spans": [[0.0, 2.0]], "still_spans": []}


def test_provenance_roundtrip_preserves_all_profile_parameters_and_legacy_clients():
    receipt = provenance()
    assert payload(analysis_provenance=receipt).model_dump()["analysis_provenance"] == receipt
    assert payload().analysis_provenance is None


@pytest.mark.parametrize("mutate", [
    lambda p: p["source_identity"].update(source_sha256="b" * 64),
    lambda p: p["source_identity"].update(source_size=2048),
    lambda p: p["analysis_profile"].update(model="another-model"),
    lambda p: p["analysis_profile"].update(dimensions=3),
    lambda p: p.update(duration=float("nan")),
    lambda p: p.update(spans=[[0, 999]]),
    lambda p: p.update(spans=[[True, 2]]),
    lambda p: p["analysis_profile"].update(oversized="a" * 1_048_576),
])
def test_invalid_or_mismatched_provenance_is_rejected(mutate):
    receipt = deepcopy(provenance())
    mutate(receipt)
    with pytest.raises((ValidationError, ValueError)):
        payload(analysis_provenance=receipt)
