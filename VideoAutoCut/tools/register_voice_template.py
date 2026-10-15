#!/usr/bin/env python3
# -*- coding: utf-8 -*-
from __future__ import annotations

import argparse
import json
from datetime import datetime
import mimetypes
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import dashscope_url, data_root, env_path, load_dotenv, read_http_response_text, urlopen_with_retry
from json_io import atomic_write_json, atomic_write_text, decode_json_object, load_json


def update_env_value(path: Path, key: str, value: str) -> None:
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
        raise ValueError(f"非法环境变量名: {key!r}")
    if "\r" in value or "\n" in value:
        raise ValueError(f"环境变量 {key} 的值不能包含换行符")
    lines: list[str] = []
    found = False
    if path.exists():
        lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
    for i, line in enumerate(lines):
        if re.match(rf"^\s*{re.escape(key)}\s*=", line):
            lines[i] = f"{key}={value}"
            found = True
            break
    if not found:
        if lines and lines[-1].strip():
            lines.append("")
        lines.append(f"{key}={value}")
    atomic_write_text(path, "\n".join(lines) + "\n")

def voice_registry_path() -> Path:
    path = data_root() / "voice_templates" / "voice_registry.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def load_voice_registry() -> list[dict]:
    path = voice_registry_path()
    if not path.exists():
        return []
    data = load_json(path)
    if isinstance(data, list):
        return [x for x in data if isinstance(x, dict)]
    if isinstance(data, dict) and isinstance(data.get("voices"), list):
        return [x for x in data["voices"] if isinstance(x, dict)]
    raise ValueError(f"音色记录格式错误，顶层必须是数组或 voices 数组: {path}")


def save_voice_registry(records: list[dict]) -> None:
    atomic_write_json(voice_registry_path(), records)


def save_voice_record(
    *,
    voice_id: str,
    local_file: Path | None,
    audio_url: str,
    prefix: str,
    target_model: str,
    upload_model: str,
    language: str,
    response: dict,
) -> None:
    records = load_voice_registry()
    template_path = str(local_file.resolve()) if local_file is not None else ""
    template_name = local_file.name if local_file is not None else "URL 声音样本"
    record = {
        "voice_id": voice_id,
        "template_name": template_name,
        "template_path": template_path,
        "prefix": prefix,
        "target_model": target_model,
        "upload_model": upload_model,
        "language": language,
        "audio_url": audio_url,
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "response": response,
    }
    records = [r for r in records if str(r.get("voice_id") or "") != voice_id]
    records.insert(0, record)
    save_voice_registry(records)
    print(f"已保存音色记录: {voice_registry_path()}")

def find_value(obj, names: tuple[str, ...]) -> str | None:
    if isinstance(obj, dict):
        for name in names:
            v = obj.get(name)
            if isinstance(v, str) and v.strip():
                return v.strip()
        for v in obj.values():
            found = find_value(v, names)
            if found:
                return found
    elif isinstance(obj, list):
        for item in obj:
            found = find_value(item, names)
            if found:
                return found
    return None


def get_upload_policy(api_key: str, model_name: str) -> dict:
    query = urllib.parse.urlencode({"action": "getPolicy", "model": model_name})
    endpoint = dashscope_url(
        "api/v1/uploads",
        override_env="DASHSCOPE_UPLOADS_URL",
        default="https://dashscope.aliyuncs.com/api/v1/uploads",
    )
    req = urllib.request.Request(
        f"{endpoint}?{query}",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="GET",
    )
    try:
        with urlopen_with_retry(req, timeout=120, label="获取 DashScope 上传凭证") as resp:
            payload = read_http_response_text(resp)
    except urllib.error.HTTPError as e:
        detail = read_http_response_text(e)
        raise SystemExit(f"获取上传凭证失败 HTTP {e.code}: {detail}")
    result = decode_json_object(payload, label="DashScope 上传凭证响应")
    policy = result.get("data")
    if not isinstance(policy, dict):
        raise ValueError("DashScope 上传凭证响应缺少 data 对象")
    required = {
        "upload_dir",
        "oss_access_key_id",
        "signature",
        "policy",
        "x_oss_object_acl",
        "x_oss_forbid_overwrite",
        "upload_host",
    }
    missing = sorted(key for key in required if not str(policy.get(key) or "").strip())
    if missing:
        raise ValueError(f"DashScope 上传凭证缺少字段: {', '.join(missing)}")
    return policy


def safe_upload_filename(file_path: Path) -> str:
    suffix = re.sub(r"[^0-9A-Za-z.]", "", file_path.suffix)[:16]
    stem = re.sub(r"[^\w.-]+", "_", file_path.stem, flags=re.UNICODE).strip("._-")
    return f"{(stem or 'voice_sample')[:100]}{suffix}"


def multipart_form_data(fields: dict[str, str], file_field: str, file_path: Path) -> tuple[bytes, str]:
    boundary = f"----VideoAutoDashScope{uuid.uuid4().hex}"
    chunks: list[bytes] = []
    for key, value in fields.items():
        chunks.append(f"--{boundary}\r\n".encode("utf-8"))
        chunks.append(f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode("utf-8"))
        chunks.append(str(value).encode("utf-8"))
        chunks.append(b"\r\n")

    filename = safe_upload_filename(file_path)
    content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    chunks.append(f"--{boundary}\r\n".encode("utf-8"))
    chunks.append(
        f'Content-Disposition: form-data; name="{file_field}"; filename="{filename}"\r\n'.encode("utf-8")
    )
    chunks.append(f"Content-Type: {content_type}\r\n\r\n".encode("utf-8"))
    chunks.append(file_path.read_bytes())
    chunks.append(b"\r\n")
    chunks.append(f"--{boundary}--\r\n".encode("utf-8"))
    return b"".join(chunks), boundary


def upload_file_to_dashscope_temp(api_key: str, file_path: Path, model_name: str) -> str:
    if not file_path.is_file():
        raise SystemExit(f"文件不存在: {file_path}")
    policy = get_upload_policy(api_key, model_name)
    key = f"{policy['upload_dir']}/{safe_upload_filename(file_path)}"
    fields = {
        "OSSAccessKeyId": policy["oss_access_key_id"],
        "Signature": policy["signature"],
        "policy": policy["policy"],
        "x-oss-object-acl": policy["x_oss_object_acl"],
        "x-oss-forbid-overwrite": policy["x_oss_forbid_overwrite"],
        "key": key,
        "success_action_status": "200",
    }
    data, boundary = multipart_form_data(fields, "file", file_path)
    req = urllib.request.Request(
        policy["upload_host"],
        data=data,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    try:
        with urlopen_with_retry(req, timeout=300, label="上传文件到 DashScope 临时存储") as resp:
            resp.read()
    except urllib.error.HTTPError as e:
        detail = read_http_response_text(e)
        raise SystemExit(f"上传声音样本失败 HTTP {e.code}: {detail}")
    return f"oss://{key}"


def create_voice(audio_url: str, prefix: str, target_model: str, language_hints: list[str] | None) -> tuple[str, dict]:
    load_dotenv()
    api_key = os.environ.get("DASHSCOPE_API_KEY", "").strip()
    if not api_key:
        raise SystemExit("DASHSCOPE_API_KEY is missing in .env")
    if not audio_url.lower().startswith(("http://", "https://", "oss://")):
        raise SystemExit(
            "创建音色需要 http/https URL 或百炼临时存储 oss:// URL。"
        )

    endpoint = dashscope_url(
        "api/v1/services/audio/tts/customization",
        override_env="DASHSCOPE_VOICE_CUSTOMIZATION_URL",
        default="https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization",
    )
    body = {
        "model": "voice-enrollment",
        "input": {
            "action": "create_voice",
            "target_model": target_model,
            "prefix": prefix,
            "url": audio_url,
        },
    }
    if language_hints:
        body["input"]["language_hints"] = language_hints

    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        endpoint,
        data=data,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "X-DashScope-OssResourceResolve": "enable",
        },
        method="POST",
    )
    try:
        with urlopen_with_retry(req, timeout=120, label="创建 DashScope 音色") as resp:
            payload = read_http_response_text(resp)
    except urllib.error.HTTPError as e:
        detail = read_http_response_text(e)
        raise SystemExit(f"创建音色失败 HTTP {e.code}: {detail}")

    result = decode_json_object(payload, label="DashScope 创建音色响应")
    voice_id = find_value(result, ("voice_id", "voice", "id"))
    if not voice_id:
        raise SystemExit(f"创建音色成功但没有找到 voice_id，响应内容: {payload}")
    return voice_id, result


def query_voice(voice_id: str) -> dict:
    load_dotenv()
    api_key = os.environ.get("DASHSCOPE_API_KEY", "").strip()
    if not api_key:
        raise SystemExit("DASHSCOPE_API_KEY is missing in .env")
    endpoint = dashscope_url(
        "api/v1/services/audio/tts/customization",
        override_env="DASHSCOPE_VOICE_CUSTOMIZATION_URL",
        default="https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization",
    )
    body = {
        "model": "voice-enrollment",
        "input": {
            "action": "query_voice",
            "voice_id": voice_id,
        },
    }
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        endpoint,
        data=data,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urlopen_with_retry(req, timeout=120, label="查询 DashScope 音色") as resp:
        payload = read_http_response_text(resp)
    return decode_json_object(payload, label="DashScope 查询音色响应")


def list_local_templates() -> None:
    template_dir = data_root() / "voice_templates"
    if not template_dir.exists():
        return
    files = sorted(template_dir.glob("*.mp3"))
    if not files:
        return
    print("\n本地声音样本目录:")
    print(template_dir)
    for i, p in enumerate(files, 1):
        print(f"  {i}. {p.name}")
    print("\n现在支持直接选择本地 mp3，脚本会自动上传到百炼临时存储后再创建音色。")


def choose_local_template() -> Path | None:
    template_dir = data_root() / "voice_templates"
    files = sorted(template_dir.glob("*.mp3")) if template_dir.exists() else []
    if not files:
        return None
    print("\n请选择本地声音样本：")
    for i, p in enumerate(files, 1):
        print(f"  {i}. {p.name}")
    print("  0. 手动输入 URL")
    answer = input("请输入编号，默认 1: ").strip() or "1"
    if answer == "0":
        return None
    try:
        idx = int(answer)
    except ValueError:
        idx = 1
    idx = max(1, min(idx, len(files)))
    return files[idx - 1]


def main() -> None:
    load_dotenv()
    ap = argparse.ArgumentParser(description="Register DashScope/CosyVoice custom voice template")
    ap.add_argument("--audio-url", default="", help="publicly accessible audio URL")
    ap.add_argument("--file", default="", help="local audio file, will be uploaded to DashScope temporary storage")
    ap.add_argument("--prefix", default=os.environ.get("DASHSCOPE_TTS_VOICE_PREFIX", "myvoice01"), help="voice prefix, English letters and numbers only")
    ap.add_argument("--target-model", default=os.environ.get("DASHSCOPE_TTS_MODEL", "cosyvoice-v3-flash"))
    ap.add_argument("--upload-model", default=os.environ.get("DASHSCOPE_VOICE_UPLOAD_MODEL", "voice-enrollment"))
    ap.add_argument("--language", default=os.environ.get("DASHSCOPE_TTS_LANGUAGE_HINT", "zh"), help="language hint, e.g. zh/en/ja")
    ap.add_argument("--query", default="", help="query existing voice id")
    args = ap.parse_args()

    if args.query.strip():
        info = query_voice(args.query.strip())
        print(json.dumps(info, ensure_ascii=False, indent=2))
        return

    list_local_templates()
    api_key = os.environ.get("DASHSCOPE_API_KEY", "").strip()
    if not api_key:
        raise SystemExit("DASHSCOPE_API_KEY is missing in .env")

    audio_url = args.audio_url.strip()
    local_file = Path(args.file).expanduser() if args.file.strip() else None
    if not audio_url and local_file is None:
        local_file = choose_local_template()
    if local_file is not None:
        print(f"\n正在上传声音样本到百炼临时存储: {local_file}")
        print(f"上传绑定模型: {args.upload_model}")
        audio_url = upload_file_to_dashscope_temp(api_key, local_file, args.upload_model.strip())
        print(f"临时 URL: {audio_url}")
    if not audio_url:
        audio_url = input("\n请输入声音样本 URL，可填 http/https 或 oss://: ").strip()

    prefix = args.prefix.strip() or "myvoice01"
    if not re.match(r"^[A-Za-z0-9]+$", prefix):
        print(f"prefix 不合法: {prefix}")
        print("阿里接口要求 prefix 只能包含英文字母和数字，不能有中文、空格、下划线。")
        prefix = "myvoice01"
        print(f"已自动改用: {prefix}")

    language = args.language.strip()
    language_hints = [language] if language else None
    target_model = args.target_model.strip()
    upload_model = args.upload_model.strip()
    voice_id, result = create_voice(audio_url, prefix, target_model, language_hints)
    save_voice_record(
        voice_id=voice_id,
        local_file=local_file,
        audio_url=audio_url,
        prefix=prefix,
        target_model=target_model,
        upload_model=upload_model,
        language=language,
        response=result,
    )

    config_path = env_path()
    update_env_value(config_path, "DASHSCOPE_TTS_VOICE_TEMPLATE", voice_id)
    update_env_value(config_path, "DASHSCOPE_TTS_MODEL", target_model)
    update_env_value(config_path, "DASHSCOPE_VOICE_UPLOAD_MODEL", upload_model)
    update_env_value(config_path, "DASHSCOPE_TTS_VOICE_PREFIX", prefix)
    update_env_value(config_path, "DASHSCOPE_TTS_LANGUAGE_HINT", language)

    print("\n音色注册成功。")
    print(f"voice_id: {voice_id}")
    print(f"已写入: {config_path}")
    print("\n完整响应:")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
