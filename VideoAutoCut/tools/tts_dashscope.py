#!/usr/bin/env python3
# -*- coding: utf-8 -*-
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import dashscope_url, load_dotenv, read_http_response_bytes, read_http_response_text, urlopen_with_retry
from json_io import atomic_write_bytes, decode_json_object


def find_audio_url(obj):
    if isinstance(obj, str):
        return obj if obj.startswith(("http://", "https://")) else None
    if isinstance(obj, list):
        for x in obj:
            u = find_audio_url(x)
            if u:
                return u
    if isinstance(obj, dict):
        for k in ("url", "audio_url", "file_url", "output_url"):
            if k in obj:
                u = find_audio_url(obj[k])
                if u:
                    return u
        for v in obj.values():
            u = find_audio_url(v)
            if u:
                return u
    return None


def resolve_voice(voice: str | None = None) -> str:
    """Resolve voice / voice-template id.

    Priority:
    1. CLI or caller provided voice.
    2. DASHSCOPE_TTS_VOICE_TEMPLATE in .env, for custom voice template / cloned voice id.
    3. DASHSCOPE_TTS_VOICE in .env, for built-in voice.
    4. longanyang default voice.
    """
    load_dotenv()
    return (
        (voice or "").strip()
        or os.environ.get("DASHSCOPE_TTS_VOICE_TEMPLATE", "").strip()
        or os.environ.get("DASHSCOPE_TTS_VOICE_ID", "").strip()
        or os.environ.get("DASHSCOPE_TTS_VOICE", "").strip()
        or "longanyang"
    )


def download_with_retry(url: str, output: Path, attempts: int = 6) -> None:
    try:
        with urlopen_with_retry(url, timeout=120, attempts=attempts, label="下载 TTS 音频") as resp:
            atomic_write_bytes(output, read_http_response_bytes(resp))
    except urllib.error.HTTPError as e:
        detail = read_http_response_text(e)
        raise SystemExit(f"TTS 音频下载失败 HTTP {e.code}: {detail}")
    except Exception as e:
        raise SystemExit(f"TTS 音频下载多次失败: {e}")


def synthesize(text: str, output: Path, voice: str | None = None, *, enable_ssml: bool = False) -> None:
    load_dotenv()
    api_key = os.environ.get("DASHSCOPE_API_KEY", "").strip()
    if not api_key:
        raise SystemExit("DASHSCOPE_API_KEY is missing in .env")
    model = os.environ.get("DASHSCOPE_TTS_MODEL", "cosyvoice-v3-flash")
    voice = resolve_voice(voice)
    fmt = os.environ.get("DASHSCOPE_TTS_FORMAT", "mp3")
    sample_rate = int(os.environ.get("DASHSCOPE_TTS_SAMPLE_RATE", "24000"))
    url = dashscope_url(
        "api/v1/services/audio/tts/SpeechSynthesizer",
        override_env="DASHSCOPE_TTS_URL",
        default="https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer",
    )
    input_body = {
        "text": text,
        "voice": voice,
        "format": fmt,
        "sample_rate": sample_rate,
    }
    if enable_ssml:
        input_body["enable_ssml"] = True
    body = {
        "model": model,
        "input": input_body,
    }
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "X-DashScope-SSE": "disable",
        },
        method="POST",
    )
    try:
        with urlopen_with_retry(req, timeout=120, label="DashScope TTS") as resp:
            payload = read_http_response_text(resp)
    except urllib.error.HTTPError as e:
        detail = read_http_response_text(e)
        raise SystemExit(f"DashScope TTS HTTP {e.code}: {detail}")
    result = decode_json_object(payload, label="DashScope TTS 响应")
    audio_url = find_audio_url(result)
    if not audio_url:
        raise SystemExit(f"No audio url in TTS response: {payload}")
    output.parent.mkdir(parents=True, exist_ok=True)
    download_with_retry(audio_url, output)
    print(f"voice saved: {output}")
    print(f"voice template: {voice}")


def main():
    ap = argparse.ArgumentParser(description="Generate voiceover audio using DashScope TTS")
    ap.add_argument("--text", help="voice text")
    ap.add_argument("--text-file", help="read voice text from UTF-8 file")
    ap.add_argument("--output", "-o", default="voice.mp3")
    ap.add_argument("--voice", default="", help="voice template / voice id, overrides .env")
    ap.add_argument("--voice-template", default="", help="alias of --voice")
    args = ap.parse_args()
    text = args.text or ""
    if args.text_file:
        text = Path(args.text_file).read_text(encoding="utf-8")
    text = text.strip()
    if not text:
        raise SystemExit("empty text")
    voice = args.voice_template or args.voice
    synthesize(text, Path(args.output), voice=voice)


if __name__ == "__main__":
    main()
