from __future__ import annotations

import json
import shutil
import traceback
from pathlib import Path
from typing import Any, Callable

try:
    from common import load_prompt_template, render_prompt_template
except ImportError:  # pragma: no cover
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from common import load_prompt_template, render_prompt_template

from .logger import AgentLogger, default_logger
from .models import AnimationAgentResult
from .skill_loader import load_engine_skill, write_skill_snapshot
from .source_utils import (
    extract_source as _extract_source,
    short_error as _short_error,
    strip_code_fence as _strip_code_fence,
    validate_source_filename,
)
from json_io import atomic_write_json

ModelCaller = Callable[[list[dict], float], Any]
SourceValidator = Callable[[str], None]
SourceMutator = Callable[[str], str]
SourceReviewer = Callable[[str], None]
PreviewRenderer = Callable[[Path, Path], Path]


def strip_code_fence(text: str) -> str:
    return _strip_code_fence(text, {"html", "jsx", "tsx", "javascript", "js"})


def extract_source(model_result: Any) -> str:
    return _extract_source(
        model_result,
        {"html", "jsx", "tsx", "javascript", "js"},
    )


def short_error(error: str, limit: int = 8000) -> str:
    return _short_error(error, limit)


write_json = atomic_write_json


def build_messages(
    *,
    engine: str,
    task: str,
    plan: dict,
    skill_text: str,
    previous_source: str = "",
    error: str = "",
    attempt: int = 1,
) -> list[dict]:
    adherence_instruction = ""
    if engine == "hyperframes":
        adherence_instruction = (
            "shot_plan.brief 是最高优先级内容契约。"
            "必须保留 brief 里的具体主题、对象、流程、专有名词和用户要求的动画效果。"
            "不要把具体需求替换成通用科技架构图、泛泛的数据看板或随机卡片。"
            "生成的 HTML 可见文本、结构和动画逻辑必须能明显对应 brief。"
        )
    if error:
        instruction = render_prompt_template(
            load_prompt_template("web_agent_repair.md"),
            {
                "engine": engine,
                "adherence_instruction": adherence_instruction,
            },
        )
        payload = {
            "engine_skill": skill_text,
            "task": f"repair_{task}",
            "attempt": attempt,
            "shot_plan": plan,
            "previous_source": previous_source,
            "error_log": short_error(error),
            "output_schema": {"source": "修复后的完整代码字符串"},
        }
    else:
        instruction = render_prompt_template(
            load_prompt_template("web_agent_generate.md"),
            {
                "engine": engine,
                "adherence_instruction": adherence_instruction,
            },
        )
        payload = {
            "engine_skill": skill_text,
            "task": task,
            "output_schema": {"source": "完整代码字符串"},
            "shot_plan": plan,
        }
    return [
        {"role": "system", "content": instruction},
        {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
    ]


def run_web_animation_agent(
    *,
    engine: str,
    task: str,
    source_filename: str,
    plan: dict,
    run_dir: Path,
    call_model: ModelCaller,
    validate_source: SourceValidator,
    render_preview: PreviewRenderer,
    max_attempts: int = 3,
    skill_sections: list[str] | None = None,
    logger: AgentLogger | None = None,
    source_mutator: SourceMutator | None = None,
    source_reviewer: SourceReviewer | None = None,
) -> AnimationAgentResult:
    logger = logger or default_logger()
    source_filename = validate_source_filename(source_filename)
    max_attempts = max(1, min(int(max_attempts or 3), 5))
    agent_dir = run_dir / "animation_agent"
    agent_dir.mkdir(parents=True, exist_ok=True)
    skill_text = load_engine_skill(engine, skill_sections)
    skill_snapshot = write_skill_snapshot(engine, agent_dir)
    logger.stage(f"{engine} Agent 已加载 skill，最多尝试 {max_attempts} 次。")
    atomic_write_json(
        agent_dir / "request.json",
        {
            "engine": engine,
            "task": task,
            "source_filename": source_filename,
            "max_attempts": max_attempts,
            "skill_sections": skill_sections or [],
            "plan": plan,
        },
    )

    attempts: list[dict] = []
    previous_source = ""
    previous_error = ""

    for attempt in range(1, max_attempts + 1):
        attempt_dir = agent_dir / f"attempt_{attempt:02d}"
        attempt_dir.mkdir(parents=True, exist_ok=True)
        source_path = attempt_dir / source_filename
        messages = build_messages(
            engine=engine,
            task=task,
            plan=plan,
            skill_text=skill_text,
            previous_source=previous_source,
            error=previous_error,
            attempt=attempt,
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
                label = f"{engine} 第 {attempt}/{max_attempts} 次修复代码"
            else:
                label = f"{engine} 第 {attempt}/{max_attempts} 次生成代码"
            model_result = logger.model_call(label, lambda: call_model(messages, 0.25 if previous_error else 0.35))
            logger.stage(f"{engine} 已收到代码，正在校验源码...")
            source = extract_source(model_result)
            if source_mutator:
                source = source_mutator(source)
            source_path.write_text(source, encoding="utf-8")
            logger.source_written(source_path, source)
            previous_source = source
            validate_source(source)
            if source_reviewer:
                logger.stage(f"{engine} 正在核对生成内容是否符合原始描述...")
                source_reviewer(source)
            logger.stage(f"{engine} 校验通过，开始预渲染。")
            rendered_path = render_preview(source_path, attempt_dir)

            final_source = run_dir / source_filename
            shutil.copy2(source_path, final_source)
            record.update(
                {
                    "status": "success",
                    "rendered_path": str(rendered_path),
                    "final_source_path": str(final_source),
                }
            )
            attempts.append(record)
            logger.stage(f"{engine} 预渲染成功: {rendered_path}")
            state_path = agent_dir / "agent_state.json"
            atomic_write_json(
                state_path,
                {
                    "status": "success",
                    "engine": engine,
                    "attempts": attempts,
                    "source_path": str(final_source),
                    "rendered_path": str(rendered_path),
                },
            )
            return AnimationAgentResult(
                ok=True,
                engine=engine,
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
            logger.stage(f"{engine} 第 {attempt}/{max_attempts} 次失败: {error}")

    state_path = agent_dir / "agent_state.json"
    atomic_write_json(
        state_path,
        {
            "status": "failed",
            "engine": engine,
            "attempts": attempts,
            "error": previous_error,
        },
    )
    return AnimationAgentResult(
        ok=False,
        engine=engine,
        state_path=state_path,
        attempts=attempts,
        error=previous_error,
    )
