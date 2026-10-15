"""Validate bounded, content-bound client analysis receipts without rewriting them."""
import json
import math
import re


def provenance_config(value):
    if value is None:
        return None
    return {"analysis_profile": value.get("analysis_profile"),
        "normalization_profile": value.get("source_identity", {}).get("normalization_profile")}


def validate_provenance(value, *, source_sha256, file_size_bytes, model_name, dimension):
    if value is None:
        return

    def walk(item, depth=0):
        if depth > 12:
            raise ValueError("analysis provenance nesting exceeds limit")
        if isinstance(item, dict):
            for child in item.values():
                walk(child, depth + 1)
        elif isinstance(item, list):
            for child in item:
                walk(child, depth + 1)
        elif item is not None and not isinstance(item, (str, bool, int, float)):
            raise ValueError("analysis provenance must contain JSON values")

    walk(value)
    encoded = json.dumps(value, ensure_ascii=False, allow_nan=False)
    if len(encoded.encode()) > 1_048_576:
        raise ValueError("analysis provenance exceeds size limit")
    identity = value.get("source_identity", {})
    profile = value.get("analysis_profile", {})
    if not isinstance(identity, dict) or not isinstance(profile, dict):
        raise ValueError("analysis provenance identity and profile must be objects")
    if (value.get("schema_version") != 1
        or not re.fullmatch(r"[a-f0-9]{64}", str(identity.get("source_sha256", "")))
        or identity.get("source_sha256") != source_sha256
        or identity.get("source_size") != file_size_bytes
        or profile.get("contract") != "sentry-analysis-v1"
        or profile.get("backend") != "qwen-cloud"
        or profile.get("model") != model_name
        or profile.get("dimensions") != dimension):
        raise ValueError("analysis provenance does not match source/model identity")
    duration = value.get("duration")
    if not isinstance(duration, (int, float)) or isinstance(duration, bool) or not math.isfinite(duration) or duration <= 0:
        raise ValueError("analysis provenance duration is invalid")
    for name in ("spans", "still_spans"):
        spans = value.get(name)
        if not isinstance(spans, list) or len(spans) > 10_000:
            raise ValueError("analysis provenance spans are invalid")
        for span in spans:
            if (not isinstance(span, list) or len(span) != 2
                or any(not isinstance(n, (int, float)) or isinstance(n, bool) or not math.isfinite(n) for n in span)
                or span[0] < 0 or span[1] <= span[0] or span[1] > duration + 0.01):
                raise ValueError("analysis provenance span range is invalid")
