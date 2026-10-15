#!/usr/bin/env python3
"""render_segment 里包装分支与自校验的接线测试。
跑法：python -m unittest tests.test_render_segment_packaging

不渲染、不起 ffmpeg：`render_overlay` / `encode` / `verify_segment_output` 全部替换成假的，
只验分支走向——降级触发条件、不该触发时不触发、原始诊断不被顶掉、关闭态零副作用。
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

TOOLS = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS))
os.environ.setdefault("VIDEOAUTO_PYTHON_PROMPT_DIR", str(TOOLS / "prompts"))

import render_segment  # noqa: E402

SHOT = {"shot_id": "s1", "title": "上料工位", "card_content": "节拍 12 件/分"}
OUT = Path("/tmp/does-not-matter/0001_final.mp4")
DIRECTORY = Path("/tmp/does-not-matter/packaging/0001_final")


class Renderer:
    """假的 render_overlay：记录每次调用拿到的 plan，可以让第 N 次抛错。"""

    def __init__(self, results):
        self.results = list(results)
        self.plans = []

    def __call__(self, shot, width, height, duration, directory, picture_bounds=None, plan=None):
        self.plans.append(plan)
        result = self.results.pop(0)
        if isinstance(result, Exception):
            raise result
        return result

    @property
    def calls(self):
        return len(self.plans)


@contextlib.contextmanager
def agent_plan(plan):
    """把 packaging_agent.plan_for_shot 换成固定返回值，并确保开关是开的。"""
    import packaging_agent

    with patch.dict(os.environ, {"PACKAGING_AGENT_SELECT": "1"}, clear=False), \
            patch.object(packaging_agent, "plan_for_shot", return_value=plan), \
            patch.object(render_segment, "shot_count", return_value=7):
        yield


def prepare(renderer, *, agent_on=True, shots_json="shots.json", shot=SHOT):
    return render_segment.prepare_packaging(
        shot, width=1920, height=1080, duration=6, picture_bounds=(0, 0, 1920, 1080),
        directory=DIRECTORY, shots_json=shots_json, shot_index=3, agent_on=agent_on,
        overlay_renderer=renderer)


class PreparePackagingTests(unittest.TestCase):
    def test_overlay_failure_with_a_plan_falls_back_to_the_deterministic_template(self):
        renderer = Renderer([RuntimeError("模板上屏文字过多"), Path("overlay.webm")])
        with agent_plan({"template": "cta", "show": True}):
            with contextlib.redirect_stdout(io.StringIO()) as printed:
                overlay, plan = prepare(renderer)
        self.assertEqual(overlay, Path("overlay.webm"))
        self.assertIsNone(plan, "降级后 plan 必须清成 None，后面的自校验据此判断 agent 有没有参与")
        self.assertEqual(renderer.calls, 2)
        self.assertEqual(renderer.plans[0], {"template": "cta", "show": True})
        self.assertIsNone(renderer.plans[1])
        self.assertIn("回退确定性模板", printed.getvalue())

    def test_overlay_failure_without_a_plan_is_raised_as_before(self):
        renderer = Renderer([RuntimeError("模板包装缺少运行组件")])
        with agent_plan(None):
            with contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(RuntimeError):
                    prepare(renderer)
        self.assertEqual(renderer.calls, 1, "没有 agent 版式就没有可回退的东西，不许重试")

    def test_unknown_shot_total_is_reported_as_question_mark(self):
        import packaging_agent

        renderer = Renderer([None])
        with patch.dict(os.environ, {"PACKAGING_AGENT_SELECT": "1"}, clear=False), \
                patch.object(packaging_agent, "plan_for_shot", return_value=None), \
                patch.object(render_segment, "shot_count", return_value=0):
            with contextlib.redirect_stdout(io.StringIO()) as printed:
                prepare(renderer)
        output = printed.getvalue()
        self.assertIn("包装决策 3/?", output)
        self.assertNotIn("包装决策 3/3", output, "读不到总数时不许拿当前镜号冒充总数")
        self.assertNotIn('"total"', output, "总数未知时不发 total 字段，发 0 会被当成真实总数")

    def test_switch_off_leaves_no_trace(self):
        sys.modules.pop("packaging_agent", None)
        renderer = Renderer([Path("overlay.webm")])
        with patch.dict(os.environ, {}, clear=True):
            with contextlib.redirect_stdout(io.StringIO()) as printed:
                overlay, plan = prepare(renderer, agent_on=False)
        self.assertEqual(overlay, Path("overlay.webm"))
        self.assertIsNone(plan)
        self.assertNotIn("packaging_agent", sys.modules, "关闭态不许 import agent 模块")
        self.assertNotIn("VACUT_EVENT", printed.getvalue(), "关闭态不许打进度事件")
        self.assertEqual(renderer.plans, [None])


class ScriptOnlyWiringTests(unittest.TestCase):
    """「只按脚本上屏」下，没写 card_content 的镜连模型都不问。"""

    NO_CARD = {"shot_id": "s2", "title": "落盘后核对三项", "voice_text": "口播原文"}

    def test_shot_without_card_content_never_imports_or_calls_the_agent(self):
        sys.modules.pop("packaging_agent", None)
        renderer = Renderer([None])
        with patch.dict(os.environ, {"PACKAGING_AGENT_SELECT": "1",
                                     "VIDEOAUTO_PACKAGING_SCRIPT_ONLY": "1"}, clear=False), \
                patch.object(render_segment, "shot_count", return_value=7):
            with contextlib.redirect_stdout(io.StringIO()) as printed:
                overlay, plan = prepare(renderer, shot=self.NO_CARD)
        output = printed.getvalue()
        self.assertIsNone(overlay)
        self.assertIsNone(plan)
        self.assertNotIn("packaging_agent", sys.modules,
                         "跳过的镜不许把 agent 模块拉进来（省一次模型调用的全部意义）")
        self.assertIn("按脚本模式跳过包装", output)
        self.assertEqual(renderer.plans, [None], "渲染仍走一次确定性调用，由它返回 None")

    def test_skipped_shot_still_emits_both_progress_events(self):
        """跳过也要发进度事件，否则桌面端 current 会跳号、末镜被跳时像卡住。"""
        sys.modules.pop("packaging_agent", None)
        renderer = Renderer([None])
        with patch.dict(os.environ, {"PACKAGING_AGENT_SELECT": "1",
                                     "VIDEOAUTO_PACKAGING_SCRIPT_ONLY": "1"}, clear=False), \
                patch.object(render_segment, "shot_count", return_value=7):
            with contextlib.redirect_stdout(io.StringIO()) as printed:
                prepare(renderer, shot=self.NO_CARD)
        events = [json.loads(line[len("VACUT_EVENT:"):])
                  for line in printed.getvalue().splitlines() if line.startswith("VACUT_EVENT:")]
        self.assertEqual(len(events), 2)
        self.assertEqual([event["workflowProgress"]["current"] for event in events], [2, 3])
        self.assertEqual([event["workflowProgress"]["total"] for event in events], [7, 7])
        self.assertIn("按脚本跳过 3/7", events[0]["workflowProgress"]["label"])
        self.assertNotIn("packaging_agent", sys.modules, "发进度事件不许把 agent 模块拉进来")

    def test_shot_with_card_content_still_asks_the_agent(self):
        renderer = Renderer([Path("overlay.webm")])
        with patch.dict(os.environ, {"VIDEOAUTO_PACKAGING_SCRIPT_ONLY": "1"}, clear=False), \
                agent_plan({"template": "cta", "show": True}):
            with contextlib.redirect_stdout(io.StringIO()) as printed:
                overlay, plan = prepare(renderer)
        self.assertEqual(overlay, Path("overlay.webm"))
        self.assertEqual(plan, {"template": "cta", "show": True})
        self.assertIn("VACUT_EVENT", printed.getvalue())

    def test_switch_off_puts_the_agent_back_on_every_shot(self):
        renderer = Renderer([Path("overlay.webm")])
        with patch.dict(os.environ, {"VIDEOAUTO_PACKAGING_SCRIPT_ONLY": "0"}, clear=False), \
                agent_plan({"template": "title", "show": True}):
            with contextlib.redirect_stdout(io.StringIO()) as printed:
                overlay, plan = prepare(renderer, shot=self.NO_CARD)
        output = printed.getvalue()
        self.assertEqual(overlay, Path("overlay.webm"))
        self.assertEqual(plan, {"template": "title", "show": True})
        self.assertIn("VACUT_EVENT", output)
        self.assertNotIn("按脚本模式跳过包装", output)


class SettleSegmentTests(unittest.TestCase):
    def settle(self, *, results, plan, overlay, renderer=None, encode=None, agent_on=True):
        calls = {"encode": 0}

        def default_encode(active_overlay):
            calls["encode"] += 1
            calls["last"] = active_overlay

        with patch.object(render_segment, "verify_segment_output", side_effect=list(results)):
            render_segment.settle_segment(
                OUT, 1920, 1080, 6, agent_on=agent_on, plan=plan, overlay=overlay, shot=SHOT,
                directory=DIRECTORY, picture_bounds=None, encode=encode or default_encode,
                overlay_renderer=renderer or Renderer([Path("retry.webm")]))
        return calls

    def test_video_problem_with_an_agent_overlay_re_renders_and_re_encodes_once(self):
        renderer = Renderer([Path("retry.webm")])
        with contextlib.redirect_stdout(io.StringIO()) as printed:
            calls = self.settle(results=[("video", "成片尺寸校验失败"), None],
                                plan={"template": "title", "show": True},
                                overlay=Path("agent.webm"), renderer=renderer)
        self.assertEqual(calls["encode"], 1)
        self.assertEqual(calls["last"], Path("retry.webm"))
        self.assertEqual(renderer.plans, [None], "回退必须用确定性版式")
        self.assertIn("用确定性模板重渲本镜", printed.getvalue())

    def test_show_false_shot_never_gains_packaging_on_retry(self):
        renderer = Renderer([Path("should-not-be-used.webm")])
        with self.assertRaises(RuntimeError) as raised:
            self.settle(results=[("video", "成片尺寸校验失败")],
                        plan={"template": "title", "show": False}, overlay=None, renderer=renderer)
        self.assertIn("成片尺寸校验失败", str(raised.exception))
        self.assertEqual(renderer.calls, 0, "overlay 为 None 的镜子回退时不许凭空加包装")

    def test_audio_problem_is_hard_only_when_the_agent_took_part(self):
        with self.assertRaises(RuntimeError) as raised:
            self.settle(results=[("audio", "成片音轨校验失败")],
                        plan={"template": "title", "show": True}, overlay=Path("agent.webm"))
        self.assertIn("音轨", str(raised.exception))

        with patch.object(render_segment, "packaging_agent_record") as record:
            with contextlib.redirect_stdout(io.StringIO()) as printed:
                calls = self.settle(results=[("audio", "成片音轨校验失败")], plan=None, overlay=None)
        self.assertEqual(calls["encode"], 0)
        self.assertIn("记录不阻断", printed.getvalue())
        record.assert_called_once()
        self.assertEqual(record.call_args[0][0], "final_check_warning")

    def test_fallback_render_failure_keeps_the_original_diagnosis(self):
        renderer = Renderer([RuntimeError("组件缺失")])
        with contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(RuntimeError) as raised:
                self.settle(results=[("video", "成片尺寸校验失败，目标 1920x1080")],
                            plan={"template": "title", "show": True},
                            overlay=Path("agent.webm"), renderer=renderer)
        message = str(raised.exception)
        self.assertIn("成片尺寸校验失败", message)
        self.assertIn("组件缺失", message)

    def test_clean_result_does_nothing(self):
        calls = self.settle(results=[None], plan=None, overlay=None, agent_on=False)
        self.assertEqual(calls["encode"], 0)

    def test_second_verification_failure_still_raises(self):
        with contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(RuntimeError) as raised:
                self.settle(results=[("video", "第一次"), ("video", "第二次")],
                            plan={"template": "title", "show": True}, overlay=Path("agent.webm"))
        self.assertIn("第二次", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
