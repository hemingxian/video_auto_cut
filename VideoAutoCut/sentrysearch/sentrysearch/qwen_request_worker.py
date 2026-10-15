"""One SDK request, with no retry. The caller owns its hard process deadline."""

import json
import sys

from .qwen_cloud_embedder import QwenCloudEmbedder, _is_transient_transport_error, request_timeout


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stdin.reconfigure(encoding="utf-8")
    try:
        payload = json.load(sys.stdin)
        embedder = QwenCloudEmbedder(model_name=payload["model"])
        response = embedder._MultiModalEmbedding.call(
            model=payload["model"], input=payload["contents"], api_key=embedder._api_key,
            request_timeout=request_timeout(), **payload["parameters"],
        )
        result = {"ok": True, "embedding": embedder._parse_embedding_response(response)}
    except Exception as exc:
        result = {"ok": False, "error": f"{type(exc).__name__}: {exc}",
                  "transient": _is_transient_transport_error(exc)}
    print("VACUT_EMBED_RESULT:" + json.dumps(result, ensure_ascii=False), flush=True)
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
