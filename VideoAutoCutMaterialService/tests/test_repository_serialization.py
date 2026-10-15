from datetime import UTC, datetime
import json

import pytest

from app.repository import _json_response_dumps


def test_idempotency_response_serializes_datetime_as_utc_iso8601():
    payload = {
        "run_id": "run_12345",
        "created_at": datetime(2026, 9, 1, 2, 30, 45, tzinfo=UTC),
    }

    decoded = json.loads(_json_response_dumps(payload))

    assert decoded == {
        "run_id": "run_12345",
        "created_at": "2026-09-01T02:30:45+00:00",
    }


def test_idempotency_response_rejects_unknown_objects():
    with pytest.raises(TypeError, match="is not JSON serializable"):
        _json_response_dumps({"value": object()})
