"""Deterministic, opt-in HyperFrames overlays. No model or material generation."""
from __future__ import annotations

import argparse
import html
import json
import math
import os
import re
import shutil
import subprocess
from pathlib import Path

from common import env_bool, find_ffmpeg
from shot_plan_schema import CARD_LAYOUTS
from text_layout import bundled_font_directory, text_width, wrap_text_pixels

TEMPLATE_VERSION = 1
FONT = "Noto Sans CJK SC"
SCRIPT_ONLY_ENV = "VIDEOAUTO_PACKAGING_SCRIPT_ONLY"


def packaging_enabled() -> bool:
    return os.environ.get("VIDEOAUTO_TEMPLATE_PACKAGING", "").strip().lower() in {"1", "true", "yes", "on"}


def script_only() -> bool:
    """「只按脚本上屏」——**默认开启**（没设这个键就是开）。

    开：只有脚本作者写了 `card_content` 的分镜才上卡片；没写的镜不上，
    不再拿 `title`（分镜标题）顶替。上屏内容属于包装内容，一律以脚本为准。
    关（`0/false/no/off`）：恢复旧行为——没写 `card_content` 的镜退回 `title` 恒上包装。

    口径只认 `card_content`。`card_hint` 是版式提示，不是上屏内容，写了它也不算写了上屏内容。
    """
    return env_bool(SCRIPT_ONLY_ENV, True)


def has_script_card_content(shot: dict) -> bool:
    """脚本是否给这一镜写了上屏内容。只认 `card_content`，去空白后非空才算。

    **这是全仓唯一的口径**：`render_segment` 判跳不跳 agent、`build_composition` 判上不上卡片、
    `packaging_agent` 判 `overridden="author_card_content"` 护栏，三处都调它，不许各写一份。
    """
    return bool(str(shot.get("card_content") or "").strip())


def shot_count(shots_json: str) -> int:
    """分镜总数；读不到就返回 0（调用方按未知处理）。只给进度事件用。

    放在这里而不是 `packaging_agent` 里，是为了让「按脚本跳过」的分镜也能发进度事件
    而不必 import packaging_agent（那会破坏「跳过的镜零模型开销」）。
    """
    if not shots_json:
        return 0
    try:
        shots = json.loads(Path(shots_json).read_text(encoding="utf-8-sig")).get("shots") or []
    except (OSError, ValueError, AttributeError):
        return 0
    return len(shots) if isinstance(shots, list) else 0


def script_layout(shot: dict) -> str | None:
    """脚本版式标签定下的 `card_layout`（见 `script_card_fields.layout_from_labels`）。

    只认白名单值、且这一镜确实有 `card_content`；否则 None = 按原规则走。
    **非 None 时这一镜的版式由脚本决定，packaging agent 不得覆盖**（2026-09-23 用户拍板）。
    """
    layout = str(shot.get("card_layout") or "").strip()
    if layout not in CARD_LAYOUTS or not has_script_card_content(shot):
        return None
    return layout


def rule_kind(shot: dict, content: str) -> str:
    """原有的确定性规则：hint 命中 CTA -> cta；命中参数/列表或内容有换行 -> parameters；否则 title。"""
    hint = str(shot.get("card_hint") or "").lower()
    kind = "title"
    if re.search(r"\bcta\b|call.to.action|行动|号召|关注|购买|订阅", hint):
        kind = "cta"
    elif re.search(r"param|spec|bullet|参数|规格|要点|列表", hint) or "\n" in content:
        kind = "parameters"
    return kind


def packaging_content(shot: dict, plan: dict | None = None) -> tuple[str, str]:
    """Hints select a fixed design; only existing display copy becomes visible.

    `plan` 是 packaging_agent 选出的版式（试验，默认关闭）。它只能改 kind，
    上屏文字永远是这里从 card_content / title 原样取的那份——plan 里没有文字字段。

    脚本写了版式标签（`card_layout`）的镜：版式由脚本决定，`plan` 的版式一律不看。
    `headline_sub` 且内容至少两行 -> `headline`（大字 + 小一号副行）；其余回到原规则。
    没有 `card_layout` 的镜与 2026-09-23 之前逐字节相同。
    """
    content = str(shot.get("card_content") or "").strip()
    title = str(shot.get("title") or "").strip()
    layout = script_layout(shot)
    if layout == "headline_sub" and len([line for line in content.split("\n") if line.strip()]) >= 2:
        return "headline", content
    if plan is not None and layout is None:
        return str(plan["template"]), content or title
    return rule_kind(shot, content), content or title


def load_packaging_shot(plan_path: str, index: int) -> dict:
    if not plan_path or index < 1:
        raise RuntimeError("启用模板包装需要分镜文件和有效分镜编号。")
    shots = json.loads(Path(plan_path).read_text(encoding="utf-8")).get("shots", [])
    if index > len(shots) or not isinstance(shots[index - 1], dict):
        raise RuntimeError("模板包装找不到当前分镜。")
    return shots[index - 1]


def build_composition(shot: dict, width: int, height: int, duration: float, picture_bounds=None, plan: dict | None = None) -> tuple[str, dict] | None:
    if plan is not None and plan.get("show") is False:
        # agent 判这一镜不上包装：走与「没有上屏文字」完全相同的那条路（不渲 overlay）。
        return None
    if script_only() and not has_script_card_content(shot):
        # 「只按脚本上屏」：脚本没写上屏内容的镜不上卡片，也不拿 title 顶替。
        # 与上面 show=false 走同一条「无 overlay」出口。
        return None
    kind, content = packaging_content(shot, plan)
    if not content:
        return None
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("包装时长必须为正数。")
    layout = script_layout(shot)
    if kind == "headline":
        composition = build_headline(shot, content, width, height, duration, picture_bounds)
        if composition is not None:
            return composition
        # 大字+小字一页放不下（字太多 / 画面太窄）：退回原规则的多行版式（会分页），不硬塞
        kind = rule_kind(shot, content)
    x, y, pw, ph = picture_bounds or (0, 0, width, height)
    scale = min(width, height) / 1080
    margin = max(12, round(40 * scale))
    card_width = min(pw - 2 * margin, round((1000 if kind == "parameters" else 1200) * scale))
    available_height = max(1, int(ph * .36) - 2 * margin)
    padding = max(8, round(26 * scale))
    text_space = max(1, card_width - 2 * padding - round(12 * scale))
    size = max(12, round((54 if kind == "title" else 42) * scale))
    minimum = max(12, round(28 * scale))
    if card_width <= 2 * padding or available_height < size * 1.4 + 2 * padding:
        raise RuntimeError("素材画面过窄，放不下完整模板包装；请关闭模板包装或调整素材。")
    # kinsoku=True：卡片走包装专用的换行禁则（数字+单位不拆、行首/行尾禁则、孤字回退）。
    # 这组禁则只供卡片；字幕另有中文词边界，进度条仍走默认逐汉字路径。
    while size > minimum and any(text_width(line, FONT, size, True) > text_space for line in wrap_text_pixels(content, text_space, FONT, size, True, kinsoku=True)):
        size -= 1
    lines = wrap_text_pixels(content, text_space, FONT, size, True, kinsoku=True)
    if any(text_width(line, FONT, size, True) > text_space for line in lines):
        raise RuntimeError("模板上屏文字包含无法完整显示的超长词，请缩短上屏文字。")
    per_page = max(1, int((available_height - 2 * padding) / (size * 1.4)))
    pages = [lines[i:i + per_page] for i in range(0, len(lines), per_page)]
    if duration / len(pages) < .8:
        raise RuntimeError("模板上屏文字过多，当前分镜时长不足以完整显示；请精简上屏文字或关闭模板包装。")
    color = {"title": "#5DE0CF", "parameters": "#B6CCFF", "cta": "#FFD978"}[kind]
    blocks, animation = [], []
    interval = duration / len(pages)
    # 分页时每页的淡出正好收在下一页 clip 的起点，HyperFrames 的 lint
    # （gsap_exit_missing_hard_kill）要求补一个零时长的硬收尾，否则非线性 seek 可能落在
    # 淡出之后、留下过期的可见状态——0.5.9 起分页的上屏文字一直渲不出来就是缺这一句，
    # 2026-09-18 在 Windows 的 0.7.3 与本机的 0.8.5 上都实证过（两版都要求、也都接受这个写法）。
    # 单页不触发这条规则（淡出收在整段末尾，不是 clip 边界），所以单页的 html 保持原样不动。
    paged = len(pages) > 1
    for index, page in enumerate(pages):
        start, end = index * interval, (index + 1) * interval
        body = "<br>".join(html.escape(line) for line in page)
        blocks.append(f'<div id="page-{index}" class="clip card {kind}" data-start="{start:.6f}" data-duration="{interval:.6f}" data-track-index="{index + 1}">{body}</div>')
        fade = min(.25, interval / 5)
        animation.extend([
            f'tl.fromTo("#page-{index}",{{opacity:0,y:14}},{{opacity:1,y:0,duration:{fade},ease:"power2.out"}},{start});',
            f'tl.to("#page-{index}",{{opacity:0,duration:{fade}}},{end - fade});',
        ])
        if paged:
            animation.append(f'tl.set("#page-{index}",{{opacity:0}},{end});')
    source = f'''<!doctype html><html><head><meta charset="utf-8">
<style>@font-face{{font-family:"{FONT}";src:url("NotoSansCJKsc-Bold.otf");font-weight:700}}
html,body{{margin:0;width:{width}px;height:{height}px;background:transparent;overflow:hidden}}
#main{{position:relative;width:{width}px;height:{height}px;background:transparent}}
.card{{box-sizing:border-box;position:absolute;left:{x + margin}px;top:{y + margin}px;width:{card_width}px;padding:{padding}px;
font-family:"{FONT}";font-weight:700;font-size:{size}px;line-height:1.4;color:#fff;background:rgba(12,20,34,.88);
border-left:{max(3, round(6 * scale))}px solid {color};border-radius:{round(12 * scale)}px;opacity:0}}
.cta{{border-left:0;border-top:{max(3, round(6 * scale))}px solid {color};color:{color}}}.parameters{{background:rgba(15,27,49,.9)}}
</style><script src="gsap.min.js"></script></head><body>
<div id="main" data-composition-id="main" data-start="0" data-width="{width}" data-height="{height}" data-duration="{duration}">{''.join(blocks)}</div>
<script>const tl=gsap.timeline({{paused:true}});{''.join(animation)}window.__timelines=window.__timelines||{{}};window.__timelines.main=tl;</script>
</body></html>'''
    manifest = {"template_version": TEMPLATE_VERSION, "template": kind, "content": content,
                "width": width, "height": height, "duration": duration, "pages": pages,
                "font_size": size, "picture_bounds": [x, y, pw, ph],
                "template_source": "agent" if plan is not None else "deterministic"}
    if layout is not None:
        manifest["template_source"] = "script_label"
        manifest["card_layout"] = layout
    return source, manifest


# 大字 + 小字（2026-09-23，脚本写了「大字：」+「副行：/小字：」的镜）。
# 与 title 卡同一套外观：深底卡、左侧青色条、同一字体；第一行 54 号（与 title 相同），
# 后面各行小一号（36 号，约 2/3）、颜色弱化成 78% 白，与大字之间留约 1/3 行的间距。
HEADLINE_SIZE = 54
HEADLINE_SUB_SIZE = 36
HEADLINE_LINE_HEIGHT = 1.3
HEADLINE_SUB_LINE_HEIGHT = 1.4
HEADLINE_GAP = .35
HEADLINE_SUB_COLOR = "rgba(255,255,255,.78)"


def _fit_lines(text: str, space: int, size: int, minimum: int) -> tuple[list[str], int] | None:
    while size > minimum and any(text_width(line, FONT, size, True) > space
                                 for line in wrap_text_pixels(text, space, FONT, size, True, kinsoku=True)):
        size -= 1
    lines = wrap_text_pixels(text, space, FONT, size, True, kinsoku=True)
    if any(text_width(line, FONT, size, True) > space for line in lines):
        return None
    return lines, size


def build_headline(shot: dict, content: str, width: int, height: int, duration: float,
                   picture_bounds=None) -> tuple[str, dict] | None:
    """大字+小字卡。一页放不下或有放不下的超长词时返回 None，调用方退回原规则。"""
    rows = [line.strip() for line in content.split("\n") if line.strip()]
    if len(rows) < 2:
        return None
    x, y, pw, ph = picture_bounds or (0, 0, width, height)
    scale = min(width, height) / 1080
    margin = max(12, round(40 * scale))
    card_width = min(pw - 2 * margin, round(1200 * scale))
    available_height = max(1, int(ph * .36) - 2 * margin)
    padding = max(8, round(26 * scale))
    text_space = max(1, card_width - 2 * padding - round(12 * scale))
    if card_width <= 2 * padding:
        return None
    head = _fit_lines(rows[0], text_space, max(12, round(HEADLINE_SIZE * scale)), max(12, round(28 * scale)))
    sub = _fit_lines("\n".join(rows[1:]), text_space, max(12, round(HEADLINE_SUB_SIZE * scale)),
                     max(12, round(22 * scale)))
    if head is None or sub is None:
        return None
    (head_lines, size), (sub_lines, sub_size) = head, sub
    gap = round(sub_size * HEADLINE_GAP)
    needed = (len(head_lines) * size * HEADLINE_LINE_HEIGHT + gap
              + len(sub_lines) * sub_size * HEADLINE_SUB_LINE_HEIGHT)
    if needed > available_height - 2 * padding or duration < .8:
        return None
    color = "#5DE0CF"
    fade = min(.25, duration / 5)
    head_html = "<br>".join(html.escape(line) for line in head_lines)
    sub_html = "<br>".join(html.escape(line) for line in sub_lines)
    block = (f'<div id="page-0" class="clip card headline" data-start="0.000000" '
             f'data-duration="{duration:.6f}" data-track-index="1">'
             f'<div class="hl">{head_html}</div><div class="sub">{sub_html}</div></div>')
    animation = (f'tl.fromTo("#page-0",{{opacity:0,y:14}},{{opacity:1,y:0,duration:{fade},ease:"power2.out"}},0);'
                 f'tl.to("#page-0",{{opacity:0,duration:{fade}}},{duration - fade});')
    source = f'''<!doctype html><html><head><meta charset="utf-8">
<style>@font-face{{font-family:"{FONT}";src:url("NotoSansCJKsc-Bold.otf");font-weight:700}}
html,body{{margin:0;width:{width}px;height:{height}px;background:transparent;overflow:hidden}}
#main{{position:relative;width:{width}px;height:{height}px;background:transparent}}
.card{{box-sizing:border-box;position:absolute;left:{x + margin}px;top:{y + margin}px;width:{card_width}px;padding:{padding}px;
font-family:"{FONT}";font-weight:700;font-size:{size}px;line-height:1.4;color:#fff;background:rgba(12,20,34,.88);
border-left:{max(3, round(6 * scale))}px solid {color};border-radius:{round(12 * scale)}px;opacity:0}}
.headline .hl{{line-height:{HEADLINE_LINE_HEIGHT}}}
.headline .sub{{font-size:{sub_size}px;line-height:{HEADLINE_SUB_LINE_HEIGHT};margin-top:{gap}px;color:{HEADLINE_SUB_COLOR}}}
</style><script src="gsap.min.js"></script></head><body>
<div id="main" data-composition-id="main" data-start="0" data-width="{width}" data-height="{height}" data-duration="{duration}">{block}</div>
<script>const tl=gsap.timeline({{paused:true}});{animation}window.__timelines=window.__timelines||{{}};window.__timelines.main=tl;</script>
</body></html>'''
    manifest = {"template_version": TEMPLATE_VERSION, "template": "headline", "content": content,
                "width": width, "height": height, "duration": duration,
                "pages": [head_lines + sub_lines], "headline_lines": head_lines, "sub_lines": sub_lines,
                "font_size": size, "sub_font_size": sub_size, "picture_bounds": [x, y, pw, ph],
                "template_source": "script_label", "card_layout": "headline_sub"}
    return source, manifest


def first_file(paths) -> Path | None:
    return next((path for path in paths if path.is_file()), None)


def renderer_dependencies(root: Path) -> tuple[Path, Path, Path, Path]:
    hf = root / "tools" / "material_gen" / "hyperframes"
    def configured(name):
        value = os.environ.get(name, "").strip()
        return [Path(value)] if value else []
    node = first_file(configured("VIDEOAUTO_NODE_EXE") + [root / "node-runtime" / "node.exe", root / "node" / "node.exe"])
    cli = first_file(configured("HYPERFRAMES_CLI") + [hf / "node_modules/hyperframes/dist/cli.js", hf / "dist/cli.js"])
    gsap = first_file(configured("HYPERFRAMES_GSAP") + [hf / "node_modules/gsap/dist/gsap.min.js"])
    browser = first_file(configured("HYPERFRAMES_BROWSER_PATH") + [
        hf / "chrome-headless-shell/chrome-headless-shell.exe",
        root / "tools/material_gen/remotion/node_modules/.remotion/chrome-headless-shell/win64/chrome-headless-shell-win64/chrome-headless-shell.exe",
    ])
    missing = [name for name, value in [("内置 Node", node), ("HyperFrames 0.7.3", cli), ("GSAP 3.14.2", gsap), ("Chrome Headless Shell", browser)] if value is None]
    if missing:
        raise RuntimeError("模板包装缺少运行组件：" + "、".join(missing) + "。请修复运行环境，或在画面样式中关闭模板包装后重试。")
    return node, cli, gsap, browser


def render_overlay(shot: dict, width: int, height: int, duration: float, directory: Path, picture_bounds=None, plan: dict | None = None) -> Path | None:
    composition = build_composition(shot, width, height, duration, picture_bounds, plan)
    if composition is None:
        return None
    root = Path(__file__).resolve().parents[1]
    node, cli, gsap, browser = renderer_dependencies(root)
    font = bundled_font_directory() / "NotoSansCJKsc-Bold.otf"
    if not font.is_file():
        raise RuntimeError("模板包装缺少内置 Noto 字体，请修复运行环境。")
    directory = directory.resolve()
    directory.mkdir(parents=True, exist_ok=True)
    source, manifest = composition
    (directory / "index.html").write_text(source, encoding="utf-8")
    (directory / "template.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    shutil.copy2(gsap, directory / "gsap.min.js")
    shutil.copy2(font, directory / font.name)
    output = directory / "overlay.webm"
    output.unlink(missing_ok=True)
    ffmpeg = Path(find_ffmpeg())
    ffprobe = ffmpeg.with_name("ffprobe.exe" if os.name == "nt" else "ffprobe")
    env = {**os.environ, "HYPERFRAMES_NO_TELEMETRY": "1", "HYPERFRAMES_NO_UPDATE_CHECK": "1",
           "HYPERFRAMES_BROWSER_PATH": str(browser), "HYPERFRAMES_FFMPEG_PATH": str(ffmpeg), "HYPERFRAMES_FFPROBE_PATH": str(ffprobe)}
    commands = [
        [str(node), str(cli), "lint", str(directory)],
        [str(node), str(cli), "render", str(directory), "-c", "index.html", "-o", str(output), "--format", "webm", "--fps", "30", "--quality", "standard", "--workers", "1", "--low-memory-mode", "--no-browser-gpu"],
    ]
    with (directory / "render.log").open("w", encoding="utf-8") as log:
        for command in commands:
            try:
                subprocess.run(command, cwd=directory, env=env, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=max(180, duration * 60))
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
                raise RuntimeError(f"模板包装渲染失败，详情见 {directory / 'render.log'}") from exc
    info = json.loads(subprocess.check_output([str(ffprobe), "-v", "error", "-select_streams", "v:0", "-show_streams", "-show_format", "-of", "json", str(output)], timeout=30))
    stream = info["streams"][0]
    tags = {key.lower(): str(value) for key, value in stream.get("tags", {}).items()}
    if (stream["width"], stream["height"]) != (width, height) or abs(float(info["format"]["duration"]) - duration) > .1 or tags.get("alpha_mode") != "1":
        raise RuntimeError("模板包装输出尺寸、时长或透明通道校验失败。")
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Render fixed HyperFrames packaging from existing shot display fields")
    parser.add_argument("--shots-json", required=True)
    parser.add_argument("--shot-index", type=int, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--width", type=int, default=1920)
    parser.add_argument("--height", type=int, default=1080)
    parser.add_argument("--duration", type=float, required=True)
    args = parser.parse_args()
    print(render_overlay(load_packaging_shot(args.shots_json, args.shot_index), args.width, args.height, args.duration, args.output_dir))
