from __future__ import annotations

import json
import py_compile
import shutil
import traceback
from pathlib import Path
from typing import Any, Callable

try:
    from common import load_prompt_template
except ImportError:  # pragma: no cover
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from common import load_prompt_template

from .logger import AgentLogger, default_logger
from .models import AnimationAgentResult
from .skill_loader import load_engine_skill, write_skill_snapshot
from .source_utils import (
    extract_source as _extract_source,
    short_error as _short_error,
    strip_code_fence as _strip_code_fence,
)
from json_io import atomic_write_json

ModelCaller = Callable[[list[dict], float], Any]
SourceValidator = Callable[[str], None]
SourceMutator = Callable[[str], str]
PreviewRenderer = Callable[[Path, Path], Path]


def strip_code_fence(text: str) -> str:
    return _strip_code_fence(text, {"python", "py"})


def extract_source(model_result: Any) -> str:
    return _extract_source(model_result, {"python", "py"})


def short_error(error: str, limit: int = 6000) -> str:
    return _short_error(error, limit)


write_json = atomic_write_json


def build_generate_messages(plan: dict, skill_text: str) -> list[dict]:
    return [
        {
            "role": "system",
            "content": load_prompt_template("manim_agent_generate.md").strip(),
        },
        {
            "role": "user",
            "content": json.dumps(
                {
                    "engine_skill": skill_text,
                    "task": "generate_manim_animation_source",
                    "output_schema": {"source": "完整 Python 代码字符串"},
                    "shot_plan": plan,
                },
                ensure_ascii=False,
            ),
        },
    ]


def build_repair_messages(plan: dict, skill_text: str, previous_source: str, error: str, attempt: int) -> list[dict]:
    return [
        {
            "role": "system",
            "content": load_prompt_template("manim_agent_repair.md").strip(),
        },
        {
            "role": "user",
            "content": json.dumps(
                {
                    "engine_skill": skill_text,
                    "task": "repair_manim_animation_source",
                    "attempt": attempt,
                    "shot_plan": plan,
                    "previous_source": previous_source,
                    "error_log": short_error(error),
                    "output_schema": {"source": "修复后的完整 Python 代码字符串"},
                },
                ensure_ascii=False,
            ),
        },
    ]


def compile_source(source_path: Path) -> None:
    py_compile.compile(str(source_path), doraise=True)


def run_manim_animation_agent(
    *,
    plan: dict,
    run_dir: Path,
    call_model: ModelCaller,
    validate_source: SourceValidator,
    inject_prelude: SourceMutator,
    render_preview: PreviewRenderer,
    max_attempts: int = 3,
    logger: AgentLogger | None = None,
) -> AnimationAgentResult:
    logger = logger or default_logger()
    max_attempts = max(1, min(int(max_attempts or 3), 5))
    agent_dir = run_dir / "animation_agent"
    agent_dir.mkdir(parents=True, exist_ok=True)
    skill_text = load_engine_skill("manim")
    skill_snapshot = write_skill_snapshot("manim", agent_dir)
    atomic_write_json(agent_dir / "request.json", {"engine": "manim", "max_attempts": max_attempts, "plan": plan})
    logger.stage(f"Manim Agent 已加载 skill，最多尝试 {max_attempts} 次。")

    attempts: list[dict] = []
    previous_source = ""
    previous_error = ""

    for attempt in range(1, max_attempts + 1):
        attempt_dir = agent_dir / f"attempt_{attempt:02d}"
        attempt_dir.mkdir(parents=True, exist_ok=True)
        source_path = attempt_dir / "scene.py"
        messages = (
            build_repair_messages(plan, skill_text, previous_source, previous_error, attempt)
            if previous_error
            else build_generate_messages(plan, skill_text)
        )
        atomic_write_json(attempt_dir / "messages.json", {"messages": messages})

        record = {
            "attempt": attempt,
            "skill_path": str(skill_snapshot),
            "source_path": str(source_path),
            "status": "running",
        }
        try:
            if previous_error:
                label = f"Manim 第 {attempt}/{max_attempts} 次修复代码"
            else:
                label = f"Manim 第 {attempt}/{max_attempts} 次生成代码"
            model_result = logger.model_call(label, lambda: call_model(messages, 0.25 if previous_error else 0.35))
            logger.stage("Manim 已收到代码，正在注入安全前置代码并写入文件...")
            source = inject_prelude(extract_source(model_result))
            source_path.write_text(source, encoding="utf-8")
            logger.source_written(source_path, source)
            previous_source = source

            logger.stage("Manim 正在做源码安全校验和 Python 编译检查...")
            validate_source(source)
            compile_source(source_path)
            logger.stage("Manim 校验通过，开始预渲染。")
            rendered_path = render_preview(source_path, attempt_dir)

            final_source = run_dir / "scene.py"
            shutil.copy2(source_path, final_source)
            record.update(
                {
                    "status": "success",
                    "rendered_path": str(rendered_path),
                    "final_source_path": str(final_source),
                }
            )
            attempts.append(record)
            logger.stage(f"Manim 预渲染成功: {rendered_path}")
            state_path = agent_dir / "agent_state.json"
            atomic_write_json(
                state_path,
                {
                    "status": "success",
                    "engine": "manim",
                    "attempts": attempts,
                    "source_path": str(final_source),
                    "rendered_path": str(rendered_path),
                },
            )
            return AnimationAgentResult(
                ok=True,
                engine="manim",
                source_path=final_source,
                rendered_path=rendered_path,
                state_path=state_path,
                attempts=attempts,
            )
        except Exception as exc:
            error = short_error("".join(traceback.format_exception_only(type(exc), exc)))
            if not error:
                error = short_error(traceback.format_exc())
            previous_error = error
            (attempt_dir / "error.log").write_text(error, encoding="utf-8")
            record.update({"status": "failed", "error": error})
            attempts.append(record)
            logger.stage(f"Manim 第 {attempt}/{max_attempts} 次失败: {error}")

    state_path = agent_dir / "agent_state.json"
    atomic_write_json(
        state_path,
        {
            "status": "failed",
            "engine": "manim",
            "attempts": attempts,
            "error": previous_error,
        },
    )
    return AnimationAgentResult(
        ok=False,
        engine="manim",
        state_path=state_path,
        attempts=attempts,
        error=previous_error,
    )
