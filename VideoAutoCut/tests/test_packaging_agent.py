#!/usr/bin/env python3
"""模板包装 agent（第一步）的管线测试。跑法：python -m unittest tests.test_packaging_agent

模型全部用假 `ask` 替换，不联网、不起 node、不渲染。
"""
from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
import re
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

TOOLS = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS))
os.environ.setdefault("VIDEOAUTO_PYTHON_PROMPT_DIR", str(TOOLS / "prompts"))

import packaging_agent as pa  # noqa: E402
import render_segment  # noqa: E402
import template_packaging as tp  # noqa: E402
import text_layout  # noqa: E402
from template_packaging import (  # noqa: E402
    build_composition, bundled_font_directory, packaging_content, renderer_dependencies,
)


def plain_wrap(text, width, font, size, bold=True, **kwargs):
    """忽略 kinsoku 的换行，= 2026-09-21 加包装换行禁则之前那一版。

    断言 kwargs 正好是 `{"kinsoku": True}`：将来有人把调用点的参数名写错、或者干脆漏了，
    这个 seam 必须当场红，而不是悄悄把对照测试变成永远通过。
    """
    assert kwargs == {"kinsoku": True}, f"包装路径必须以 kinsoku=True 调用，实际 {kwargs!r}"
    return text_layout.wrap_text_pixels(text, width, font, size, bold)

# 分页样本：2026-09-18 Windows #0 验收挂掉的那一镜（竖屏素材，卡片只有 606px 宽）。
PAGED_SHOT = {"title": "包装换型", "card_content": "新包装样件｜目标垛型｜现场布局｜抓具调整｜路径确认",
              "card_hint": "numbered checklist card"}
PAGED_BOUNDS = (656, 0, 606, 1080)
# 生成的硬收尾行，比对 ba6553e 时按这个模式剥掉。
HARD_KILL = re.compile(r'tl\.set\("#page-\d+",\{opacity:0\},[\d.]+\);')

REPO_ROOT = Path(__file__).resolve().parents[2]
BASELINE_REVISION = "ba6553e"


def load_legacy_template_packaging():
    """把接入 agent 之前那版 template_packaging.py 以另一个模块名载进来；拿不到返回 None。"""
    import importlib.util
    import subprocess

    try:
        source = subprocess.run(
            ["git", "-C", str(REPO_ROOT), "show",
             f"{BASELINE_REVISION}:VideoAutoCut/tools/template_packaging.py"],
            capture_output=True, text=True, encoding="utf-8", check=False,
        )
    except OSError:
        return None
    if source.returncode != 0 or not source.stdout.strip():
        return None
    with tempfile.TemporaryDirectory() as root:
        path = Path(root) / "template_packaging_baseline.py"
        path.write_text(source.stdout, encoding="utf-8")
        spec = importlib.util.spec_from_file_location("template_packaging_baseline", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

SHOT_WITH_CARD = {
    "shot_id": "shot_a", "title": "标题占位", "card_content": "节拍 12 件/分\n重复定位 0.02 mm",
    "card_hint": "参数", "voice_text": "这一镜讲节拍和精度。",
}
SHOT_WITHOUT_CARD = {"shot_id": "shot_b", "title": "分镜3", "voice_text": "只有口播。"}

SINGLE_PAGE_SAMPLES = [
    SHOT_WITH_CARD, SHOT_WITHOUT_CARD,
    {"title": "立即咨询", "card_content": "欢迎咨询", "card_hint": "CTA"},
    {"title": "单行标题", "card_content": "一句话主张"},
]


def reply(**fields):
    def ask(system, user_text, images, *, timeout):  # noqa: ARG001
        return dict(fields)
    return ask


def raising(error: Exception):
    def ask(system, user_text, images, *, timeout):  # noqa: ARG001
        raise error
    return ask


@contextlib.contextmanager
def workspace():
    with tempfile.TemporaryDirectory() as root:
        yield Path(root) / "packaging" / "0001_final"


class SettingsTests(unittest.TestCase):
    def test_switch_is_off_unless_explicitly_enabled(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertFalse(pa.enabled())
            self.assertFalse(render_segment.packaging_agent_enabled())
        with patch.dict(os.environ, {"PACKAGING_AGENT_SELECT": "1"}):
            self.assertTrue(pa.enabled())
            self.assertTrue(render_segment.packaging_agent_enabled())

    def test_backend_defaults_to_dashscope_unless_pi_is_explicit(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(pa.backend_name(), "dashscope")
        for value, expected in [("pi", "pi"), ("PI", "pi"), ("  pi  ", "pi"),
                                ("dashscope", "dashscope"), ("", "dashscope"),
                                ("whatever", "dashscope")]:
            with self.subTest(value=value), patch.dict(os.environ, {"PACKAGING_AGENT_BACKEND": value}):
                self.assertEqual(pa.backend_name(), expected)

    def test_timeout_is_clamped(self):
        for value, expected in [("5", 30), ("90", 90), ("99999", 600), ("bad", 90)]:
            with patch.dict(os.environ, {"PACKAGING_AGENT_TIMEOUT": value}):
                self.assertEqual(pa.timeout_seconds(), expected)

    def test_model_override_covers_both_backends_and_restores(self):
        with patch.dict(os.environ, {"PACKAGING_AGENT_MODEL": "qwen3.6-plus",
                                     "MATERIAL_AGENT_PI_MODEL": "old"}, clear=True):
            with pa.selected_model():
                self.assertEqual(os.environ["MATERIAL_AGENT_PI_MODEL"], "qwen3.6-plus")
                self.assertEqual(os.environ["MATERIAL_AGENT_PI_TEXT_MODEL"], "qwen3.6-plus")
                self.assertEqual(os.environ["DASHSCOPE_TEXT_MODEL"], "qwen3.6-plus")
                self.assertEqual(os.environ["DASHSCOPE_VISUAL_REVIEW_MODEL"], "qwen3.6-plus")
            self.assertEqual(os.environ["MATERIAL_AGENT_PI_MODEL"], "old")
            self.assertNotIn("DASHSCOPE_TEXT_MODEL", os.environ)


class PromptTests(unittest.TestCase):
    """提示词冻结闸门（2026-09-21）。

    9/21 上午往 `show` 那段里加过「默认配置下 show 实际恒为 true，照填 true 即可」，
    Windows 回帖 51296044 的 A4 证明那句把模型带偏了：`VIDEOAUTO_PACKAGING_SCRIPT_ONLY=0`
    老路径下 title 是内部标签／与口播逐字重复的镜不再判 `show=false`。
    `docs/packaging-agent-step1-2026-09-18.md` §8.9.3 已写死这份提示词「一字不改」，
    所以这里直接用 golden sha256 钉全文——改一个字就红，让人去看那条文档再决定。

    **读的是仓库里那份**，不走 `load_prompt_template`：后者会认
    `VIDEOAUTO_PYTHON_PROMPT_DIR`，而测试进程里那个键可能被外部环境指到运行包
    （pkg3 带的正是坏掉的那一版），闸门会被悄悄劫持成校验别人。
    """

    PATH = TOOLS / "prompts" / "agent_packaging_plan.md"
    # = `git show 57ecd75:VideoAutoCut/tools/prompts/agent_packaging_plan.md`
    GOLDEN_SHA256 = "0cb811b544a5f99ecd68385f72b18d18f52710a50fab09c044f28d499563f788"

    def setUp(self):
        self.prompt = self.PATH.read_text(encoding="utf-8")

    def test_prompt_is_byte_for_byte_the_frozen_version(self):
        digest = hashlib.sha256(self.PATH.read_bytes()).hexdigest()
        self.assertEqual(digest, self.GOLDEN_SHA256,
                         "包装提示词是冻结的（docs §8.9.3）。真要改就连同这条 golden "
                         "一起改，并在 docs 里写清为什么——9/21 上午那次『改准』直接"
                         "把 A4 的 show 判定改没了。")

    def test_the_two_rules_that_must_never_be_softened_are_present(self):
        # ① 模型不产出上屏文字（产品铁律）；② 判 false 的规则无前置条件。
        self.assertIn("你写什么文字都不会被采纳", self.prompt)
        self.assertIn("有内容时一律 true", self.prompt)
        rule = [line for line in self.prompt.splitlines()
                if line.lstrip().startswith("- `card_content` 为空时")]
        self.assertEqual(len(rule), 1)
        self.assertIn("填 false", rule[0])
        for phrase in ("照填", "实际恒为", "只有把", "只有在", "只有当"):
            self.assertNotIn(phrase, self.prompt)


class ValidationTests(unittest.TestCase):
    def test_accepts_the_three_templates_only(self):
        for template in ("title", "parameters", "cta"):
            plan, problem = pa.validate_response({"show": True, "template": template},
                                                 author_card_content=False)
            self.assertEqual(problem, "")
            self.assertEqual(plan["template"], template)

    def test_rejects_bad_returns_without_guessing(self):
        cases = [
            ([{"template": "title"}], "返回不是 JSON 对象"),      # 顶层数组
            ({}, "template 不在"),                                # 空对象
            ({"show": True, "template": "banner"}, "template 不在"),
            ({"show": "true", "template": "title"}, "show 不是布尔值"),
            ({"show": 1, "template": "title"}, "show 不是布尔值"),
            ({"template": "title"}, "show 不是布尔值"),
        ]
        for response, marker in cases:
            with self.subTest(response=response):
                plan, problem = pa.validate_response(response, author_card_content=False)
                self.assertIsNone(plan)
                self.assertIn(marker, problem)

    def test_reason_is_truncated_and_never_reaches_the_screen(self):
        plan, _ = pa.validate_response({"show": True, "template": "title", "reason": "长" * 400},
                                       author_card_content=False)
        self.assertEqual(len(plan["reason"]), pa.REASON_LIMIT)
        # schema 里没有任何文字字段，这是"模型改不了上屏文字"的结构保证，逐键锁死。
        self.assertEqual(set(plan), {"template", "show", "reason", "overridden"})

    def test_author_card_content_forces_show(self):
        plan, _ = pa.validate_response({"show": False, "template": "cta"}, author_card_content=True)
        self.assertTrue(plan["show"])
        self.assertEqual(plan["overridden"], "author_card_content")
        plan, _ = pa.validate_response({"show": False, "template": "cta"}, author_card_content=False)
        self.assertFalse(plan["show"])
        self.assertIsNone(plan["overridden"])


class PlanTests(unittest.TestCase):
    def run_plan(self, shot, ask, directory, **env):
        settings = {"PACKAGING_AGENT_SELECT": "1", "PACKAGING_AGENT_BACKEND": "dashscope", **env}
        with patch.dict(os.environ, settings, clear=False):
            with contextlib.redirect_stdout(io.StringIO()) as printed:
                plan = pa.plan_for_shot(shot, directory=directory, shot_index=1, duration=6,
                                        width=1920, height=1080, ask=ask)
        return plan, printed.getvalue()

    def read_log(self, directory: Path) -> dict:
        return json.loads((directory / pa.LOG_FILE_NAME).read_text(encoding="utf-8"))

    def test_agent_choice_replaces_the_regex_and_is_logged(self):
        with workspace() as directory:
            plan, _ = self.run_plan(SHOT_WITH_CARD, reply(show=True, template="cta", reason="号召语"),
                                    directory)
            self.assertEqual(plan["template"], "cta")
            self.assertEqual(plan["source"], "agent")
            log = self.read_log(directory)
            self.assertTrue(log["ok"])
            self.assertFalse(log["fallback_used"])
            # 正则会判成 parameters（card_content 有换行），agent 判成 cta。
            self.assertEqual(log["deterministic"]["template"], "parameters")
            self.assertFalse(log["agreed_with_deterministic"])

    def test_bad_return_degrades_to_none_and_records_why(self):
        for response in ({"show": True, "template": "banner"}, {"show": "true", "template": "title"}, {}):
            with self.subTest(response=response), workspace() as directory:
                plan, output = self.run_plan(SHOT_WITH_CARD, reply(**response), directory)
                self.assertIsNone(plan)
                log = self.read_log(directory)
                self.assertTrue(log["fallback_used"])
                self.assertTrue(log["errors"])
                self.assertIn("[packaging]", output)

    def test_exceptions_and_timeouts_never_escape(self):
        import subprocess
        for error in (RuntimeError("pi 退出码 1"),
                      subprocess.TimeoutExpired(cmd="pi", timeout=1),
                      ValueError("模型没有返回 JSON 对象")):
            with self.subTest(error=type(error).__name__), workspace() as directory:
                plan, _ = self.run_plan(SHOT_WITH_CARD, raising(error), directory)
                self.assertIsNone(plan)
                self.assertTrue(self.read_log(directory)["fallback_used"])

    def test_timeout_is_a_per_shot_budget_split_across_internal_attempts(self):
        seen = {}
        before = os.environ.get("VIDEOAUTO_HTTP_RETRIES")

        def ask(system, user_text, images, *, timeout):  # noqa: ARG001
            seen["timeout"] = timeout
            seen["images"] = images
            seen["http_retries"] = os.environ.get("VIDEOAUTO_HTTP_RETRIES")
            return {"show": True, "template": "title"}

        # 整份剩余预算都给这一次调用（不再按内部重试次数摊）。
        for backend, budget in (("dashscope", 90), ("pi", 60)):
            with self.subTest(backend=backend), workspace() as directory:
                self.run_plan(SHOT_WITH_CARD, ask, directory,
                              PACKAGING_AGENT_TIMEOUT=str(budget), PACKAGING_AGENT_BACKEND=backend)
            self.assertLessEqual(seen["timeout"], budget)
            self.assertGreater(seen["timeout"], budget - 5, "预算应当几乎全给这一次调用")
        self.assertEqual(seen["images"], [])
        # dashscope 链路的 HTTP 重试被压到 1 次，且调用结束后还原。
        self.assertEqual(seen["http_retries"], "1")
        self.assertEqual(os.environ.get("VIDEOAUTO_HTTP_RETRIES"), before)

    def test_budget_never_drops_below_the_floor(self):
        self.assertEqual(pa.per_call_timeout(3), pa.MIN_CALL_TIMEOUT)
        self.assertEqual(pa.per_call_timeout(200), 200)

    def test_three_comparison_fields_separate_template_from_show(self):
        cases = [
            # (模型返回, 期望 版式一致, show 一致, 改变了这一镜)
            ({"show": True, "template": "title"}, True, True, False),
            ({"show": True, "template": "cta"}, False, True, True),
            ({"show": False, "template": "title"}, True, False, True),
        ]
        for response, template_same, show_same, changed in cases:
            with self.subTest(response=response), workspace() as directory:
                # 用没有 card_content 的分镜，show=false 才不会被强制改回 true。
                self.run_plan(SHOT_WITHOUT_CARD, reply(**response), directory)
                log = self.read_log(directory)
                self.assertEqual(log["deterministic"]["template"], "title")
                self.assertIs(log["agreed_with_deterministic"], template_same)
                self.assertIs(log["show_agreed_with_deterministic"], show_same)
                self.assertIs(log["decision_changed"], changed)

    def test_prompt_carries_no_writable_text_field(self):
        seen = {}

        def ask(system, user_text, images, *, timeout):  # noqa: ARG001
            seen["system"] = system
            seen["user"] = user_text
            return {"show": True, "template": "title"}

        with workspace() as directory:
            self.run_plan(SHOT_WITH_CARD, ask, directory)
        self.assertIn("版式", seen["system"])
        self.assertIn("card_content", seen["user"])
        self.assertIn("只返回 JSON", seen["user"])

    def test_cache_hit_skips_the_model(self):
        calls = {"count": 0}

        def ask(system, user_text, images, *, timeout):  # noqa: ARG001
            calls["count"] += 1
            return {"show": True, "template": "cta", "reason": "号召语"}

        with workspace() as directory:
            first, _ = self.run_plan(SHOT_WITH_CARD, ask, directory)
            second, _ = self.run_plan(SHOT_WITH_CARD, ask, directory)
        self.assertEqual(calls["count"], 1)
        self.assertEqual(first["template"], second["template"])
        self.assertEqual(second["source"], "cache")

    def test_cache_can_be_disabled(self):
        calls = {"count": 0}

        def ask(system, user_text, images, *, timeout):  # noqa: ARG001
            calls["count"] += 1
            return {"show": True, "template": "title"}

        with workspace() as directory:
            self.run_plan(SHOT_WITH_CARD, ask, directory, PACKAGING_AGENT_CACHE="0")
            self.run_plan(SHOT_WITH_CARD, ask, directory, PACKAGING_AGENT_CACHE="0")
        self.assertEqual(calls["count"], 2)

    def test_show_false_is_kept_only_without_author_copy(self):
        with workspace() as directory:
            plan, _ = self.run_plan(SHOT_WITHOUT_CARD, reply(show=False, template="title",
                                                             reason="title 是占位标签"), directory)
            self.assertFalse(plan["show"])
        with workspace() as directory:
            plan, _ = self.run_plan(SHOT_WITH_CARD, reply(show=False, template="title"), directory)
            self.assertTrue(plan["show"])
            self.assertEqual(self.read_log(directory)["decision"]["overridden"], "author_card_content")


class PagedCompositionTests(unittest.TestCase):
    """分页动画的硬收尾。0.5.9 起分页的上屏文字一直渲不出来，就是缺这几行。"""

    def test_every_page_gets_a_hard_kill_at_its_own_end(self):
        source, manifest = build_composition(PAGED_SHOT, 1920, 1080, 8, PAGED_BOUNDS)
        pages = len(manifest["pages"])
        self.assertGreater(pages, 1, "这个样本必须分页，否则这条测试没有意义")
        interval = 8 / pages
        for index in range(pages):
            end = (index + 1) * interval
            with self.subTest(page=index):
                # 硬收尾必须紧跟在该页的淡出 tween 之后，时间点正好是这一页的 end
                #（= 下一页 clip 的起点，也就是 lint 报的那个边界）。
                self.assertRegex(
                    source,
                    r'tl\.to\("#page-%d".*?\);tl\.set\("#page-%d",\{opacity:0\},%s\);'
                    % (index, index, re.escape(str(end))),
                )
        self.assertEqual(len(HARD_KILL.findall(source)), pages)

    def test_single_page_keeps_the_old_animation_verbatim(self):
        # 样本只有 title、没有 card_content，验的是老路径，所以显式关掉「只按脚本上屏」。
        with patch.dict(os.environ, {"VIDEOAUTO_PACKAGING_SCRIPT_ONLY": "0"}):
            source, manifest = build_composition({"title": "一句话主张"}, 1920, 1080, 6)
        self.assertEqual(len(manifest["pages"]), 1)
        self.assertNotIn("tl.set(", source, "单页不触发 lint 规则，html 保持原样")

    def test_real_hyperframes_lint_accepts_the_paged_composition(self):
        """真 lint。四件套齐才跑。

        **在仓库工作区里恒 skip**（没有 node-runtime、没有 chrome）；解压后的运行包里会真跑。
        想在仓库里真跑，用覆盖键把四件套指过去，例如：
            VIDEOAUTO_NODE_EXE=<运行包>/node-runtime/node.exe \
            HYPERFRAMES_CLI=<运行包>/tools/material_gen/hyperframes/node_modules/hyperframes/dist/cli.js \
            HYPERFRAMES_GSAP=<运行包>/tools/material_gen/hyperframes/node_modules/gsap/dist/gsap.min.js \
            HYPERFRAMES_BROWSER_PATH=<运行包>/tools/material_gen/hyperframes/chrome-headless-shell/chrome-headless-shell.exe \
            python -m unittest tests.test_packaging_agent.PagedCompositionTests
        """
        import shutil
        import subprocess

        root = Path(__file__).resolve().parents[1]
        try:
            node, cli, gsap, _browser = renderer_dependencies(root)
        except RuntimeError as error:
            self.skipTest(f"没有 HyperFrames 运行组件，跳过真 lint：{error}")
        font = bundled_font_directory() / "NotoSansCJKsc-Bold.otf"
        if not font.is_file():
            self.skipTest("缺内置 Noto 字体，跳过真 lint")
        source, _ = build_composition(PAGED_SHOT, 1920, 1080, 8, PAGED_BOUNDS)
        # 这两个 env 必须带，和 render_overlay 一致：不带的话 hyperframes 会留下遥测/检查更新的
        # 后台子进程占着临时目录，Windows 上清理时报 WinError 32（2026-09-18 实测）。
        # ignore_cleanup_errors 再兜一层，别让清理失败把一条通过的 lint 判成 ERROR。
        environment = {**os.environ, "HYPERFRAMES_NO_TELEMETRY": "1", "HYPERFRAMES_NO_UPDATE_CHECK": "1"}
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as directory:
            work = Path(directory)
            (work / "index.html").write_text(source, encoding="utf-8")
            shutil.copy2(gsap, work / "gsap.min.js")
            shutil.copy2(font, work / font.name)
            completed = subprocess.run([str(node), str(cli), "lint", str(work)],
                                       cwd=work, env=environment, capture_output=True, text=True,
                                       encoding="utf-8", errors="replace", timeout=300)
        self.assertEqual(completed.returncode, 0,
                         f"分页的上屏文字没过 lint：\n{completed.stdout}\n{completed.stderr}")
        self.assertNotIn("gsap_exit_missing_hard_kill", completed.stdout)


class CompositionTests(unittest.TestCase):
    def test_plan_changes_only_the_template_not_the_copy(self):
        deterministic_kind, content = packaging_content(SHOT_WITH_CARD)
        self.assertEqual(deterministic_kind, "parameters")
        _source, manifest = build_composition(SHOT_WITH_CARD, 1920, 1080, 6,
                                              plan={"template": "cta", "show": True})
        self.assertEqual(manifest["template"], "cta")
        self.assertEqual(manifest["content"], content)
        self.assertEqual(manifest["template_source"], "agent")

    def test_single_page_output_matches_the_pre_change_module_byte_for_byte(self):
        """真对照：把 ba6553e（接入 agent 之前）那份 template_packaging.py 单独载进来比。

        单页不触发 HyperFrames 的 gsap_exit_missing_hard_kill，所以单页的 html 必须一个
        字节都不变——分页的硬收尾另见下面那条。

        样本里有一条只有 title、没有 card_content（`SHOT_WITHOUT_CARD`），这条对照验的是
        「退回 title」那条老路径，所以整段显式关掉「只按脚本上屏」；默认开启时那一镜不上
        卡片，另由 ScriptOnlyTests 验。
        """
        legacy = load_legacy_template_packaging()
        if legacy is None:
            # 第三次复审：逐字节回归是放行依据，缺 git 时不许静默跳过（跳过列表里只该有真 lint）
            self.fail("拿不到 ba6553e 的 template_packaging.py：本条逐字节回归必须在带 git 历史的仓库里跑"
                      "（git 不在 PATH / 浅克隆 / 非仓库布局）")
        for shot in SINGLE_PAGE_SAMPLES:
            with self.subTest(shot=shot.get("title")), patch.dict(
                    os.environ, {"VIDEOAUTO_PACKAGING_SCRIPT_ONLY": "0"}):
                self.assertEqual(packaging_content(shot), legacy.packaging_content(shot))
                new = build_composition(shot, 1920, 1080, 6)
                old = legacy.build_composition(shot, 1920, 1080, 6)
                self.assertEqual(len(new[1]["pages"]), 1, "这组样本必须是单页")
                self.assertEqual(new[0], old[0])          # html 源逐字节相同
                manifest = dict(new[1])
                self.assertEqual(manifest.pop("template_source"), "deterministic")
                self.assertEqual(manifest, old[1])

    def test_paged_output_only_adds_the_hard_kill_lines(self):
        """分页样本：除新增的 tl.set 硬收尾外，与 ba6553e 那版逐字节相同。

        2026-09-21 起包装路径用 kinsoku 换行（数字+单位不拆、孤字回退），分页结果本身会变，
        所以这条对照把换行禁则换回旧实现再比——**html 的其余部分仍必须一字不差**。
        新换行本身由 PackagingLineBreakTests 验。
        """
        legacy = load_legacy_template_packaging()
        if legacy is None:
            # 第三次复审：逐字节回归是放行依据，缺 git 时不许静默跳过（跳过列表里只该有真 lint）
            self.fail("拿不到 ba6553e 的 template_packaging.py：本条逐字节回归必须在带 git 历史的仓库里跑"
                      "（git 不在 PATH / 浅克隆 / 非仓库布局）")
        with patch.object(tp, "wrap_text_pixels", plain_wrap):
            new = build_composition(PAGED_SHOT, 1920, 1080, 8, PAGED_BOUNDS)
        old = legacy.build_composition(PAGED_SHOT, 1920, 1080, 8, PAGED_BOUNDS)
        self.assertGreater(len(new[1]["pages"]), 1, "这个样本必须分页")
        self.assertEqual(HARD_KILL.sub("", new[0]), old[0])
        manifest = dict(new[1])
        manifest.pop("template_source")
        self.assertEqual(manifest, old[1])

    def test_paged_card_uses_the_packaging_line_break_rules(self):
        """包装卡片走 kinsoku 换行：docs §9.1 的「路径确｜认」不再把词切成两半。"""
        _source, manifest = build_composition(PAGED_SHOT, 1920, 1080, 8, PAGED_BOUNDS)
        self.assertEqual(manifest["pages"],
                         [["新包装样件｜目标", "垛型｜现场布局｜", "抓具调整｜路径"], ["确认"]])

    def test_show_false_skips_the_overlay_entirely(self):
        self.assertIsNone(build_composition(SHOT_WITH_CARD, 1920, 1080, 6,
                                            plan={"template": "title", "show": False}))

    def test_title_shot_still_has_copy_so_packaging_never_starves(self):
        kind, content = packaging_content(SHOT_WITHOUT_CARD)
        self.assertEqual(kind, "title")
        self.assertEqual(content, "分镜3")


class RenderSegmentWiringTests(unittest.TestCase):
    def test_progress_event_is_a_running_compose_line(self):
        with contextlib.redirect_stdout(io.StringIO()) as printed:
            render_segment.emit_packaging_progress(2, 7, "包装决策 3/7")
        line = printed.getvalue().strip()
        self.assertTrue(line.startswith("VACUT_EVENT:"))
        payload = json.loads(line[len("VACUT_EVENT:"):])
        self.assertEqual(payload["workflowStage"], "compose")
        self.assertEqual(payload["workflowStatus"], "running")
        self.assertNotEqual(payload["workflowStatus"], "completed")
        self.assertEqual(payload["workflowProgress"]["current"], 2)
        self.assertEqual(payload["workflowProgress"]["total"], 7)

    def test_record_is_a_no_op_while_the_switch_is_off(self):
        with patch.dict(os.environ, {}, clear=True):
            sys.modules.pop("packaging_agent", None)
            render_segment.packaging_agent_record("final_check", {"any": 1})
            # 关闭态不许把 agent 模块拉进来，也不许往日志状态里写东西。
            self.assertNotIn("packaging_agent", sys.modules)
        with patch.dict(os.environ, {"PACKAGING_AGENT_SELECT": "1"}, clear=False):
            pa._STATE.clear()
            render_segment.packaging_agent_record("final_check", {"any": 1})
            self.assertEqual(pa._STATE, {})  # 没有进行中的决策时也不炸

    def test_shot_total_reads_the_plan_and_survives_garbage(self):
        with tempfile.TemporaryDirectory() as root:
            good = Path(root) / "shots.json"
            good.write_text(json.dumps({"shots": [{}, {}, {}]}), encoding="utf-8")
            self.assertEqual(pa.shot_total(str(good)), 3)
            bad = Path(root) / "bad.json"
            bad.write_text("{", encoding="utf-8")
            self.assertEqual(pa.shot_total(str(bad)), 0)
            self.assertEqual(pa.shot_total(""), 0)


if __name__ == "__main__":
    unittest.main()
