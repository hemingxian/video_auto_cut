import base64
import io
import json
import re
import sys
import zipfile
from pathlib import Path, PurePosixPath

FORBIDDEN_BASENAMES = {"release-upload.local.json", "app.env", "models.json"}
SENSITIVE_KEY = re.compile(r"(?:^|_)(?:api_?key|secret|secret_?key|session_?token|access_?key|password|authorization|auth_?key)$", re.I)
EXACT_JSON_KEYS = {"secretid", "secretkey", "sessiontoken", "apikey", "accesskey", "password", "authorization"}


def credential_values(obj, path="$"):
    found = []
    if isinstance(obj, dict):
        for key, value in obj.items():
            key_text = str(key)
            child = f"{path}.{key_text}"
            normalized = re.sub(r"[^a-z0-9]", "", key_text.lower())
            if (normalized in EXACT_JSON_KEYS or SENSITIVE_KEY.search(key_text)) and isinstance(value, str):
                found.append((child, value))
            found.extend(credential_values(value, child))
    elif isinstance(obj, list):
        for index, value in enumerate(obj):
            found.extend(credential_values(value, f"{path}[{index}]"))
    return found


def env_credentials(text):
    found = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        if stripped.lower().startswith("export "):
            stripped = stripped[7:].lstrip()
        key, value = stripped.split("=", 1)
        key = key.strip()
        value = value.strip()
        if value.startswith("'"):
            end = value.find("'", 1)
            value = value[1:end] if end >= 1 else value[1:]
        elif value.startswith('"'):
            end = 1
            escaped = False
            while end < len(value):
                if value[end] == '"' and not escaped:
                    break
                escaped = value[end] == "\\" and not escaped
                if value[end] != "\\":
                    escaped = False
                end += 1
            quoted = value[:end + 1] if end < len(value) else value
            try:
                value = json.loads(quoted)
            except json.JSONDecodeError:
                value = quoted[1:-1].replace('\\"', '"').replace('\\\\', '\\')
        else:
            value = re.split(r"\s+#", value, maxsplit=1)[0].rstrip()
        if SENSITIVE_KEY.search(key):
            found.append((key, value))
    return found


def variants(value):
    out = set()
    for text in {value, value.strip(), json.dumps(value, ensure_ascii=False)[1:-1], json.dumps(value, ensure_ascii=True)[1:-1]}:
        if not text:
            continue
        for encoding in ("utf-8", "utf-16le", "utf-16be"):
            out.add(text.encode(encoding))
        out.add(base64.b64encode(text.encode("utf-8")))
        out.add(base64.urlsafe_b64encode(text.encode("utf-8")))
    return out


def scan_stream(stream, patterns, chunk_size=1024 * 1024):
    overlap = max((len(item) for item in patterns), default=1) - 1
    tail = b""
    while True:
        chunk = stream.read(chunk_size)
        if not chunk:
            return False
        data = tail + chunk
        if any(pattern in data for pattern in patterns):
            return True
        tail = data[-overlap:] if overlap else b""


def main():
    if len(sys.argv) != 8:
        raise SystemExit("usage: scan_all_credentials.py <release-json> <app-env> <models-json> <zip> <extracted> <audit> <output>")
    release_path, env_path, models_path, archive_path, extracted_root, audit_root, output = map(Path, sys.argv[1:])
    paths = [p.resolve(strict=True) for p in (release_path, env_path, models_path, archive_path, extracted_root, audit_root)]
    release_path, env_path, models_path, archive_path, extracted_root, audit_root = paths
    output = output.resolve()
    release_bytes, env_bytes, models_bytes = release_path.read_bytes(), env_path.read_bytes(), models_path.read_bytes()
    release = json.loads(release_bytes.decode("utf-8-sig"))
    models = json.loads(models_bytes.decode("utf-8-sig"))
    examined = [("release", key, value) for key, value in credential_values(release)]
    examined += [("models", key, value) for key, value in credential_values(models)]
    examined += [("app_env", key, value) for key, value in env_credentials(env_bytes.decode("utf-8-sig"))]
    credentials = [(source, key, value) for source, key, value in examined if value.strip()]
    patterns = set()
    for _, _, value in credentials:
        patterns.update(variants(value))
    # Detect a renamed verbatim copy of any full protected configuration too.
    for raw in (release_bytes, env_bytes, models_bytes):
        if raw:
            patterns.add(raw)
            patterns.add(raw.strip())

    hits, forbidden = [], []
    zip_members = 0
    with zipfile.ZipFile(archive_path) as package:
        for info in package.infolist():
            normalized = info.filename.replace("\\", "/").strip("/").lower()
            if PurePosixPath(normalized).name in FORBIDDEN_BASENAMES:
                forbidden.append(info.filename)
            if info.is_dir():
                continue
            zip_members += 1
            with package.open(info) as stream:
                if scan_stream(stream, patterns):
                    hits.append(f"zip:{info.filename}")

    scanned_files = 0
    for scope, root in (("extracted", extracted_root), ("audit", audit_root)):
        for path in root.rglob("*"):
            if not path.is_file() or path.resolve() in {output, release_path, env_path, models_path}:
                continue
            if scope == "audit" and extracted_root in path.resolve().parents:
                continue
            scanned_files += 1
            with path.open("rb") as stream:
                if scan_stream(stream, patterns):
                    hits.append(f"{scope}:{path.relative_to(root).as_posix()}")

    receipt = {
        "schema": "w6-all-credential-scan/v2",
        "sources": {
            "release": {"credential_keys_examined": [key for source, key, _ in examined if source == "release"], "nonempty_count": sum(source == "release" for source, _, _ in credentials)},
            "app_env": {"credential_keys_examined": [key for source, key, _ in examined if source == "app_env"], "nonempty_count": sum(source == "app_env" for source, _, _ in credentials)},
            "models": {"credential_keys_examined": [key for source, key, _ in examined if source == "models"], "nonempty_count": sum(source == "models" for source, _, _ in credentials)},
        },
        "encodings_checked": ["utf8", "utf16le", "utf16be", "json_escaped_ensure_ascii_false", "json_escaped_ensure_ascii_true", "base64_utf8", "urlsafe_base64_utf8", "full_config_raw_bytes"],
        "forbidden_basenames": sorted(FORBIDDEN_BASENAMES),
        "zip_members_scanned": zip_members,
        "filesystem_files_scanned": scanned_files,
        "forbidden_entry_count": len(forbidden),
        "credential_match_count": len(hits),
        "pass": not forbidden and not hits,
        "credential_values_or_hashes_recorded": False,
    }
    output.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0 if receipt["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
