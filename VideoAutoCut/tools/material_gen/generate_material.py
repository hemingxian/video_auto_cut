#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generate video materials through background animation coding agents.

The material generator is intentionally coding-agent-only:
- A planner chooses the animation engine from the natural-language brief.
- The selected engine agent writes executable animation code.
- The code is validated, preview-rendered, repaired on failure, and saved.

No preset visual route is used in this entrypoint.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

TOOLS_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS_DIR))

from animation_agent.logger import AgentLogger, default_logger  # noqa: E402
from animation_agent.manim_agent import run_manim_animation_agent  # noqa: E402
from animation_agent.web_agent import run_web_animation_agent  # noqa: E402
from common import data_root, load_dotenv, load_prompt_template, runtime_root  # noqa: E402
from json_io import atomic_write_json  # noqa: E402

try:
    from optimize_queries import call_qwen  # type: ignore
except Exception:  # pragma: no cover
    call_qwen = None

MATERIAL_ENGINES = {"manim", "remotion", "hyperframes"}
VIDEO_EXT = ".mp4"


def safe_name(text: str, max_len: int = 42) -> str:
    value = re.sub(r"\s+", "_", (text or "").strip())
    value = re.sub(r"[\\/:*?\"<>|]+", "_", value)
    value = re.sub(r"_+", "_", value).strip("._-")
    return (value or "generated_material")[:max_len]


def now_id() -> str:
    return datetime.now().strftime("%Y%m%d_%H%M%S")


def records_path(root: Path) -> Path:
    return root / "tools" / "material_gen" / "records" / "generated_materials.json"


def read_records(root: Path) -> list[dict]:
    path = records_path(root)
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except Exception:
        return []


def write_records(root: Path, records: list[dict]) -> None:
    path = records_path(root)
    atomic_write_json(path, records)


def read_text_tail(path: Path, limit: int = 8000) -> str:
    if not path.exists():
        return ""
    text = path.read_text(encoding="utf-8", errors="replace")
    return text[-limit:] if len(text) > limit else text


def to_duration_seconds(value: Any, default: float = 12.0) -> float:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        parsed = float(value)
    else:
        match = re.search(r"\d+(?:\.\d+)?", str(value or ""))
        parsed = float(match.group(0)) if match else default
    return max(1.0, min(180.0, parsed))


def to_timeline_seconds(value: Any, default: float = 0.0) -> float:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        parsed = float(value)
    else:
        match = re.search(r"\d+(?:\.\d+)?", str(value or ""))
        parsed = float(match.group(0)) if match else default
    return max(0.0, min(180.0, parsed))


def validate_engine(value: Any) -> str:
    engine = str(value or "").strip().lower()
    if engine not in MATERIAL_ENGINES:
        raise ValueError(f"模型返回了不支持的动画引擎: {value}")
    return engine


def plan_material(prompt: str, engine_preference: str, logger: AgentLogger) -> dict:
    if call_qwen is None or not os.environ.get("DASHSCOPE_API_KEY", "").strip():
        raise SystemExit("缺少 DASHSCOPE_API_KEY，无法规划素材生成任务")

    preferred = str(engine_preference or "auto").strip().lower()
    if preferred not in MATERIAL_ENGINES and preferred != "auto":
        raise SystemExit(f"不支持的素材生成引擎: {engine_preference}")

    messages = [
        {
            "role": "system",
            "content": load_prompt_template("material_plan.md").strip(),
        },
        {
            "role": "user",
            "content": json.dumps(
                {
                    "engine_preference": preferred,
                    "brief": prompt,
                },
                ensure_ascii=False,
            ),
        },
    ]
    obj = logger.model_call("大模型正在理解文案并选择动画引擎", lambda: call_qwen(messages, temperature=0.15))

    if not isinstance(obj, dict):
        raise SystemExit("AI 素材规划失败: 模型没有返回 JSON 对象")

    selected_engine = preferred if preferred in MATERIAL_ENGINES else validate_engine(obj.get("engine"))
    plan = {
        "engine": selected_engine,
        "generation_mode": "ai_code",
        "title": str(obj.get("title") or prompt[:32] or "AI 生成素材"),
        "subtitle": str(obj.get("subtitle") or ""),
        "duration": to_duration_seconds(obj.get("duration"), default=12.0),
        "description": prompt,
        "brief": prompt,
    }
    logger.stage(f"规划完成：engine={plan['engine']}，duration={plan['duration']}s，title={plan['title']}")
    return plan


def find_newest_mp4(root: Path) -> Path | None:
    files = list(root.rglob("*.mp4"))
    if not files:
        return None
    return max(files, key=lambda p: p.stat().st_mtime)


def render_manim_agent_preview(root: Path, source_path: Path, attempt_dir: Path, logger: AgentLogger) -> Path:
    if importlib.util.find_spec("manim") is None:
        raise RuntimeError("Manim 未安装在当前 embedded Python 中，无法生成 Manim 素材。请先安装/封装 Manim。")

    ffmpeg_bin = root / "ffmpeg" / "bin"
    env = os.environ.copy()
    if ffmpeg_bin.exists():
        env["PATH"] = str(ffmpeg_bin) + os.pathsep + env.get("PATH", "")

    media_dir = attempt_dir / "manim_media"
    log_path = attempt_dir / "render.log"
    cmd = [sys.executable, "-m", "manim", "-ql", "--media_dir", str(media_dir), str(source_path), "GeneratedMaterialScene"]
    logger.stage("Manim 开始预渲染...")
    returncode = logger.stream_command(cmd, env=env, log_path=log_path)
    if returncode != 0:
        raise RuntimeError(f"Manim 预渲染失败，退出码 {returncode}\n{read_text_tail(log_path)}")
    output = find_newest_mp4(media_dir)
    if not output:
        raise RuntimeError(f"Manim 预渲染完成但没有找到输出 mp4。\n{read_text_tail(log_path)}")
    return output


def find_node_runtime(root: Path) -> Path | None:
    candidates: list[Path] = []
    for env_name in ("VIDEOAUTO_NODE_EXE", "HYPERFRAMES_NODE_EXE", "REMOTION_NODE_EXE"):
        configured = os.environ.get(env_name, "").strip()
        if configured:
            candidates.append(Path(configured))
    candidates += [
        root / "node-runtime" / "node.exe",
        root / "node" / "node.exe",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return None


def render_remotion_dynamic(root: Path, component_path: Path, plan_path: Path, attempt_dir: Path, logger: AgentLogger) -> Path:
    node = find_node_runtime(root)
    if not node:
        raise RuntimeError("没有找到独立 Node runtime。请将 node.exe 放到 VideoAutoCut/node-runtime/node.exe。")
    runner = root / "tools" / "material_gen" / "remotion" / "render.mjs"
    if not runner.exists():
        raise RuntimeError(f"没有找到 Remotion 渲染器: {runner}")

    output = attempt_dir / "remotion_output.mp4"
    log_path = attempt_dir / "render.log"
    cmd = [str(node), str(runner), "--plan", str(plan_path), "--output", str(output), "--component", str(component_path)]
    logger.stage("Remotion 开始打包并预渲染...")
    returncode = logger.stream_command(cmd, cwd=runner.parent, log_path=log_path)
    if returncode != 0:
        raise RuntimeError(f"Remotion 预渲染失败，退出码 {returncode}\n{read_text_tail(log_path)}")
    if not output.exists():
        raise RuntimeError(f"Remotion 渲染完成但没有找到输出 mp4。\n{read_text_tail(log_path)}")
    return output


def find_hyperframes_cli(root: Path) -> Path | None:
    configured = os.environ.get("HYPERFRAMES_CLI", "").strip()
    candidates = [Path(configured)] if configured else []
    candidates += [
        root / "tools" / "material_gen" / "hyperframes" / "node_modules" / "hyperframes" / "dist" / "cli.js",
        root / "tools" / "material_gen" / "hyperframes" / "dist" / "cli.js",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return None


def find_hyperframes_gsap(root: Path) -> Path | None:
    configured = os.environ.get("HYPERFRAMES_GSAP", "").strip()
    candidates = [Path(configured)] if configured else []
    candidates.append(root / "tools" / "material_gen" / "hyperframes" / "node_modules" / "gsap" / "dist" / "gsap.min.js")
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return None


def find_hyperframes_browser(root: Path) -> Path | None:
    configured = os.environ.get("HYPERFRAMES_BROWSER_PATH", "").strip()
    candidates = [Path(configured)] if configured else []
    candidates += [
        root / "tools" / "material_gen" / "remotion" / "node_modules" / ".remotion"
        / "chrome-headless-shell" / "win64" / "chrome-headless-shell-win64" / "chrome-headless-shell.exe",
        root / "tools" / "material_gen" / "hyperframes" / "chrome-headless-shell" / "chrome-headless-shell.exe",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return None


def prepare_hyperframes_assets(root: Path, attempt_dir: Path) -> None:
    gsap = find_hyperframes_gsap(root)
    if not gsap:
        raise RuntimeError(
            "没有找到 HyperFrames 所需的 GSAP。请在 VideoAutoCut/tools/material_gen/hyperframes 执行 npm install，"
            "或在运行时包中打包 node_modules/gsap。"
        )
    shutil.copy2(gsap, attempt_dir / "gsap.min.js")


def run_logged_command(cmd: list[str], cwd: Path, env: dict[str, str], log_path: Path, logger: AgentLogger) -> None:
    returncode = logger.stream_command(cmd, cwd=cwd, env=env, log_path=log_path, append=True)
    if returncode != 0:
        raise RuntimeError(f"命令执行失败，退出码 {returncode}\n{read_text_tail(log_path)}")


def render_hyperframes_dynamic(root: Path, html_path: Path, attempt_dir: Path, logger: AgentLogger) -> Path:
    node = find_node_runtime(root)
    if not node:
        raise RuntimeError("没有找到独立 Node runtime。请将 node.exe 放到 VideoAutoCut/node-runtime/node.exe。")
    cli = find_hyperframes_cli(root)
    if not cli:
        raise RuntimeError(
            "没有找到 HyperFrames CLI。请在 VideoAutoCut/tools/material_gen/hyperframes 执行 npm install，"
            "或在运行时包中打包 node_modules/hyperframes。"
        )
    browser = find_hyperframes_browser(root)
    if not browser:
        raise RuntimeError(
            "没有找到 HyperFrames 可用的 Chrome Headless Shell。请打包 Remotion 的 chrome-headless-shell，"
            "或设置 HYPERFRAMES_BROWSER_PATH 指向 chrome-headless-shell.exe。"
        )

    prepare_hyperframes_assets(root, attempt_dir)
    ffmpeg_bin = root / "ffmpeg" / "bin"
    env = os.environ.copy()
    if ffmpeg_bin.exists():
        env["PATH"] = str(ffmpeg_bin) + os.pathsep + env.get("PATH", "")
    ffmpeg = ffmpeg_bin / "ffmpeg.exe"
    ffprobe = ffmpeg_bin / "ffprobe.exe"
    if ffmpeg.exists():
        env["HYPERFRAMES_FFMPEG_PATH"] = str(ffmpeg)
    if ffprobe.exists():
        env["HYPERFRAMES_FFPROBE_PATH"] = str(ffprobe)
    env["HYPERFRAMES_BROWSER_PATH"] = str(browser)
    env["HYPERFRAMES_NO_TELEMETRY"] = "1"
    env["HYPERFRAMES_NO_UPDATE_CHECK"] = "1"

    output = attempt_dir / "hyperframes_output.mp4"
    log_path = attempt_dir / "render.log"
    logger.stage("HyperFrames 开始校验动画工程...")
    run_logged_command([str(node), str(cli), "lint", str(attempt_dir)], attempt_dir, env, log_path, logger)
    logger.stage("HyperFrames 开始预渲染...")
    run_logged_command(
        [
            str(node),
            str(cli),
            "render",
            str(attempt_dir),
            "-c",
            html_path.name,
            "-o",
            str(output),
            "--fps",
            "30",
            "--quality",
            "standard",
            "--workers",
            "1",
            "--low-memory-mode",
            "--no-browser-gpu",
        ],
        attempt_dir,
        env,
        log_path,
        logger,
    )
    if not output.exists():
        raise RuntimeError(f"HyperFrames 渲染完成但没有找到输出 mp4。\n{read_text_tail(log_path)}")
    return output


def validate_no_network_source(source: str, *, allow_remote_urls: bool = False) -> None:
    blocked_patterns = [
        r"\bfetch\s*\(",
        r"\bXMLHttpRequest\b",
        r"\bWebSocket\b",
        r"\bEventSource\b",
        r"\brequests\.",
        r"\burllib\b",
        r"\bsocket\b",
        r"\bchild_process\b",
        r"\bprocess\.",
        r"from\s+['\"](?:fs|path|node:|http|https|axios|child_process)",
        r"require\s*\(\s*['\"](?:fs|path|node:|http|https|axios|child_process)",
    ]
    if not allow_remote_urls:
        blocked_patterns.insert(0, r"https?://")
    for pattern in blocked_patterns:
        if re.search(pattern, source, re.IGNORECASE):
            raise ValueError(f"代码包含不允许的网络或系统访问: {pattern}")


def validate_remotion_component_source(source: str) -> None:
    validate_no_network_source(source)
    if "AiGeneratedMaterialVideo" not in source:
        raise ValueError("Remotion 组件必须导出 AiGeneratedMaterialVideo")
    if not re.search(r"export\s+(const|function)\s+AiGeneratedMaterialVideo", source):
        raise ValueError("Remotion 组件必须使用 export const/function AiGeneratedMaterialVideo")
    if re.search(r"\b(interface|enum)\s+\w+", source):
        raise ValueError("Remotion 动态组件必须使用 JSX，不要使用 TypeScript interface/enum")
    if re.search(r"\)\s*:\s*[A-Za-z]", source) or re.search(r"\w+\s*:\s*(?:string|number|boolean|React\.)", source):
        raise ValueError("Remotion 动态组件必须使用 JSX，不要使用 TypeScript 类型标注")


def validate_hyperframes_html_source(source: str) -> None:
    validate_no_network_source(source, allow_remote_urls=True)
    lowered = source.lower()
    if "<!doctype html" not in lowered and "<html" not in lowered:
        raise ValueError("HyperFrames 代码必须是完整 HTML 文档")
    if 'id="root"' not in lowered and "id='root'" not in lowered:
        raise ValueError("HyperFrames HTML 必须包含 id=\"root\" 根容器")
    if re.search(r"(?:src|href)\s*=\s*['\"]\s*javascript:", source, re.IGNORECASE):
        raise ValueError("HyperFrames HTML 不允许使用 javascript: URL")


def review_hyperframes_source_against_brief(source: str, plan: dict, logger: AgentLogger) -> None:
    source_excerpt = source[:70000]
    messages = [
        {
            "role": "system",
            "content": load_prompt_template("hyperframes_source_review.md").strip(),
        },
        {
            "role": "user",
            "content": json.dumps(
                {
                    "brief": plan.get("brief") or plan.get("description") or "",
                    "title": plan.get("title", ""),
                    "html_source_excerpt": source_excerpt,
                    "review_rules": [
                        "必须能在 HTML 可见文本、结构、类名或动画逻辑里看到 brief 的核心对象",
                        "必须覆盖 brief 里的主要流程或阶段",
                        "不能把具体需求替换成通用科技架构图",
                        "不能只做装饰性节点、卡片或背景动画",
                        "如果用户要求某些效果或对象，必须在源码中有对应表达",
                    ],
                },
                ensure_ascii=False,
            ),
        },
    ]
    result = logger.model_call("HyperFrames 正在审核生成内容与原始描述的一致性", lambda: call_qwen(messages, temperature=0.05))
    if not isinstance(result, dict):
        raise ValueError("HyperFrames 内容审核失败：模型没有返回 JSON 对象")
    if result.get("ok") is True:
        logger.stage("HyperFrames 内容审核通过。")
        return

    issues = result.get("issues")
    fixes = result.get("required_fixes")
    issue_text = json.dumps({"issues": issues, "required_fixes": fixes}, ensure_ascii=False)
    raise ValueError(f"HyperFrames 内容没有按原始描述实现，需要重写: {issue_text}")


def copy_to_materials(root: Path, source: Path, name_hint: str) -> Path:
    materials = root / "video" / "materials" / "generated"
    materials.mkdir(parents=True, exist_ok=True)
    base = safe_name(name_hint)
    dest = materials / f"{base}{VIDEO_EXT}"
    index = 1
    while dest.exists():
        dest = materials / f"{base}_{index}{VIDEO_EXT}"
        index += 1
    shutil.copy2(source, dest)
    return dest


def build_record(run_id: str, prompt: str, plan: dict, run_dir: Path, source_path: Path, rendered_path: Path, output_path: Path, agent_state_path: str) -> dict:
    return {
        "id": run_id,
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "prompt": prompt,
        "engine": plan.get("engine", ""),
        "generation_mode": "ai_code",
        "title": plan.get("title", ""),
        "duration": plan.get("duration", 0),
        "plan_path": str(run_dir / "plan.json"),
        "prompt_path": str(run_dir / "prompt.txt"),
        "source_path": str(source_path),
        "animation_agent_state_path": agent_state_path,
        "record_dir": str(run_dir),
        "rendered_path": str(rendered_path),
        "output_path": str(output_path),
    }


def run_agent_for_engine(engine: str, plan: dict, run_dir: Path, runtime: Path, plan_path: Path, max_attempts: int, logger: AgentLogger):
    if engine == "manim":
        return run_manim_animation_agent(
            plan=plan,
            run_dir=run_dir,
            call_model=call_qwen,
            validate_source=validate_manim_source,
            inject_prelude=inject_manim_helper_prelude,
            render_preview=lambda source_path, attempt_dir: render_manim_agent_preview(runtime, source_path, attempt_dir, logger),
            max_attempts=max_attempts,
            logger=logger,
        )
    if engine == "remotion":
        return run_web_animation_agent(
            engine="remotion",
            task="generate_remotion_animation_component",
            source_filename="AiGeneratedMaterialVideo.jsx",
            plan=plan,
            run_dir=run_dir,
            call_model=call_qwen,
            validate_source=validate_remotion_component_source,
            render_preview=lambda source_path, attempt_dir: render_remotion_dynamic(runtime, source_path, plan_path, attempt_dir, logger),
            max_attempts=max_attempts,
            skill_sections=["timing", "transitions", "video-layout", "text-animations"],
            logger=logger,
        )
    if engine == "hyperframes":
        return run_web_animation_agent(
            engine="hyperframes",
            task="generate_hyperframes_animation_html",
            source_filename="index.html",
            plan=plan,
            run_dir=run_dir,
            call_model=call_qwen,
            validate_source=validate_hyperframes_html_source,
            render_preview=lambda source_path, attempt_dir: render_hyperframes_dynamic(runtime, source_path, attempt_dir, logger),
            max_attempts=max_attempts,
            skill_sections=["motion-graphics", "dynamic-content-sequencing", "gsap-effects", "stat-bars-and-fills"],
            logger=logger,
            source_reviewer=lambda source: review_hyperframes_source_against_brief(source, plan, logger),
        )
    raise SystemExit(f"不支持的素材生成引擎: {engine}")


# Reuse the Manim safety helpers from the existing agent contract.
from material_gen_manim_safety import inject_manim_helper_prelude, validate_manim_source  # noqa: E402


def main() -> None:
    load_dotenv()
    parser = argparse.ArgumentParser(description="Generate video material from a natural-language brief")
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--engine", default="auto", choices=["auto", *sorted(MATERIAL_ENGINES)])
    args = parser.parse_args()
    logger = default_logger()

    prompt = args.prompt.strip()
    if not prompt:
        raise SystemExit("请输入素材描述")

    runtime = runtime_root()
    data = data_root()
    run_id = now_id()
    run_dir = data / "video" / "materials" / "generated" / "records" / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    logger.stage(f"运行目录: {run_dir}")

    plan = plan_material(prompt, args.engine, logger)
    engine = str(plan["engine"])
    plan_path = run_dir / "plan.json"
    prompt_path = run_dir / "prompt.txt"
    prompt_path.write_text(prompt, encoding="utf-8")
    atomic_write_json(plan_path, plan)

    max_attempts = int(os.environ.get("VIDEOAUTO_ANIMATION_AGENT_MAX_ATTEMPTS", "3") or "3")
    logger.stage(f"启动 {engine} Coding Agent，最多尝试 {max_attempts} 次...")
    result = run_agent_for_engine(engine, plan, run_dir, runtime, plan_path, max_attempts, logger)
    plan["animation_agent"] = {
        "engine": result.engine,
        "status": "success" if result.ok else "failed",
        "state_path": str(result.state_path or ""),
        "attempts": len(result.attempts),
        "error": result.error,
    }
    atomic_write_json(plan_path, plan)

    if not result.ok or not result.source_path or not result.rendered_path:
        raise SystemExit(f"{engine} 动画 Coding Agent 失败: {result.error}")

    logger.stage("预渲染成功，正在复制到素材库...")
    material_path = copy_to_materials(data, result.rendered_path, f"{run_id}_{plan.get('title') or '生成素材'}")
    record = build_record(
        run_id=run_id,
        prompt=prompt,
        plan=plan,
        run_dir=run_dir,
        source_path=result.source_path,
        rendered_path=result.rendered_path,
        output_path=material_path,
        agent_state_path=str(result.state_path or ""),
    )
    records = read_records(data)
    records.insert(0, record)
    write_records(data, records[:200])
    atomic_write_json(run_dir / "record.json", record)
    logger.stage(f"生成完成: {material_path}")
    print(json.dumps(record, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
