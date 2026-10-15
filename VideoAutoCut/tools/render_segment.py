#!/usr/bin/env python3
# -*- coding: utf-8 -*-
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from add_progress import write_progress_ass, progress_float
from common import env_bool, env_int, find_ffmpeg, load_dotenv, subtitle_events_by_sentence, subtitle_events_from_timed_text, temp_path
from tts_dashscope import synthesize
from output_format import SIZES, canvas_size, configure_canvas, canvas_filter, fitted_picture_bounds, scaled_pixels, layout_scale
from progress_labels import progress_labels_for_shots
from text_layout import bundled_font_directory
from subtitle_safe_area import resolve_placement
from template_packaging import (
    has_script_card_content, load_packaging_shot, packaging_enabled, render_overlay,
    script_only, shot_count,
)
from video_encoder import (
    EncoderSpec,
    append_pixel_format_filter,
    encoder_arguments,
    fallback_marker_path,
    resolve_encoder,
    run_with_hardware_fallback,
)




def ffprobe_duration(media: Path) -> float | None:
    ffmpeg = Path(find_ffmpeg())
    ffprobe = ffmpeg.with_name("ffprobe.exe") if ffmpeg.name.lower() == "ffmpeg.exe" else Path("ffprobe")
    if not ffprobe.exists() and ffprobe.name != "ffprobe":
        return None
    try:
        out = subprocess.check_output(
            [str(ffprobe), "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(media)],
            text=True,
            encoding="utf-8",
            errors="replace",
        ).strip()
        return max(0.1, float(out))
    except Exception:
        return None

PACKAGING_AGENT_ENV = "PACKAGING_AGENT_SELECT"


def packaging_agent_enabled() -> bool:
    """与 packaging_agent.enabled() 同一个键。

    这里**故意不 import packaging_agent**：开关关闭时（默认）本文件的运行路径与
    接入 agent 之前完全一致——不加载模块、不打进度事件、不做额外校验。
    """
    return env_bool(PACKAGING_AGENT_ENV, False)


def emit_packaging_progress(current: int, total: int, label: str) -> None:
    """compose 阶段的每镜进度。Rust 只发首尾两条（main.rs），中间这段由这里补。

    stage 必须是桌面端白名单里的名字（task-events.ts），status 只发 running：
    发 completed 会让桌面端以为整个 compose 结束了。

    分镜总数读不到时（total=0）**不发 `total` 字段**：桌面端的 `optionalNumber` 会把缺席
    当成"未知"，发 0 反而会被当成一个真实的总数去算进度。这种情况 label 里写「3/?」。
    """
    progress = {"stage": "compose", "status": "running", "phase": "packaging",
                "current": current, "label": label}
    if total:
        progress["total"] = total
    print(
        "VACUT_EVENT:"
        + json.dumps(
            {
                "kind": "workflow",
                "workflowStage": "compose",
                "workflowStatus": "running",
                "workflowProgress": progress,
            },
            ensure_ascii=False,
        ),
        flush=True,
    )


def filter_path(path: Path) -> str:
    s = str(path).replace("\\", "/").replace(":", "\\:").replace("[", "\\[").replace("]", "\\]").replace(",", "\\,")
    return "'" + s.replace("'", "\\'") + "'"


def ass_filter(path: Path) -> str:
    font_directory = bundled_font_directory()
    result = "ass=" + filter_path(path)
    if font_directory.is_dir():
        result += ":fontsdir=" + filter_path(font_directory)
    return result




def load_subtitle_cues(shots_json: str, shot_index: int) -> list[dict]:
    if not shots_json or shot_index <= 0:
        return []
    p = Path(shots_json)
    if not p.exists():
        return []
    try:
        plan = json.loads(p.read_text(encoding="utf-8"))
        shots = plan.get("shots") or []
        shot = shots[shot_index - 1]
        cues = shot.get("subtitle_cues") or []
        return cues if isinstance(cues, list) else []
    except Exception as exc:
        print(f"warning: failed to load subtitle cues: {exc}")
        return []


def load_render_caption(shots_json: str, shot_index: int, fallback: str) -> str:
    """Use a shot-authored subtitle for template and organized plans."""
    if not shots_json or shot_index <= 0:
        return fallback
    p = Path(shots_json)
    if not p.exists():
        return fallback
    try:
        plan = json.loads(p.read_text(encoding="utf-8"))
        if not isinstance(plan, dict):
            return fallback
        source = plan.get("script_source")
        if not isinstance(source, dict) or source.get("route") not in {"template", "organized"}:
            return fallback
        shots = plan.get("shots")
        if not isinstance(shots, list) or shot_index > len(shots):
            return fallback
        shot = shots[shot_index - 1]
        if not isinstance(shot, dict):
            return fallback
        hints = shot.get("render_hints")
        subtitle = shot.get("subtitle")
        if (isinstance(hints, dict) and hints.get("caption_source") == "subtitle"
                and isinstance(subtitle, str) and subtitle.strip()):
            return subtitle
    except (OSError, ValueError):
        pass
    return fallback


def load_progress_labels(shots_json: str, fallback: list[str]) -> list[str]:
    if not shots_json:
        return fallback
    try:
        plan = json.loads(Path(shots_json).read_text(encoding="utf-8"))
        shots = plan.get("shots") or []
        if shots and all(isinstance(shot, dict) for shot in shots):
            return progress_labels_for_shots(shots)
    except (OSError, ValueError, TypeError) as exc:
        print(f"warning: failed to load progress labels: {exc}")
    return fallback




def load_subtitle_cues_from_voice(voice_output: str) -> list[dict]:
    if not voice_output:
        return []
    p = Path(voice_output)
    candidates = [
        p.with_name(p.name.replace("_voice", "_cues")).with_suffix(".json"),
        p.with_suffix(".cues.json"),
    ]
    for c in candidates:
        if not c.exists():
            continue
        try:
            data = json.loads(c.read_text(encoding="utf-8"))
            return data if isinstance(data, list) else []
        except Exception as exc:
            print(f"warning: failed to load voice cues {c}: {exc}")
    return []

def load_card_ass(shots_json: str, shot_index: int) -> str:
    if not shots_json or shot_index <= 0:
        return ""
    p = Path(shots_json)
    if not p.exists():
        return ""
    try:
        plan = json.loads(p.read_text(encoding="utf-8"))
        shots = plan.get("shots") or []
        shot = shots[shot_index - 1]
        card_ass = str(shot.get("card_ass") or "").strip()
        if not card_ass:
            return ""
        ap = Path(card_ass)
        if not ap.exists():
            print(f"warning: card ass not found: {ap}")
            return ""
        text = ap.read_text(encoding="utf-8")
        # Only merge styles/events body from card ass.
        return text
    except Exception as exc:
        print(f"warning: failed to load card ass: {exc}")
        return ""


def merge_ass(base: str, extra: str) -> str:
    if not extra.strip():
        return base
    # Merge style lines and dialogue lines. ASS sections can be concatenated poorly,
    # so extract only Style:/Dialogue: lines from the extra script.
    styles = []
    events = []
    for line in extra.splitlines():
        if line.startswith("Style:") and line not in base and line not in styles:
            styles.append(line)
        elif line.startswith("Dialogue:"):
            events.append(line)
    if styles:
        base = base.replace("[Events]", "\n".join(styles) + "\n\n[Events]", 1)
    if events:
        base += "\n" + "\n".join(events) + "\n"
    return base


def subtitle_line_max_chars() -> int:
    width, _ = canvas_size()
    requested = env_int("SUBTITLE_LINE_MAX_CHARS", env_int("SUBTITLE_DISPLAY_MAX_CHARS", 22))
    return min(requested, max(8, int(width * 0.84 / subtitle_font_size())))


def ass_color_value(value: str, default: str) -> str:
    text = str(value or "").strip()
    if re.fullmatch(r"#?[0-9a-fA-F]{6}", text):
        hex_value = text.lstrip("#")
        rr, gg, bb = hex_value[0:2], hex_value[2:4], hex_value[4:6]
        return f"&H{bb}{gg}{rr}&".upper()
    if re.fullmatch(r"&H[0-9a-fA-F]{6,8}&?", text):
        return text.upper()
    return default


def subtitle_font_size() -> int:
    return max(1, scaled_pixels(env_int("SUBTITLE_FONT_SIZE", 68)))


def subtitle_layout_options() -> dict:
    width, _ = canvas_size()
    left = min(scaled_pixels(env_int("SUBTITLE_MARGIN_L", 120)), int(width * 0.08))
    right = min(scaled_pixels(env_int("SUBTITLE_MARGIN_R", 120)), int(width * 0.08))
    # Reserve outline and a small allowance for font shaping differences
    # between the system measurer and libass used for the final pixels.
    available = max(1, width - left - right - 2 * scaled_pixels(env_int("SUBTITLE_OUTLINE", 4)))
    return {"max_width": available * 0.94,
            "font": os.environ.get("SUBTITLE_FONT", "Microsoft YaHei").strip() or "Microsoft YaHei",
            "font_size": subtitle_font_size()}


def subtitle_y() -> int:
    _, height = canvas_size()
    return env_int("SUBTITLE_Y", 850) if canvas_size() == (1920, 1080) else int(height * 0.80)


def subtitle_line_gap() -> int:
    return max(1, scaled_pixels(env_int("SUBTITLE_LINE_GAP", max(72, int(env_int("SUBTITLE_FONT_SIZE", 68) * 1.18)))))


def subtitle_style_line() -> str:
    font = os.environ.get("SUBTITLE_FONT", "Microsoft YaHei").strip() or "Microsoft YaHei"
    size = subtitle_font_size()
    primary = ass_color_value(os.environ.get("SUBTITLE_PRIMARY_COLOUR", ""), "&H00FFFFFF")
    secondary = ass_color_value(os.environ.get("SUBTITLE_SECONDARY_COLOUR", ""), primary)
    outline_colour = ass_color_value(os.environ.get("SUBTITLE_OUTLINE_COLOUR", ""), "&H00121212")
    back_colour = ass_color_value(os.environ.get("SUBTITLE_BACK_COLOUR", ""), "&H96000000")
    bold = 1
    outline = scaled_pixels(env_int("SUBTITLE_OUTLINE", 4))
    shadow = scaled_pixels(env_int("SUBTITLE_SHADOW", 1))
    margin_l = scaled_pixels(env_int("SUBTITLE_MARGIN_L", 120))
    margin_r = scaled_pixels(env_int("SUBTITLE_MARGIN_R", 120))
    margin_l = min(margin_l, int(canvas_size()[0] * 0.08))
    margin_r = min(margin_r, int(canvas_size()[0] * 0.08))
    margin_v = scaled_pixels(env_int("SUBTITLE_MARGIN_V", 105))
    return (
        f"Style: Subtitle,{font},{size},{primary},{secondary},{outline_colour},{back_colour},"
        f"{bold},0,0,0,100,100,0,0,1,{outline},{shadow},2,{margin_l},{margin_r},{margin_v},1\n"
    )


def subtitle_events_from_cues(cues: list[dict], *, style: str = "Subtitle", layer: int = 5, y: int = 870, anchor: str = "center", layout_options=None) -> str:
    events = ""
    for cue in cues:
        try:
            start = float(cue.get("start", 0))
            end = float(cue.get("end", 0))
            text = str(cue.get("text") or "").strip()
        except Exception:
            continue
        if not text or end <= start:
            continue
        events += subtitle_events_from_timed_text(
            text,
            start,
            end,
            style=style,
            layer=layer,
            y=y,
            line_gap=subtitle_line_gap(),
            max_chars=subtitle_line_max_chars(),
            max_lines=2,
            anchor=anchor,
            **(layout_options or subtitle_layout_options()),
        )
    return events

def subtitle_picture_position(picture_bounds, enable_progress=True):
    _, height = canvas_size()
    if picture_bounds is None:
        picture_bounds = (0, 0, canvas_size()[0], height)
    _, picture_y, _, picture_h = picture_bounds
    bottom = picture_y + picture_h
    padding = scaled_pixels(5)
    required = subtitle_line_gap() + int(subtitle_font_size() * 1.4) + 2 * scaled_pixels(env_int('SUBTITLE_OUTLINE', 4))
    if height - bottom - padding >= required:
        return int(bottom + padding), 'top'
    bar_height = min(progress_float('PROGRESS_BAR_HEIGHT', 76) * layout_scale(), picture_h) if enable_progress else 0
    return int(bottom - bar_height - padding), 'bottom'


def write_combined_ass(subtitle: str, modules: list[str], current: int, duration: float, out: Path, enable_subtitle=True, enable_progress=True, subtitle_duration: float | None = None, subtitle_cues: list[dict] | None = None, card_ass: str = "", picture_bounds=None, subtitle_placement=None) -> None:
    tmp_progress = out.with_suffix(".progress.ass")
    if enable_progress:
        write_progress_ass(modules, current, duration, tmp_progress, picture_bounds=picture_bounds)
        progress = tmp_progress.read_text(encoding="utf-8")
    else:
        progress = """[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"""
    progress = merge_ass(progress, card_ass)
    width, height = canvas_size()
    progress = progress.replace('PlayResX: 1920', f'PlayResX: {width}').replace('PlayResY: 1080', f'PlayResY: {height}')
    if not enable_subtitle or not subtitle.strip():
        out.write_text(progress, encoding="utf-8")
        return

    # Insert subtitle style and events into progress ASS.
    style = subtitle_style_line()
    if "Style: Subtitle," not in progress:
        progress = progress.replace("[Events]", style + "\n[Events]")
    subtitle_position, subtitle_anchor = subtitle_picture_position(picture_bounds, enable_progress)
    layout_options = subtitle_layout_options()
    if subtitle_placement:
        subtitle_position, subtitle_anchor = subtitle_placement['y'], subtitle_placement['anchor']
        layout_options['max_width'] = min(layout_options['max_width'], subtitle_placement['max_width'] * 0.94)
    if subtitle_cues and subtitle_cues_match_text(subtitle_cues, subtitle):
        progress += subtitle_events_from_cues(subtitle_cues, style="Subtitle", layer=5, y=subtitle_position, anchor=subtitle_anchor, layout_options=layout_options)
    else:
        progress += subtitle_events_by_sentence(subtitle, subtitle_duration or duration, style="Subtitle", layer=5, y=subtitle_position, max_chars=subtitle_line_max_chars(), anchor=subtitle_anchor, line_gap=subtitle_line_gap(), **layout_options)
    out.write_text(progress, encoding="utf-8")


def subtitle_cues_match_text(cues: list[dict], subtitle: str) -> bool:
    def normalized(text: str) -> str:
        return ''.join(character for character in text if character.isalnum())

    cue_text = ''.join(str(cue.get('original_text') or cue.get('text') or '') for cue in cues if isinstance(cue, dict))
    # A user may edit display text without changing narration. Original voice
    # cues must not replace that edit; use the current text's display timeline.
    return bool(normalized(subtitle)) and normalized(cue_text) == normalized(subtitle)


def validate_prepared_voice(voice: Path, cues: list[dict], voice_text: str, *, subtitles: bool = True) -> None:
    if not voice.is_file() or voice.stat().st_size <= 1024:
        raise RuntimeError("已准备的口播音频缺失或无效，请从口播字幕步骤继续，以重新准备配套音频和字幕时间轴。")
    if subtitles and not subtitle_cues_match_text(cues, voice_text):
        raise RuntimeError("口播字幕时间轴缺失或与当前口播不一致，请从口播字幕步骤继续。")


def cleanup_temp_ass_files(ass: Path) -> None:
    # Keep generated ASS files for task history inspection.
    return


def run_ffmpeg_encode(command: list[str], timeout_seconds: float) -> None:
    """Run a segment encode with the finite timeout selected by the encoder helper."""

    print(">>>", " ".join(f'"{part}"' if " " in part else part for part in command))
    subprocess.run(command, check=True, timeout=timeout_seconds)


# 成片时长软告警阈值（秒）。-shortest + apad=pad_dur=2 的真实偏差还没实测过，
# 第一步只记录不失败，收够样本再决定要不要升成硬失败。
DURATION_WARN_DELTA = 0.2


def probe_stream(media: Path, selector: str, entries: str) -> dict:
    probe = Path(find_ffmpeg()).with_name('ffprobe.exe' if os.name == 'nt' else 'ffprobe')
    output = subprocess.check_output([str(probe), '-v', 'error', '-select_streams', selector,
        '-show_entries', entries, '-of', 'json', str(media)], text=True, timeout=30)
    streams = json.loads(output).get('streams') or []
    return streams[0] if streams else {}


def verify_segment_output(out: Path, width: int, height: int, duration: float, *, check_audio: bool) -> tuple[str, str] | None:
    """成片规格自校验。返回 (类别, 问题描述)，没问题返回 None。

    类别只有 `video`（尺寸/SAR）和 `audio`（音轨），因为两者的处置不同：画面类可以换一份
    overlay 重渲，音轨类换 overlay 也没用。画面这一段是本文件原有行为，措辞不变；
    `check_audio` 只在包装 agent 开启时为真，额外验音轨并记录时长偏差——引擎侧
    （final_video.rs）只验输入素材不验成片，agent 改了画面就得自己把成片验回来。
    """
    info = probe_stream(out, 'v:0', 'stream=width,height,sample_aspect_ratio')
    if (info.get('width'), info.get('height')) != (width, height) or info.get('sample_aspect_ratio') not in ('1:1', None):
        return 'video', f'成片尺寸校验失败，目标 {width}x{height}，实际 {info}'
    if not check_audio:
        return None
    audio = probe_stream(out, 'a:0', 'stream=codec_name,sample_rate,channels')
    expected = ('aac', '48000', 2)
    actual = (audio.get('codec_name'), str(audio.get('sample_rate') or ''), audio.get('channels'))
    if actual != expected:
        return 'audio', f'成片音轨校验失败，目标 aac/48000/2ch，实际 {audio}'
    measured = ffprobe_duration(out)
    delta = abs((measured or 0.0) - duration)
    warned = measured is None or delta > DURATION_WARN_DELTA
    if warned:
        # 第一步只记录不失败：-shortest + apad 的真实偏差还没收够样本。
        print(f'[packaging] 成片时长偏差 {delta:.3f}s（目标 {duration:.3f}s，实际 {measured}）', flush=True)
    packaging_agent_record('final_check', {
        'width': info.get('width'), 'height': info.get('height'),
        'sar': info.get('sample_aspect_ratio'),
        'audio': {'codec': audio.get('codec_name'), 'sample_rate': audio.get('sample_rate'),
                  'channels': audio.get('channels')},
        'duration': measured, 'duration_delta': round(delta, 3), 'duration_warned': bool(warned),
    })
    return None


def prepare_packaging(shot, *, width: int, height: int, duration: float, picture_bounds,
                     directory: Path, shots_json: str, shot_index: int, agent_on: bool,
                     overlay_renderer=None):
    """选版式 + 渲 overlay。返回 (overlay, plan)。

    降级第一层就在这里：agent 选的版式渲不出来（分页太密、超长词、组件缺失）时，
    用确定性版式重来一次，plan 一并清成 None——后面的自校验据此判断 agent 是否参与了本镜。

    「只按脚本上屏」（默认开）下，脚本没写 `card_content` 的镜直接跳过 agent：
    不 import packaging_agent、不调模型，`render` 那一步也会返回 None（无 overlay）。
    两行进度事件照发（label 写「按脚本跳过」），否则桌面端包装阶段的 current 会跳号。
    """
    render = overlay_renderer or render_overlay
    plan = None
    total = 0
    total_text = "?"
    # 「只按脚本上屏」下这一镜根本不会有卡片（脚本没写 card_content），所以连模型都不必问：
    # 不 import packaging_agent、不调模型、省一次 overlay 渲染。build_composition 里有同一条
    # 判断兜底，所以即使这里判漏了，成片也不会多出卡片。
    skipped_by_script_only = agent_on and script_only() and not has_script_card_content(shot)
    if agent_on:
        # 分镜总数走 template_packaging.shot_count，**不经 packaging_agent**——跳过的镜也要发
        # 进度事件（不发的话桌面端的 current 会跳号，末镜被跳过时会停在 N-1/N 像卡住），
        # 但不能为了发事件把 agent 模块 import 进来。
        total = shot_count(shots_json)
        # 读不到分镜总数就写 0 / "?"，不拿当前镜号冒充总数（会显示成 3/3 假完成）。
        total_text = str(total) if total else "?"
        label = "按脚本跳过" if skipped_by_script_only else "包装决策"
        emit_packaging_progress(max(0, shot_index - 1), total, f"{label} {shot_index}/{total_text}")
    if skipped_by_script_only:
        print(f"[packaging] 分镜 {shot_index} 本镜脚本未写上屏内容，按脚本模式跳过包装（不调用模型）", flush=True)
    if agent_on and not skipped_by_script_only:
        import packaging_agent

        plan = packaging_agent.plan_for_shot(
            shot, directory=directory, shot_index=shot_index, duration=duration,
            width=width, height=height, picture_bounds=picture_bounds)
    try:
        overlay = render(shot, width, height, duration, directory, picture_bounds, plan=plan)
    except Exception as error:
        if plan is None:
            raise
        print(f"[packaging] agent 版式渲染失败，回退确定性模板: {error}", flush=True)
        packaging_agent_record("overlay_fallback", {"reason": f"{type(error).__name__}: {error}"})
        plan = None
        overlay = render(shot, width, height, duration, directory, picture_bounds)
    if agent_on:
        emit_packaging_progress(shot_index, total, f"包装完成 {shot_index}/{total_text}")
    return overlay, plan


def settle_segment(out: Path, width: int, height: int, duration: float, *, agent_on: bool,
                   plan, overlay, shot, directory: Path, picture_bounds, encode,
                   overlay_renderer=None):
    """成片自校验 + 降级第二层。问题解决不了就抛，与接入 agent 之前一样。"""
    render = overlay_renderer or render_overlay
    result = verify_segment_output(out, width, height, duration, check_audio=agent_on)
    if result and result[0] == 'audio' and plan is None:
        # agent 开着但这一镜已经降级到确定性版式：音轨不对不是 agent 造成的，
        # 按软告警记一笔，不改变接入前「只硬失败画面尺寸」的行为。
        print(f"[packaging] {result[1]}（本镜未用 agent 版式，记录不阻断）", flush=True)
        packaging_agent_record("final_check_warning", {"reason": result[1]})
        result = None
    if result and result[0] == 'video' and overlay is not None and plan is not None:
        # 降级第二层：agent 版的画面规格不对，用确定性版式重渲本镜一次。
        # overlay 为 None（含 agent 判 show=false）时不触发——回退不许凭空加包装。
        print(f"[packaging] 成片自校验不通过（{result[1]}），用确定性模板重渲本镜", flush=True)
        packaging_agent_record("final_check_retry", {"reason": result[1]})
        try:
            retried = render(shot, width, height, duration, directory, picture_bounds)
        except Exception as error:
            # 别让回退的失败顶掉原始诊断，两个一起抛。
            raise RuntimeError(f"{result[1]}；回退确定性模板也失败：{type(error).__name__}: {error}") from error
        encode(retried)
        result = verify_segment_output(out, width, height, duration, check_audio=agent_on)
    if result:
        raise RuntimeError(result[1])


def packaging_agent_record(section: str, data) -> None:
    """把包装之后才知道的事实补进决策日志；agent 没开就什么也不做。"""
    if not packaging_agent_enabled():
        return
    try:
        import packaging_agent
    except ImportError:
        return
    packaging_agent.record(section, data)


def main():
    load_dotenv()
    ap = argparse.ArgumentParser(description="Render one video segment with voiceover, subtitles and segmented progress bar")
    ap.add_argument("--clip", required=True)
    ap.add_argument("--output", "-o", required=True)
    ap.add_argument("--duration", type=float, default=4)
    ap.add_argument("--subtitle", default="")
    ap.add_argument("--voice-text", default="")
    ap.add_argument("--voice-output", default="")
    ap.add_argument("--require-prepared-voice", action="store_true", help="Require the paired voice/cues prepared by the engine; never synthesize a replacement during composition")
    ap.add_argument("--voice", default="", help="voice template / voice id, overrides .env")
    ap.add_argument("--voice-template", default="", help="alias of --voice")
    ap.add_argument("--modules", default="")
    ap.add_argument("--current", type=int, default=1)
    ap.add_argument("--shots-json", default="", help="shots.json with subtitle_cues")
    ap.add_argument("--shot-index", type=int, default=0, help="1-based shot index for subtitle_cues")
    ap.add_argument("--no-cards", action="store_true")
    ap.add_argument("--template-packaging", action="store_true", default=packaging_enabled(), help="Overlay fixed HyperFrames templates; default disabled")
    ap.add_argument("--no-voiceover", action="store_true")
    ap.add_argument("--no-subtitles", action="store_true")
    ap.add_argument("--no-progress", action="store_true")
    ap.add_argument("--aspect-ratio", choices=list(SIZES))
    ap.add_argument("--output-resolution", choices=["720p", "1080p", "4k"])
    args = ap.parse_args()
    width, height = configure_canvas(args.shots_json, args.aspect_ratio, args.output_resolution)

    clip = Path(args.clip)
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    duration = max(1.0, args.duration)
    modules = [m.strip() for m in args.modules.split("|") if m.strip()] or [f"模块{i}" for i in range(1, args.current + 1)]
    modules = load_progress_labels(args.shots_json, modules)

    voice = None
    voice_text = (args.voice_text or "").strip()
    render_caption = load_render_caption(args.shots_json, args.shot_index, args.subtitle or voice_text)
    subtitle_cues = load_subtitle_cues(args.shots_json, args.shot_index) or load_subtitle_cues_from_voice(args.voice_output)
    if not args.no_voiceover and voice_text:
        voice = Path(args.voice_output) if args.voice_output else out.with_suffix(".mp3")
        if args.require_prepared_voice:
            validate_prepared_voice(voice, subtitle_cues, voice_text, subtitles=not args.no_subtitles)
        if voice.exists() and voice.stat().st_size > 1024:
            print(f"use existing voice: {voice}")
        else:
            synthesize(voice_text, voice, voice=args.voice_template or args.voice)

    ass = temp_path(out.stem, ".ass", subdir="ass")
    subtitle_duration = ffprobe_duration(voice) if voice else None
    card_ass = "" if args.no_cards else load_card_ass(args.shots_json, args.shot_index)
    picture_bounds = None
    if not args.no_progress or not args.no_subtitles or args.template_packaging:
        probe = Path(find_ffmpeg()).with_name('ffprobe.exe' if os.name == 'nt' else 'ffprobe')
        info = json.loads(subprocess.check_output([str(probe), '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height,sample_aspect_ratio:stream_side_data=rotation', '-of', 'json', str(clip)], timeout=30))['streams'][0]
        source_w, source_h = info['width'], info['height']
        sar_parts = str(info.get('sample_aspect_ratio', '1:1')).split(':')
        sar = float(sar_parts[0]) / float(sar_parts[1]) if len(sar_parts) == 2 and float(sar_parts[1]) else 1.0
        rotation = next((side.get('rotation', 0) for side in info.get('side_data_list', []) if 'rotation' in side), 0)
        if abs(rotation) % 180 == 90:
            source_w, source_h, sar = source_h, source_w, 1 / sar if sar else 1.0
        picture_bounds = fitted_picture_bounds(source_w, source_h, width, height, sar or 1.0)
    overlay = None
    packaging_plan = None
    packaging_shot = None
    packaging_directory = out.parent / "packaging" / out.stem
    agent_on = bool(args.template_packaging) and packaging_agent_enabled()
    if args.template_packaging:
        packaging_shot = load_packaging_shot(args.shots_json, args.shot_index)
        overlay, packaging_plan = prepare_packaging(
            packaging_shot, width=width, height=height, duration=duration,
            picture_bounds=picture_bounds, directory=packaging_directory,
            shots_json=args.shots_json, shot_index=args.shot_index, agent_on=agent_on)
    subtitle_placement = None
    if not args.no_subtitles and render_caption.strip():
        bounds = picture_bounds or (0, 0, width, height)
        outline = scaled_pixels(env_int('SUBTITLE_OUTLINE', 4))
        subtitle_placement = resolve_placement(
            clip, duration, bounds, subtitle_picture_position(bounds, not args.no_progress),
            subtitle_layout_options()['max_width'] + 2 * outline,
            subtitle_line_gap() + int(subtitle_font_size() * 1.4) + 2 * outline,
            min(progress_float('PROGRESS_BAR_HEIGHT', 76) * layout_scale(), bounds[3]) if not args.no_progress else 0,
            max(scaled_pixels(5), 2 * outline + scaled_pixels(env_int('SUBTITLE_SHADOW', 1))),
            out.parent / '.subtitle-safe-area-cache', out.with_suffix('.subtitle-placement.json'))
    write_combined_ass(render_caption, modules, args.current, duration, ass, not args.no_subtitles, not args.no_progress, subtitle_duration=subtitle_duration, subtitle_cues=subtitle_cues, card_ass=card_ass, picture_bounds=picture_bounds, subtitle_placement=subtitle_placement)

    ffmpeg = find_ffmpeg()
    encoder = resolve_encoder(ffmpeg)
    print(f"video encoder: {encoder.label}")

    # 降级要能用另一份 overlay 重跑同一条命令，所以 overlay 放进可变格子，
    # 而不是把整个 command_for 再包一层工厂函数。
    active = {"overlay": overlay}

    def command_for(selected: EncoderSpec) -> list[str]:
        active_overlay = active["overlay"]
        cmd = [ffmpeg, "-hide_banner", "-nostats", "-loglevel", "error", "-y", "-stream_loop", "-1", "-i", str(clip)]
        if voice:
            cmd += ["-i", str(voice)]
        else:
            cmd += ["-f", "lavfi", "-t", str(duration), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]
        vf = canvas_filter(width, height)
        if active_overlay:
            # Native VP9 decoding can discard alpha; explicitly use libvpx.
            cmd += ["-c:v", "libvpx-vp9", "-i", str(active_overlay)]
            vf = f"[0:v]{vf}[picture];[2:v]format=rgba[package];[picture][package]overlay=0:0:format=auto:eof_action=pass:shortest=0"
        if not args.no_subtitles or not args.no_progress or (not args.no_cards and card_ass.strip()):
            vf += "," + ass_filter(ass)
        vf = append_pixel_format_filter(vf, selected)
        cmd += [
            "-t", str(duration),
            "-filter_complex" if active_overlay else "-vf", vf + "[packaged]" if active_overlay else vf,
            "-map", "[packaged]" if active_overlay else "0:v:0",
            "-map", "1:a:0",
            *encoder_arguments(selected, 20),
            "-c:a", "aac",
            "-ar", "48000",
            "-ac", "2",
            "-b:a", "192k",
            "-shortest",
        ]
        if voice:
            cmd += ["-af", "apad=pad_dur=2,loudnorm=I=-16:TP=-1.5:LRA=11"]
        return [*cmd, str(out)]

    def encode(active_overlay) -> None:
        active["overlay"] = active_overlay
        try:
            run_with_hardware_fallback(
                encoder,
                output=out,
                duration_seconds=duration,
                command_for=command_for,
                runner=run_ffmpeg_encode,
                marker=fallback_marker_path(),
            )
        finally:
            cleanup_temp_ass_files(ass)

    encode(overlay)
    settle_segment(out, width, height, duration, agent_on=agent_on, plan=packaging_plan,
                   overlay=overlay, shot=packaging_shot, directory=packaging_directory,
                   picture_bounds=picture_bounds, encode=encode)
    print(f"segment saved: {out}")


if __name__ == "__main__":
    main()
