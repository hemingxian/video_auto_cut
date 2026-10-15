from __future__ import annotations

import json
import os
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from pathlib import Path
from typing import Callable, TypeVar

T = TypeVar("T")


class AgentLogger:
    def __init__(self, prefix: str = "[素材生成]", heartbeat_seconds: float = 10.0) -> None:
        self.prefix = prefix
        self.heartbeat_seconds = max(3.0, float(heartbeat_seconds or 10.0))

    def stage(self, message: str) -> None:
        print(f"{self.prefix} {message}", flush=True)

    def command(self, cmd: list[str]) -> None:
        print(">>>", " ".join(json.dumps(part, ensure_ascii=False) for part in cmd), flush=True)

    def model_call(self, label: str, fn: Callable[[], T]) -> T:
        self.stage(f"{label}，正在等待大模型返回...")
        started_at = time.monotonic()
        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(fn)
            while True:
                try:
                    result = future.result(timeout=self.heartbeat_seconds)
                    break
                except TimeoutError:
                    waited = int(time.monotonic() - started_at)
                    self.stage(f"{label}，已等待 {waited}s")
        elapsed = time.monotonic() - started_at
        self.stage(f"{label} 完成，用时 {elapsed:.1f}s")
        return result

    def source_written(self, source_path: Path, source: str) -> None:
        line_count = len(source.splitlines())
        byte_count = len(source.encode("utf-8"))
        self.stage(f"代码已写入: {source_path} ({line_count} 行，{byte_count} bytes)")
        if os.environ.get("VIDEOAUTO_PRINT_GENERATED_SOURCE", "").strip() == "1":
            print("----- BEGIN GENERATED SOURCE -----", flush=True)
            print(source, flush=True)
            print("----- END GENERATED SOURCE -----", flush=True)

    def stream_command(
        self,
        cmd: list[str],
        *,
        cwd: Path | None = None,
        env: dict[str, str] | None = None,
        log_path: Path,
        append: bool = False,
    ) -> int:
        self.command(cmd)
        log_path.parent.mkdir(parents=True, exist_ok=True)
        mode = "a" if append else "w"
        with log_path.open(mode, encoding="utf-8") as handle:
            proc = subprocess.Popen(
                cmd,
                cwd=str(cwd) if cwd else None,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            assert proc.stdout is not None
            for line in proc.stdout:
                print(line, end="", flush=True)
                handle.write(line)
                handle.flush()
            return proc.wait()


def default_logger() -> AgentLogger:
    seconds = os.environ.get("VIDEOAUTO_AGENT_LOG_HEARTBEAT_SECONDS", "10")
    try:
        heartbeat_seconds = float(seconds)
    except ValueError:
        heartbeat_seconds = 10.0
    return AgentLogger(heartbeat_seconds=heartbeat_seconds)
