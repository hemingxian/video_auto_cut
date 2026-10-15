#!/usr/bin/env python3
"""脚本字段确定性校验的测试。跑法：python -m unittest tests.test_script_card_fields

不联网、不调模型：这一层本来就只读脚本原文 + plan。
回归用例直接拿 `docs/packaging-test-scripts-2026-09-21/` 的 5 份真脚本
和 2026-09-21 Windows 回帖 51296044 里记的那 14 处解析改动构造。

这一层会**真的改 plan**，所以测试的重点是「宁可漏报，绝不误改」：
未识别的字段名、镜号错位、跨行值、代码围栏、markdown 标记这五类都必须退成只告警。

2026-09-21 扩了两块，用例也跟着扩：
- **表格脚本**（xlsx / xlsm / csv）：表头识别、合并单元格、一镜多行、多 sheet、
  说明行、起始列不是 A、表头不在第 1 行——每一条都要么抽对，要么退成只告警；
- **`title` 纳入校验**：丢失 / 改写照纠，但脚本没写标题时 plan 里那个
  schema 兜底的「分镜N」或解析器自拟的标题**不算臆造**，一个字都不许动。
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

TOOLS = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS))

import script_card_fields as scf  # noqa: E402
import script_tabular  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
from xlsx_fixture import Formula, Number, write_xlsx  # noqa: E402

SCRIPTS = Path(__file__).resolve().parents[2] / "docs" / "packaging-test-scripts-2026-09-21"
U7_CAPTURED_PLAN = (Path(__file__).resolve().parents[2] / "docs" / "acceptance-evidence"
                    / "u7-title-stop-20260928-51392529" / "artifacts" / "final-shots-stop.json")

SAMPLE = """# 食品码垛工位观察

## 分镜 1

- 分镜标题：来料到位是第一道关
- 时长：7 秒
- 口播：袋装物料码垛，先看来料怎样到位。
- 上屏文字：来料到位是码垛稳定的第一道关
- 卡片样式：（不填）

## 分镜 2

- 分镜标题：袋料和箱体要分开核对
- 时长：8 秒
- 口播：袋料和箱体的外形不同。
- 上屏文字：（不填）
- 卡片样式：（不填）
"""

# 与 SAMPLE 对得上的 plan（口播逐字相同 = 锚点命中），测试都从它出发。
SAMPLE_SHOTS = (
    {"shot": 1, "title": "来料到位是第一道关", "voice_text": "袋装物料码垛，先看来料怎样到位。"},
    {"shot": 2, "title": "袋料和箱体要分开核对", "voice_text": "袋料和箱体的外形不同。"},
)


def plan_with(*shots: dict) -> dict:
    return {"topic": "t", "shots": [dict(shot) for shot in shots]}


def sample_plan(**overrides: dict) -> dict:
    """SAMPLE 对应的 plan；`overrides` 按镜号（1 起）补字段。"""
    shots = [dict(shot) for shot in SAMPLE_SHOTS]
    for number, extra in overrides.items():
        shots[int(str(number).lstrip("s")) - 1].update(extra)
    return {"topic": "t", "shots": shots}


def capture(function, *args, **kwargs):
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        result = function(*args, **kwargs)
    return result, buffer.getvalue()


class TempScriptMixin:
    def write_script(self, text: str, name: str = "script.md") -> Path:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / name
        path.write_text(text, encoding="utf-8")
        return path


# ----------------------------------------------------------------------------
# 原文抽取
# ----------------------------------------------------------------------------

class ExtractionTests(unittest.TestCase, TempScriptMixin):
    def test_extracts_both_fields_and_folds_placeholders_to_empty(self):
        blocks = scf.extract_shot_card_fields(SAMPLE)
        self.assertEqual(len(blocks), 2)
        self.assertEqual(blocks[0]["card_content"]["value"], "来料到位是码垛稳定的第一道关")
        # 「（不填）」写了但等于没写
        self.assertTrue(blocks[0]["card_hint"]["present"])
        self.assertEqual(blocks[0]["card_hint"]["value"], "")
        self.assertEqual(blocks[1]["card_content"]["value"], "")

    def test_shot_title_field_is_not_mistaken_for_a_shot_marker(self):
        # 「- 分镜标题：…」若被当成分镜标记，块数会翻倍
        self.assertEqual(len(scf.extract_shot_card_fields(SAMPLE)), 2)

    def test_prose_mentioning_a_shot_number_breaks_the_1_to_n_sequence(self):
        text = SAMPLE + "\n分镜 2 的画面要注意别拍到护栏。\n"
        # 编号变成 1,2,2 → 结构不可信 → 整份放弃
        self.assertIsNone(scf.extract_shot_card_fields(text))

    def test_free_form_script_without_shot_markers_is_skipped(self):
        self.assertIsNone(scf.extract_shot_card_fields(
            "这是一段自由格式的脚本说明，没有任何分镜标记。\n上屏文字：随便写的\n"))

    def test_english_script_is_supported(self):
        text = (
            "# Palletizing\n\n"
            "## Shot 1\n\n"
            "- Duration: 8s\n"
            "- On-screen text: One cell, three incoming formats\n"
            "- Card style: title card\n\n"
            "## Shot 2\n\n"
            "- Duration: 8s\n"
            "- On-screen text: N/A\n"
            "- card_hint: (none)\n"
        )
        blocks = scf.extract_shot_card_fields(text)
        self.assertEqual(len(blocks), 2)
        self.assertEqual(blocks[0]["card_content"]["value"], "One cell, three incoming formats")
        self.assertEqual(blocks[0]["card_hint"]["value"], "title card")
        self.assertEqual(blocks[1]["card_content"]["value"], "")
        self.assertEqual(blocks[1]["card_hint"]["value"], "")

    def test_value_with_its_own_colon_keeps_the_whole_value(self):
        text = SAMPLE.replace("- 上屏文字：来料到位是码垛稳定的第一道关",
                              "- 上屏文字：来料确认：袋口朝向一致｜抓取确认：抓取位居中")
        blocks = scf.extract_shot_card_fields(text)
        self.assertEqual(blocks[0]["card_content"]["value"],
                         "来料确认：袋口朝向一致｜抓取确认：抓取位居中")

    def test_bold_key_with_the_colon_inside_the_emphasis(self):
        text = SAMPLE.replace("- 上屏文字：来料到位是码垛稳定的第一道关",
                              "- **上屏文字：** 来料到位是码垛稳定的第一道关")
        blocks = scf.extract_shot_card_fields(text)
        # 值不许把 `**` 带进卡片
        self.assertEqual(blocks[0]["card_content"]["value"], "来料到位是码垛稳定的第一道关")

    def test_placeholder_only_matches_the_whole_value(self):
        for placeholder in ("（不填）", "不填", "无", "N/A", "（无）", "  "):
            with self.subTest(value=placeholder):
                self.assertTrue(scf.is_placeholder(placeholder, "card_content"))
        for real in ("无人化产线", "无需人工复核", "不填不代表不重要", "无 人 值 守"):
            with self.subTest(value=real):
                self.assertFalse(scf.is_placeholder(real, "card_content"))

    def test_bare_symbols_are_placeholders_for_every_field(self):
        """2026-09-23 用户拍板：上屏列里的纯符号 / 「空白」「不上屏」都等于作者没写卡片。

        （9/21 版把 `card_content` 上的符号当正文，作者写的「—」会直接上屏。）
        """
        for symbol in ("-", "—", "–", "——", "－", "／", "/", " / ", "--", "空白", "不上屏",
                       "无", "N/A", "（无）", "(无)", "—\n", "\u3000\u3000"):
            with self.subTest(value=symbol):
                self.assertTrue(scf.is_placeholder(symbol, "card_content"))
                self.assertTrue(scf.is_placeholder(symbol, "card_hint"))
        for real in ("A/B", "1—2", "-5℃", "／分隔／", "无人化"):
            with self.subTest(value=real):
                self.assertFalse(scf.is_placeholder(real, "card_content"))

    def test_fenced_example_blocks_are_ignored(self):
        text = SAMPLE.replace(
            "## 分镜 2",
            "写法参考：\n\n```\n- 上屏文字：示例占位文案\n```\n\n## 分镜 2", 1)
        blocks = scf.extract_shot_card_fields(text)
        self.assertEqual(len(blocks), 2)
        # 围栏里的示例不许算成第 1 镜的第二条上屏文字（那会把它判成写法不唯一）
        self.assertTrue(blocks[0]["card_content"]["reliable"])
        self.assertEqual(blocks[0]["card_content"]["value"], "来料到位是码垛稳定的第一道关")

    def test_non_text_formats_are_not_read(self):
        self.assertIsNone(scf.read_script_text(self.write_script(SAMPLE, name="script.docx")))

    def test_utf16_is_not_guessed_at(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / "s.md"
        path.write_bytes(SAMPLE.encode("utf-16"))
        text = scf.read_script_text(path)
        # 解码成乱码也不要紧：切不出分镜块 → 零动作
        self.assertIsNone(scf.extract_shot_card_fields(text or ""))


# ----------------------------------------------------------------------------
# 比对与纠正
# ----------------------------------------------------------------------------

class ReconcileTests(unittest.TestCase, TempScriptMixin):
    def setUp(self):
        self.script = self.write_script(SAMPLE)

    def test_missing_card_content_is_restored_from_the_script(self):
        plan = sample_plan()
        report = scf.reconcile(plan, self.script)
        self.assertEqual(report["status"], "ok")
        self.assertEqual([(c["shot"], c["field"], c["kind"]) for c in report["corrections"]],
                         [(1, "card_content", "missing")])
        self.assertEqual(plan["shots"][0]["card_content"], "来料到位是码垛稳定的第一道关")

    def test_invented_card_hint_is_cleared(self):
        plan = sample_plan(s1={"card_content": "来料到位是码垛稳定的第一道关",
                               "card_hint": "on-screen text display"})
        report = scf.reconcile(plan, self.script)
        self.assertEqual([(c["shot"], c["field"], c["kind"]) for c in report["corrections"]],
                         [(1, "card_hint", "invented")])
        # 空值按 schema 的口径直接把键去掉，不留空串
        self.assertNotIn("card_hint", plan["shots"][0])

    def test_rewritten_value_is_replaced_by_the_script_text(self):
        plan = sample_plan(s1={"card_content": "来料到位，码垛才稳"})
        report = scf.reconcile(plan, self.script)
        self.assertEqual([c["kind"] for c in report["corrections"]], ["rewritten"])
        self.assertEqual(plan["shots"][0]["card_content"], "来料到位是码垛稳定的第一道关")

    def test_whitespace_only_differences_are_not_corrections(self):
        plan = sample_plan(s1={"card_content": " 来料到位是码垛稳定的第一道关 "})
        self.assertEqual(scf.reconcile(plan, self.script)["corrections"], [])

    def test_markdown_emphasis_only_differences_are_not_corrections(self):
        script = self.write_script(SAMPLE.replace(
            "- 上屏文字：来料到位是码垛稳定的第一道关",
            "- 上屏文字：**来料到位是码垛稳定的第一道关**"))
        plan = sample_plan(s1={"card_content": "来料到位是码垛稳定的第一道关"})
        report = scf.reconcile(plan, script)
        self.assertEqual(report["corrections"], [])
        # 不许把星号搬进卡片
        self.assertEqual(plan["shots"][0]["card_content"], "来料到位是码垛稳定的第一道关")

    def test_script_side_line_breaks_are_folded_like_normalize_script_does(self):
        script = self.write_script(SAMPLE.replace(
            "- 上屏文字：来料到位是码垛稳定的第一道关",
            "- 上屏文字：来料到位   是码垛\t稳定的第一道关"))
        plan = sample_plan(s1={"card_content": "来料到位 是码垛 稳定的第一道关"})
        self.assertEqual(scf.reconcile(plan, script)["corrections"], [])

    # ---- 五道「宁可漏报」的闸门 ----

    def test_shot_count_mismatch_only_warns(self):
        plan = plan_with(SAMPLE_SHOTS[0])
        report = scf.reconcile(plan, self.script)
        self.assertEqual(report["status"], "skipped:shot_count")
        self.assertEqual(report["corrections"], [])
        self.assertEqual(len(report["warnings"]), 1)
        self.assertNotIn("card_content", plan["shots"][0])

    def test_unrecognised_field_name_does_not_wipe_a_correct_plan(self):
        """作者用了同义词表不认识的字段名 → 不许把解析器抽对的值当「臆造」删掉。"""
        script = self.write_script(SAMPLE
                                   .replace("- 上屏文字：", "- 字幕文字：")
                                   .replace("- 卡片样式：（不填）", "- 花字样式：黄底黑字"))
        plan = sample_plan(s1={"card_content": "来料到位是码垛稳定的第一道关",
                               "card_hint": "黄底黑字"})
        report = scf.reconcile(plan, script)
        self.assertEqual(report["corrections"], [])
        self.assertEqual(plan["shots"][0]["card_content"], "来料到位是码垛稳定的第一道关")
        self.assertEqual(plan["shots"][0]["card_hint"], "黄底黑字")
        self.assertTrue(any("本表不认识的字段名" in w for w in report["warnings"]))

    def test_shot_identity_must_be_confirmed_by_an_anchor(self):
        """块数相等但镜号错位（qwen 合并/拆分分镜）→ 只告警，不许把别镜的文字写进来。"""
        plan = plan_with(
            {"shot": 1, "title": "x", "voice_text": "完全不相干的一句口播。"},
            {"shot": 2, "title": "y", "voice_text": "另一句也不相干。"},
        )
        report = scf.reconcile(plan, self.script)
        self.assertEqual(report["corrections"], [])
        self.assertNotIn("card_content", plan["shots"][0])
        self.assertTrue(any("镜号可能错位" in w for w in report["warnings"]))

    def test_a_block_without_any_anchor_only_warns(self):
        script = self.write_script(
            "## 分镜 1\n\n- 上屏文字：甲\n\n## 分镜 2\n\n- 上屏文字：乙\n")
        plan = plan_with({"shot": 1, "title": "a"}, {"shot": 2, "title": "b"})
        report = scf.reconcile(plan, script)
        self.assertEqual(report["corrections"], [])
        self.assertTrue(any("确认镜号" in w for w in report["warnings"]))

    def test_anchor_matches_even_when_the_title_was_rewritten(self):
        """口播对得上就算认人成功——03 第 4/6 镜的 title 正是被解析器改写过的。

        认人成功之后，被改写的 title 自己也会按脚本原文纠回来（2026-09-21 起）。
        """
        plan = sample_plan(s1={"title": "解析器改写过的标题"})
        report = scf.reconcile(plan, self.script)
        self.assertEqual([(c["field"], c["kind"]) for c in report["corrections"]],
                         [("card_content", "missing"), ("title", "rewritten")])
        self.assertEqual(plan["shots"][0]["title"], "来料到位是第一道关")

    def test_duplicate_field_lines_in_one_shot_only_warn(self):
        script = self.write_script(SAMPLE.replace(
            "- 卡片样式：（不填）\n\n## 分镜 2",
            "- 上屏文字：另一句上屏文字\n- 卡片样式：（不填）\n\n## 分镜 2", 1))
        plan = sample_plan()
        report = scf.reconcile(plan, script)
        self.assertEqual(report["corrections"], [])
        self.assertTrue(any("card_content" in w for w in report["warnings"]))
        self.assertNotIn("card_content", plan["shots"][0])

    def test_value_continued_on_the_next_line_only_warns(self):
        for continuation in ("  是码垛稳定的第一道关",            # 缩进续行
                             "是码垛稳定的第一道关",              # 顶格续行
                             "  抓取确认：抓取位居中"):           # 续行里自带冒号
            with self.subTest(continuation=continuation):
                script = self.write_script(SAMPLE.replace(
                    "- 上屏文字：来料到位是码垛稳定的第一道关",
                    f"- 上屏文字：来料到位\n{continuation}", 1))
                plan = sample_plan()
                report = scf.reconcile(plan, script)
                self.assertEqual(report["corrections"], [])
                self.assertTrue(any("跨行" in w for w in report["warnings"]))
                self.assertNotIn("card_content", plan["shots"][0])

    # ---- 零动作 ----

    def test_free_form_script_is_a_no_op(self):
        script = self.write_script("没有分镜标记的自由格式脚本。\n")
        plan = plan_with({"shot": 1, "title": "a", "card_content": "随便"})
        before = json.dumps(plan, ensure_ascii=False, sort_keys=True)
        report = scf.reconcile(plan, script)
        self.assertEqual(report["status"], "skipped:no_markers")
        self.assertEqual(json.dumps(plan, ensure_ascii=False, sort_keys=True), before)

    def test_binary_format_is_a_no_op(self):
        script = self.write_script(SAMPLE, name="script.xlsx")
        plan = sample_plan(s1={"card_content": "随便"})
        before = json.dumps(plan, ensure_ascii=False, sort_keys=True)
        report = scf.reconcile(plan, script)
        self.assertEqual(report["status"], "skipped:format")
        self.assertEqual(json.dumps(plan, ensure_ascii=False, sort_keys=True), before)

    def test_script_without_card_fields_at_all_is_a_zero_action(self):
        text = ("# t\n\n## 分镜 1\n\n- 口播：袋装物料码垛，先看来料怎样到位。\n\n"
                "## 分镜 2\n\n- 口播：袋料和箱体的外形不同。\n")
        script = self.write_script(text)
        plan = sample_plan()
        before = json.dumps(plan, ensure_ascii=False, sort_keys=True)
        report = scf.reconcile(plan, script)
        self.assertEqual(report["status"], "ok")
        self.assertEqual(report["corrections"], [])
        self.assertEqual(json.dumps(plan, ensure_ascii=False, sort_keys=True), before)

    # ---- 开关与原子性 ----

    def test_autofix_off_reports_without_changing_the_plan(self):
        plan = sample_plan()
        report = scf.reconcile(plan, self.script, autofix=False)
        self.assertEqual(len(report["corrections"]), 1)
        self.assertFalse(report["corrections"][0]["applied"])
        self.assertNotIn("card_content", plan["shots"][0])

    def test_autofix_env_switch_defaults_to_on(self):
        plan = sample_plan()
        with mock.patch.dict(os.environ, {scf.AUTOFIX_ENV: "0"}):
            scf.reconcile(plan, self.script)
        self.assertNotIn("card_content", plan["shots"][0])
        with mock.patch.dict(os.environ, {}, clear=True):
            scf.reconcile(plan, self.script)
        self.assertEqual(plan["shots"][0]["card_content"], "来料到位是码垛稳定的第一道关")

    def test_a_mid_way_failure_leaves_the_original_plan_untouched(self):
        plan = sample_plan()
        before = json.dumps(plan, ensure_ascii=False, sort_keys=True)
        with mock.patch.object(scf, "anchor_verdict", side_effect=RuntimeError("boom")):
            report, printed = capture(scf.verify_and_fix, plan, self.script)
        self.assertEqual(report["status"], "error")
        self.assertEqual(json.dumps(plan, ensure_ascii=False, sort_keys=True), before)
        self.assertNotIn("Traceback", printed)


# ----------------------------------------------------------------------------
# 日志 / 事件
# ----------------------------------------------------------------------------

class OutputTests(unittest.TestCase, TempScriptMixin):
    def setUp(self):
        self.script = self.write_script(SAMPLE)

    def test_event_is_emitted_only_when_something_was_corrected(self):
        plan = sample_plan()
        _report, printed = capture(scf.verify_and_fix, plan, self.script)
        lines = [line for line in printed.splitlines() if line.startswith("VACUT_EVENT:")]
        self.assertEqual(len(lines), 1)
        payload = json.loads(lines[0][len("VACUT_EVENT:"):])
        self.assertEqual(payload["workflowStage"], "script")
        self.assertEqual(payload["workflowProgress"]["phase"], "card_fields")
        # 不许带 current/total：桌面端会把它们当成 script 阶段的真实进度
        self.assertNotIn("current", payload["workflowProgress"])
        self.assertNotIn("total", payload["workflowProgress"])
        self.assertEqual([(c["shot"], c["field"], c["kind"])
                          for c in payload["cardFieldCorrections"]],
                         [(1, "card_content", "missing")])
        # 事件正文必须是纯 ASCII：任何控制台编码下都安全，而且一个字都不丢
        # （`printable()` 那条 `?` 替换只给人读的日志行用）
        event_line = lines[0]
        event_line.encode("ascii")
        self.assertEqual(payload["cardFieldCorrections"][0]["script"],
                         "来料到位是码垛稳定的第一道关")

    def test_no_event_when_everything_matches(self):
        plan = sample_plan(s1={"card_content": "来料到位是码垛稳定的第一道关"})
        _report, printed = capture(scf.verify_and_fix, plan, self.script)
        self.assertNotIn("VACUT_EVENT", printed)
        self.assertIn("逐字一致", printed)

    def test_every_log_line_survives_a_gbk_stdout(self):
        """中文 Windows 把 stdout 重定向到文件时按 gbk 编码：日志里不许有 gbk 编不出的符号。

        这一层的兜底日志自己崩掉的话，「绝不带倒脚本解析」就失效了（shots.json 写不出来）。
        """
        cases = [
            sample_plan(),                                              # 有纠正
            sample_plan(s1={"card_content": "来料到位是码垛稳定的第一道关"}),  # 全一致
            plan_with({"shot": 1, "title": "x", "voice_text": "对不上的口播。"},
                      {"shot": 2, "title": "y", "voice_text": "也对不上。"}),   # 只告警
            plan_with(SAMPLE_SHOTS[0]),                                 # 镜数不符
        ]
        for index, plan in enumerate(cases):
            with self.subTest(case=index):
                _report, printed = capture(scf.verify_and_fix, plan, self.script)
                printed.encode("gbk")  # 编不出就抛，等价于 Windows 上那次崩溃
        # 连「校验本身出错」那条兜底也要能编出来
        with mock.patch.object(scf, "anchor_verdict", side_effect=RuntimeError("坏了")):
            _report, printed = capture(scf.verify_and_fix, sample_plan(), self.script)
        printed.encode("gbk")

    def test_text_the_author_wrote_is_sanitised_for_the_console_encoding(self):
        """作者在上屏文字里放了 emoji / `⚠`，日志会原样回显它——不许因此崩掉。

        模块自己写的字全是 ASCII 符号 + 汉字，**不安全的只可能是外来内容**，
        所以在输出出口统一过一道 `printable()`。
        """
        script = self.write_script(SAMPLE.replace(
            "- 上屏文字：来料到位是码垛稳定的第一道关",
            "- 上屏文字：⚠ 来料到位是第一道关 🚀"))
        plan = sample_plan(s1={"card_content": "模型改写过的一句 ★"})

        class GbkStdout(io.StringIO):
            encoding = "gbk"

        buffer = GbkStdout()
        with contextlib.redirect_stdout(buffer):
            scf.verify_and_fix(plan, script)
        printed = buffer.getvalue()
        printed.encode("gbk")                 # 编不出就抛，等价于 Windows 上那次崩溃
        self.assertIn("VACUT_EVENT", printed)  # 事件没被兜底吃掉
        self.assertIn("?", printed)            # 编不出的字符换成了 `?`
        # plan 里仍是原文，只有**日志**被净化过
        self.assertEqual(plan["shots"][0]["card_content"], "⚠ 来料到位是第一道关 🚀")

    def test_printable_is_a_no_op_under_utf8(self):
        class Utf8Stdout(io.StringIO):
            encoding = "utf-8"

        with contextlib.redirect_stdout(Utf8Stdout()):
            self.assertEqual(scf.printable("⚠ 甲 🚀"), "⚠ 甲 🚀")

    def test_verify_never_raises(self):
        plan = sample_plan()
        report, printed = capture(scf.verify_and_fix, plan, Path("/nonexistent/x.md"))
        self.assertEqual(report["corrections"], [])
        self.assertNotIn("Traceback", printed)


# ----------------------------------------------------------------------------
# 回归：5 份真脚本 + Windows 回帖 51296044 记的那批解析改动
# ----------------------------------------------------------------------------

EXPECTED = {
    "01_对照组_无上屏卡片_食品码垛_CN.md": [("", "")] * 6,
    "02_全镜上屏_三版式_食品码垛_CN.md": [
        ("来料到位是码垛稳定的第一道关", ""),
        ("来料朝向、抓取位置、支撑方式，三项分别核对", ""),
        ("节拍 700 包/小时｜输送带连续来料｜托盘满垛下线", "参数卡，列表排版"),
        ("落盘后先核对方向和边缘，再放行下一层", ""),
        ("新包装样件、目标垛型、现场布局，三样先备齐", "要点卡"),
        ("想看你现场这条线能不能这样排，欢迎把布局图发过来一起看", ""),
        ("想把你的包装形态和垛型试一遍，欢迎联系我们", "CTA 行动号召"),
    ],
    "03_混合_show判定_食品码垛_CN.md": [
        ("来料到位是码垛稳定的第一道关", ""),
        ("", ""), ("", ""), ("", ""),
        ("占位卡 05", ""),
        ("", ""),
        ("带上你的包装形态和目标垛型，一起把这条线试一遍", "CTA 行动号召"),
    ],
    "04_边界_排版极限_含预期失败镜_食品码垛_CN.md": [
        ("满垛", ""),
        ("节拍 700 包/小时", ""),
        ("视觉定位 Vision-Guided 抓取｜托盘 Pallet 满垛下线", ""),
        ("来料确认：袋口朝向一致、间距均匀｜抓取确认：抓取位居中、不压袋角｜"
         "抬升确认：不碰输送带护栏、不甩料｜落盘确认：排列方向一致、垛层边缘对齐｜"
         "退出确认：抓具退出路径避让｜下线确认：满垛稳定、标识朝外", "参数卡，列表排版"),
        ("抓取位居中不压袋角并逐项核对来料朝向与输送节拍确认", ""),
        ("PalletizingChangeoverVerificationChecklistForBottledWater"
         "MilkCartonsAndFlourBagsOnTheSameRobotCell",
         "英文长标题，逐字保留，不要拆词、不要加空格"),
    ],
    "05_真实出片_食品码垛讲解_48s_CN.md": [
        ("一条线同时接住瓶装、箱装和袋装", ""),
        ("", ""), ("", ""), ("", ""),
        ("节拍 700 包/小时｜输送带连续来料｜托盘满垛下线", "参数卡"),
        ("把你的包装形态和目标垛型发过来，我们照着试一遍", ""),
    ],
}

# 5 份脚本每镜的口播原文（锚点）。解析器逐字提取 voice_text（document_quote），
# 所以这批值同时也是 plan 里的 voice_text。
VOICE = {
    "01_对照组_无上屏卡片_食品码垛_CN.md": [
        "袋装物料码垛，先看来料怎样到位，再看机械臂如何抓取和落放。",
        "袋料和箱体的外形不同，来料朝向、抓取位置和支撑方式要分别核对。",
        "抓具带料抬起、转向时，要检查包装与工具有没有碰到输送带护栏。",
        "包装落到托盘以后，还要核对排列方向、垛层边缘和抓具退出的路径。",
        "把取料端、输送线和托盘位置放在一起看，更容易看清工位之间的衔接。",
        "这些运动画面可以帮助理解工位配置，却不能替代破包、滑移和满垛稳定性的现场试验。",
    ],
    "02_全镜上屏_三版式_食品码垛_CN.md": [
        "袋装物料码垛，先看来料怎样到位，再看机械臂如何抓取和落放。",
        "袋料和箱体的外形不同，来料朝向、抓取位置和支撑方式要分别核对。",
        "这条包装线的设计节拍是每小时七百包，来料不断流，抓取节奏才稳得住。",
        "包装落到托盘以后，还要核对排列方向、垛层边缘和抓具退出的路径。",
        "换包装之前，先备好新包装样件、目标垛型和现场布局，再逐项确认要调整的抓具与路径。",
        "把取料端、输送线和托盘位置放在一起看，更容易看清工位之间的衔接。",
        "动态画面只能帮着理解工位配置，破包、滑移和满垛稳定性还是要在现场试。",
    ],
    "03_混合_show判定_食品码垛_CN.md": [
        "袋装物料码垛，先看来料怎样到位，再看机械臂如何抓取和落放。",
        "袋料和箱体的外形不同，来料朝向、抓取位置和支撑方式要分别核对。",
        "抓具带料抬起、转向时，要检查包装与工具有没有碰到输送带护栏。",
        "包装落到托盘以后，还要核对排列方向、垛层边缘和抓具退出的路径。",
        "换包装之前，先备好新包装样件、目标垛型和现场布局，再逐项确认要调整的抓具与路径。",
        "把取料端、输送线和托盘位置放在一起看，更容易看清工位之间的衔接。",
        "动态画面只能帮着理解工位配置，破包、滑移和满垛稳定性还是要在现场试。",
    ],
    "04_边界_排版极限_含预期失败镜_食品码垛_CN.md": [
        "一托满垛下线，方向一致、边缘对齐，才算这一垛做完。",
        "这条包装线的设计节拍是每小时七百包，来料不断流，抓取节奏才稳得住。",
        "来料位置每次都会有偏差，先定位再抓取，落到托盘上的方向才会一致。",
        "换包装的时候，从来料到下线，每一段都要逐项确认一遍，漏一项现场就要返工。",
        "抓取位要居中，不能压到袋角，来料朝向和输送节拍也要一起看。",
        "同一套工位要同时兼顾瓶装、箱装和袋装，换型清单就得一条一条对。",
    ],
    "05_真实出片_食品码垛讲解_48s_CN.md": [
        "食品包装线的末端，机器人要同时接住瓶装、箱装和袋装三种来料。",
        "来料先在输送带上排好队，位置和朝向稳定了，抓取才有统一的基准。",
        "抓具带料抬起转向的时候，包装和工具的完整外廓都不能碰到输送带护栏。",
        "落到托盘上，排列方向、垛层边缘和抓具退出的路径，三项一起核对。",
        "这条袋装线的设计节拍是每小时七百包，来料不断流，节奏才稳得住。",
        "换包装形态之前，先备齐样件和目标垛型，再逐项确认抓具与路径。",
    ],
}


# 5 份脚本每镜的「分镜标题」原文。02 / 04 压根没写分镜标题——那两份的 plan 里
# 标题一定是解析器自拟或 schema 兜底的「分镜N」，**不许被当成臆造清掉**。
TITLES = {
    "01_对照组_无上屏卡片_食品码垛_CN.md": [
        "来料到位是第一道关", "袋料和箱体要分开核对", "抬升转向不碰护栏",
        "落盘后核对三项", "工位衔接一起看", "现场试验不能省",
    ],
    "02_全镜上屏_三版式_食品码垛_CN.md": [""] * 7,
    "03_混合_show判定_食品码垛_CN.md": [
        "来料到位是第一道关", "袋料和箱体要分开核对", "镜头B",
        "包装落到托盘以后还要核对排列方向垛层边缘和抓具退出的路径",
        "换型准备", "开场", "欢迎带着包装形态来试",
    ],
    "04_边界_排版极限_含预期失败镜_食品码垛_CN.md": [""] * 6,
    "05_真实出片_食品码垛讲解_48s_CN.md": [
        "一条线同时接三种来料", "来料排好队抓取才有基准", "抬升转向不碰护栏",
        "落盘后三项一起核对", "节拍七百包每小时", "换型前先备齐再逐项确认",
    ],
}


def plan_for(script: str, cards: list[tuple[str, str]]) -> dict:
    """按脚本的口播 / 标题原文造一份 plan，卡片字段由调用方给（模拟解析器的产出）。

    脚本没写标题的（02 / 04）就填 schema 兜底的「分镜N」——正是解析器的真实产物。
    """
    shots = []
    for index, (voice, (content, hint)) in enumerate(zip(VOICE[script], cards), 1):
        title = TITLES[script][index - 1] or f"分镜{index}"
        shot: dict = {"shot": index, "title": title, "voice_text": voice}
        if content:
            shot["card_content"] = content
        if hint:
            shot["card_hint"] = hint
        shots.append(shot)
    return {"topic": "t", "shots": shots}


@unittest.skipUnless(SCRIPTS.is_dir(), "测试脚本目录不在（只在仓库里跑）")
class RealScriptRegressionTests(unittest.TestCase):
    def test_every_shot_of_the_five_scripts_is_extracted_verbatim(self):
        for name, expected in EXPECTED.items():
            with self.subTest(script=name):
                text = scf.read_script_text(SCRIPTS / name)
                self.assertIsNotNone(text)
                blocks = scf.extract_shot_card_fields(text)
                self.assertIsNotNone(blocks, "5 份脚本必须都能切出分镜块")
                self.assertEqual(
                    [(block["card_content"]["value"], block["card_hint"]["value"])
                     for block in blocks], expected)
                self.assertTrue(all(block[field]["reliable"] for block in blocks
                                    for field in scf.FIELDS),
                                "5 份脚本的上屏字段都应判为可靠")

    def test_readme_is_not_mistaken_for_a_script(self):
        text = scf.read_script_text(SCRIPTS / "README_测试说明.md")
        self.assertIsNone(scf.extract_shot_card_fields(text))

    def test_a_clean_parse_of_each_script_needs_no_correction(self):
        """解析器完全正确时零纠正——这是「不误改」的总闸门。"""
        for name, cards in EXPECTED.items():
            with self.subTest(script=name):
                plan = plan_for(name, cards)
                before = json.dumps(plan, ensure_ascii=False, sort_keys=True)
                report = scf.reconcile(plan, SCRIPTS / name)
                self.assertEqual(report["status"], "ok")
                self.assertEqual(report["corrections"], [])
                self.assertEqual(report["warnings"], [])
                self.assertEqual(json.dumps(plan, ensure_ascii=False, sort_keys=True), before)

    def test_the_parser_edits_from_the_windows_report_are_all_caught(self):
        """回帖 51296044 第三节那张表里属于上屏字段的 10 处，逐条应被抽出并纠正。

        另外 4 处（03-4 / 03-6 的 title、04-3 的 duration）不是上屏字段，
        本层**不碰**——这里一并钉住「不越界」。
        """
        # 03：丢了第 1 镜的 card_content、第 5 镜造了英文 hint、第 4/6 镜 title 被改写
        name = "03_混合_show判定_食品码垛_CN.md"
        plan = plan_for(name, [("", ""), ("", ""), ("", ""), ("", ""),
                               ("占位卡 05", "placeholder card"), ("", ""),
                               ("带上你的包装形态和目标垛型，一起把这条线试一遍", "CTA 行动号召")])
        plan["shots"][3]["title"] = "落盘后核对方向与路径"
        plan["shots"][5]["title"] = "整合视图看工位衔接"   # 解析器把字幕原样抄成了标题
        plan["shots"][3]["duration"] = 7
        report = scf.reconcile(plan, SCRIPTS / name)
        self.assertEqual([(c["shot"], c["field"], c["kind"]) for c in report["corrections"]],
                         [(1, "card_content", "missing"), (4, "title", "rewritten"),
                          (5, "card_hint", "invented"), (6, "title", "rewritten")])
        self.assertEqual(plan["shots"][0]["card_content"], "来料到位是码垛稳定的第一道关")
        self.assertNotIn("card_hint", plan["shots"][4])
        # 2026-09-21 起 title 也按脚本原文纠回来（B8 的两个探针）
        self.assertEqual(plan["shots"][3]["title"],
                         "包装落到托盘以后还要核对排列方向垛层边缘和抓具退出的路径")
        self.assertEqual(plan["shots"][5]["title"], "开场")
        # 越界闸门：duration 仍然一个字不动
        self.assertEqual(plan["shots"][3]["duration"], 7)

        # 02：4 处凭空写入的英文 hint
        name = "02_全镜上屏_三版式_食品码垛_CN.md"
        cards = list(EXPECTED[name])
        for index, hint in ((0, "on-screen text display"), (1, "centered text on screen"),
                            (3, "text on screen"), (5, "on-screen text display")):
            cards[index] = (cards[index][0], hint)
        plan = plan_for(name, cards)
        report = scf.reconcile(plan, SCRIPTS / name)
        self.assertEqual([(c["shot"], c["kind"]) for c in report["corrections"]],
                         [(1, "invented"), (2, "invented"), (4, "invented"), (6, "invented")])

        # 04：第 1 镜造 hint、第 4/6 镜 hint 被翻成英文；duration 不碰
        name = "04_边界_排版极限_含预期失败镜_食品码垛_CN.md"
        cards = list(EXPECTED[name])
        cards[0] = (cards[0][0], "text on screen")
        cards[3] = (cards[3][0], "parameter card with vertical list layout")
        cards[5] = (cards[5][0], "English long title, keep characters as they are")
        plan = plan_for(name, cards)
        plan["shots"][2]["duration"] = 8
        report = scf.reconcile(plan, SCRIPTS / name)
        self.assertEqual([(c["shot"], c["kind"]) for c in report["corrections"]],
                         [(1, "invented"), (4, "rewritten"), (6, "rewritten")])
        self.assertEqual(plan["shots"][3]["card_hint"], "参数卡，列表排版")
        self.assertEqual(plan["shots"][5]["card_hint"],
                         "英文长标题，逐字保留，不要拆词、不要加空格")
        self.assertEqual(plan["shots"][2]["duration"], 8)

        # 05：第 1 镜造 hint、第 5 镜 hint 被翻成英文
        name = "05_真实出片_食品码垛讲解_48s_CN.md"
        cards = list(EXPECTED[name])
        cards[0] = (cards[0][0], "on-screen text display")
        cards[4] = (cards[4][0], "parameter card")
        plan = plan_for(name, cards)
        report = scf.reconcile(plan, SCRIPTS / name)
        self.assertEqual([(c["shot"], c["kind"]) for c in report["corrections"]],
                         [(1, "invented"), (5, "rewritten")])
        self.assertEqual(plan["shots"][4]["card_hint"], "参数卡")

    def test_a_merged_shot_plan_is_not_silently_realigned(self):
        """qwen 把 7 段合成 6 镜再拆回 7 条时，块数仍相等——必须靠锚点挡住。"""
        name = "03_混合_show判定_食品码垛_CN.md"
        plan = plan_for(name, EXPECTED[name])
        # 把口播和标题整体前移一镜：块数不变，镜号全错
        # （标题也要转——它本来就是三个内容锚点之一，只转口播的话靠标题仍认得出人）
        voices = [shot["voice_text"] for shot in plan["shots"]]
        titles = [shot["title"] for shot in plan["shots"]]
        for shot, voice, title in zip(plan["shots"], voices[1:] + voices[:1],
                                      titles[1:] + titles[:1]):
            shot["voice_text"] = voice
            shot["title"] = title
        for shot in plan["shots"]:
            shot.pop("card_content", None)
            shot.pop("card_hint", None)
        report = scf.reconcile(plan, SCRIPTS / name)
        self.assertEqual(report["corrections"], [])
        self.assertTrue(all("card_content" not in shot for shot in plan["shots"]))
        self.assertTrue(any("镜号可能错位" in w for w in report["warnings"]))

# ----------------------------------------------------------------------------
# 表格脚本：只读取那一层（script_tabular）
# ----------------------------------------------------------------------------

# 一张「够用的最小分镜表」：表头在第 4 行（上面是模块一那种纵向块），起始列 A。
TABLE_HEADER = ["分镜", "分镜标题", "口播", "字幕", "上屏文字", "卡片样式"]
TABLE_ROWS = [
    ["模块一：封面文案部分"],
    ["视频标题", "食品码垛工位观察"],
    ["模块二：视频分镜脚本（2 段）"],
    list(TABLE_HEADER),
    ["1", "来料到位是第一道关", "袋装物料码垛，先看来料怎样到位。",
     "先看来料到位", "来料到位是码垛稳定的第一道关", "（不填）"],
    ["2", "袋料和箱体要分开核对", "袋料和箱体的外形不同。",
     "袋料与箱体分别核对", "（不填）", "（不填）"],
]


class TableWorkbookMixin:
    def workbook(self, rows, *, name="s.xlsx", sheets=None, merges=None, shared=True,
                 hidden_columns=None, hidden_rows=None) -> Path:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / name
        write_xlsx(path, sheets or [("视频脚本", rows)], merges=merges, shared=shared,
                   hidden_columns=hidden_columns, hidden_rows=hidden_rows)
        return path

    def blocks_of(self, rows, **kwargs):
        blocks, status, info = scf.collect_blocks(self.workbook(rows, **kwargs))
        return blocks, status, info


class TabularReaderTests(unittest.TestCase, TableWorkbookMixin, TempScriptMixin):
    def test_shared_strings_and_inline_strings_read_the_same(self):
        shared = script_tabular.read_workbook(self.workbook(TABLE_ROWS, shared=True))
        inline = script_tabular.read_workbook(self.workbook(TABLE_ROWS, shared=False,
                                                            name="t.xlsx"))
        self.assertEqual(shared, inline)
        self.assertEqual(shared[0][0], "视频脚本")

    def test_sparse_rows_stay_aligned_by_column_index(self):
        rows = [["A", "B", "C"], [None, None, "只有第三列"]]
        grid = script_tabular.read_workbook(self.workbook(rows))[0][1]
        self.assertEqual(grid[1], ["", "", "只有第三列"])

    def test_row_merged_cells_are_spread_over_the_whole_range(self):
        rows = [["分镜", "口播", "上屏文字"],
                ["1", "第一句。", "同一张卡"],
                [None, "第二句。", None]]
        path = self.workbook(rows, merges={"视频脚本": ["A2:A3", "C2:C3"]})
        grid = script_tabular.read_workbook(path)[0][1]
        self.assertEqual(grid[2][0], "1")
        self.assertEqual(grid[2][2], "同一张卡")

    def test_line_breaks_inside_one_cell_survive_and_then_fold(self):
        rows = [["时间轴", "口播"], ["0:00-0:05\n钩子", "第一句。"]]
        grid = script_tabular.read_workbook(self.workbook(rows))[0][1]
        self.assertEqual(grid[1][0], "0:00-0:05\n钩子")
        # 比对前按 normalize_script 的口径折成一个空格
        self.assertEqual(scf.collapse(grid[1][0]), "0:00-0:05 钩子")

    def test_every_sheet_is_returned_in_workbook_order(self):
        path = self.workbook(None, sheets=[("中文版", TABLE_ROWS), ("英文版", [["x"]])])
        self.assertEqual([name for name, _grid in script_tabular.read_workbook(path)],
                         ["中文版", "英文版"])

    def test_a_file_that_is_not_a_zip_reads_as_nothing(self):
        fake = self.write_script("这不是 xlsx", name="fake.xlsx")
        self.assertIsNone(script_tabular.read_workbook(fake))

    def test_sheet_names_stay_aligned_when_a_sheet_part_is_missing(self):
        """对抗复审建议 1：`r:id` 指向的成员不在包里时，名字不能整体错位。"""
        path = self.workbook(None, sheets=[("中文版", TABLE_ROWS), ("英文版", TABLE_ROWS)])
        stripped = Path(str(path) + ".stripped.xlsx")
        self.addCleanup(lambda: stripped.unlink(missing_ok=True))
        with zipfile.ZipFile(path) as source, zipfile.ZipFile(stripped, "w") as target:
            for item in source.infolist():
                if item.filename != "xl/worksheets/sheet1.xml":
                    target.writestr(item, source.read(item.filename))
        self.assertEqual([name for name, _grid in script_tabular.read_workbook(stripped)],
                         ["英文版"])

    def test_too_many_sheets_is_a_zero_action_not_a_truncation(self):
        """第二次对抗复审应修 2：截断会把「恰好一个 sheet 像分镜表」那道闸门绕过去。"""
        shot_table = [["分镜", "口播", "上屏文字"],
                      ["1", "先看来料怎样到位。", "甲"],
                      ["2", "再看机械臂如何抓取。", "乙"]]
        sheets = [(f"杂表{index}", [["甲", "乙"], ["1", "2"]])
                  for index in range(script_tabular.MAX_SHEETS - 1)]
        sheets += [("中文版", shot_table), ("英文版", shot_table)]
        path = self.workbook(None, sheets=sheets)
        self.assertIsNone(script_tabular.read_workbook(path))
        self.assertEqual(script_tabular.sheet_count(path), script_tabular.MAX_SHEETS + 1)
        plan = sample_plan(s1={"card_content": "随便"})
        before = json.dumps(plan, ensure_ascii=False, sort_keys=True)
        report = scf.reconcile(plan, path)
        # 原因串要说得通：这份工作簿读得出来，是 sheet 太多我们主动放弃的
        self.assertEqual(report["status"], "skipped:sheets_limit")
        self.assertEqual(json.dumps(plan, ensure_ascii=False, sort_keys=True), before)
        _report, printed = capture(scf.verify_and_fix, plan, path)
        self.assertIn("sheet 太多", printed)
        printed.encode("gbk")

    def test_a_workbook_carrying_a_dtd_is_refused(self):
        """`xml.etree` 会展开内部实体（billion laughs），脚本里根本不该有 DTD。"""
        path = self.workbook(TABLE_ROWS)
        poisoned = Path(str(path) + ".dtd.xlsx")
        self.addCleanup(lambda: poisoned.unlink(missing_ok=True))
        with zipfile.ZipFile(path) as source, zipfile.ZipFile(poisoned, "w") as target:
            for item in source.infolist():
                payload = source.read(item.filename)
                if item.filename == "xl/worksheets/sheet1.xml":
                    payload = payload.replace(
                        b"<worksheet", b'<!DOCTYPE worksheet [<!ENTITY a "x">]><worksheet', 1)
                target.writestr(item.filename, payload)
        self.assertIsNone(script_tabular.read_workbook(poisoned))

    def test_column_letters_convert_past_z(self):
        self.assertEqual(script_tabular.column_index("A1"), 0)
        self.assertEqual(script_tabular.column_index("Z9"), 25)
        self.assertEqual(script_tabular.column_index("AA1"), 26)
        self.assertIsNone(script_tabular.column_index("1"))

    def test_csv_is_read_as_a_grid(self):
        path = self.write_script("分镜,口播,上屏文字\n1,第一句。,甲\n2,第二句。,乙\n", name="s.csv")
        self.assertEqual(script_tabular.read_csv_grid(path)[0], ["分镜", "口播", "上屏文字"])

    def test_docx_paragraphs_come_out_one_per_line(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / "s.docx"
        write_docx(path, ["分镜 1", "- 口播：袋装物料码垛，先看来料怎样到位。",
                          "- 上屏文字：来料到位是码垛稳定的第一道关"])
        self.assertEqual(script_tabular.read_docx_text(path).splitlines()[0], "分镜 1")


# ----------------------------------------------------------------------------
# 表格脚本：表头识别
# ----------------------------------------------------------------------------

class TableHeaderTests(unittest.TestCase, TableWorkbookMixin):
    def test_header_is_found_below_a_vertical_cover_copy_block(self):
        blocks, status, info = self.blocks_of(TABLE_ROWS)
        self.assertEqual(status, "ok")
        self.assertEqual(info["route"], "table")
        self.assertEqual(info["header_row"], 4)      # 不在第 1 行
        self.assertEqual(len(blocks), 2)

    def test_table_may_start_at_a_column_other_than_a(self):
        rows = [[None] + row for row in TABLE_ROWS]
        blocks, status, _info = self.blocks_of(rows)
        self.assertEqual(status, "ok")
        self.assertEqual(blocks[0]["card_content"]["value"], "来料到位是码垛稳定的第一道关")

    def test_column_names_are_matched_with_and_without_bracketed_notes(self):
        """括注变体仍能认出列（选表头、抽取都照旧），但**只有白名单原名**才进「确定」档：
        靠剥括注认出的关键列（口播 / 上屏文字 …）2026-09-23 起整份只告警。"""
        for header, certain in ((["镜号", "标题", "旁白", "上屏内容", "卡片版式"], True),
                                (["序号", "分镜标题", "口播文案（直接复用）", "上屏文字(没有就留空)",
                                  "卡片样式"], False),
                                (["No", "Title", "Voice", "On-screen text", "Card style"], True)):
            with self.subTest(header=header[0]):
                rows = [list(header),
                        ["1", "甲", "第一句话是这样说的。", "卡片甲", "标题卡"],
                        ["2", "乙", "第二句话是那样说的。", "卡片乙", "要点卡"]]
                parsed = scf.extract_table_card_fields(rows)
                self.assertEqual([block["card_content"]["value"] for block in parsed["blocks"]],
                                 ["卡片甲", "卡片乙"])
                self.assertEqual([block["card_hint"]["value"] for block in parsed["blocks"]],
                                 ["标题卡", "要点卡"])
                self.assertEqual([block["title"]["value"] for block in parsed["blocks"]], ["甲", "乙"])
                _blocks, status, info = self.blocks_of(rows)
                if certain:
                    self.assertEqual(status, "ok")
                else:
                    self.assertEqual(status, "skipped:uncertain")
                    self.assertEqual(len(info["uncertain"]), 2)     # 口播 + 上屏文字两列

    def test_lookalike_column_names_are_never_matched_by_substring(self):
        """「视频号标题 / 全片副标题 / 附属文案」都不是分镜字段，认错就会把对的改坏。"""
        for name in ("视频标题", "全片标题", "中文副标题", "视频号标题(16字无标点)",
                     "附属文案", "封面爆款文案", "标题党写法"):
            with self.subTest(name=name):
                self.assertIsNone(scf.column_role(name))
        self.assertEqual(scf.column_role("分镜标题"), "title")
        self.assertEqual(scf.column_role("标题"), "title")

    def test_a_generic_key_with_a_bracketed_qualifier_is_not_matched_either(self):
        """限定语写在**括号里**的那一类（对抗复审阻断 1）。

        列名比对前会去掉括注，于是 `标题（16字无标点）` 会缩成 `标题`——
        而「唯一能区分它和分镜标题的那个限定语」正好就是被扔掉的那部分。
        泛用键只认逐字相同的原列名。
        """
        for name in ("标题（16字无标点）", "标题(全片)", "文案（上屏）", "文案(封面爆款)",
                     "Title (video)", "素材（备选）", "画面（参考）", "时间（总）"):
            with self.subTest(name=name):
                self.assertIsNone(scf.column_role(name))
        # 真实生产脚本里那些「括注不改变含义」的变体一个都不许受影响
        self.assertEqual(scf.column_role("中文文案（直接复用）"), "voice_text")
        self.assertEqual(scf.column_role("中文文案（带标点断句）"), "voice_text")
        self.assertEqual(scf.column_role("素材搜索策略（中文）"), "visual")
        self.assertEqual(scf.column_role("素材搜索(英文)"), "visual")
        self.assertEqual(scf.column_role("上屏文字（没有就留空）"), "card_content")
        self.assertEqual(scf.column_role("分镜标题（中文）"), "title")

    def test_a_platform_title_column_cannot_rewrite_every_shot_title(self):
        """对抗复审阻断 1 的复现 A：全片标题列 + 纵向合并 -> 所有分镜标题被替换。"""
        rows = [["分镜", "标题（16字无标点）", "画面", "口播", "上屏文字"],
                ["1", "食品码垛工位观察", "输送带来料", "先看来料怎样到位。", "来料到位"],
                ["2", None, "机械臂抓取", "再看机械臂如何抓取。", "抓取落放"],
                ["3", None, "落到托盘", "最后看落盘排列。", "落盘核对"]]
        path = self.workbook(rows, merges={"视频脚本": ["B2:B4"]})
        plan = plan_with(
            {"shot": 1, "title": "来料到位", "voice_text": "先看来料怎样到位。",
             "card_content": "来料到位"},
            {"shot": 2, "title": "抓取落放", "voice_text": "再看机械臂如何抓取。",
             "card_content": "抓取落放"},
            {"shot": 3, "title": "落盘核对", "voice_text": "最后看落盘排列。",
             "card_content": "落盘核对"},
        )
        before = json.dumps(plan, ensure_ascii=False, sort_keys=True)
        report = scf.reconcile(plan, path)
        self.assertEqual(report["corrections"], [])
        self.assertEqual(json.dumps(plan, ensure_ascii=False, sort_keys=True), before)

    def test_an_on_screen_column_named_wencan_cannot_wipe_every_card(self):
        """对抗复审阻断 1 的复现 B：`文案（上屏）` 被当口播 -> 正确的卡片被整片清空。

        2026-09-23 起：表里一个上屏列都没认出来 -> 上屏两个字段一律冻结，绝不清空
        （表里还有分镜标题列，所以仍是「确定」档，只是上屏字段只告警）。
        """
        rows = [["分镜", "分镜标题", "画面", "口播", "文案（上屏）"],
                ["1", "甲", "输送带", "先看来料怎样到位。", "来料到位是第一道关"],
                ["2", "乙", "机械臂", "再看机械臂如何抓取。", "抓取要稳"]]
        plan = plan_with(
            {"shot": 1, "title": "甲", "voice_text": "先看来料怎样到位。",
             "card_content": "来料到位是第一道关"},
            {"shot": 2, "title": "乙", "voice_text": "再看机械臂如何抓取。",
             "card_content": "抓取要稳"},
        )
        before = json.dumps(plan, ensure_ascii=False, sort_keys=True)
        report = scf.reconcile(plan, self.workbook(rows))
        self.assertEqual(report["corrections"], [])
        self.assertEqual(json.dumps(plan, ensure_ascii=False, sort_keys=True), before)
        self.assertEqual(report["tier"], "certain")
        self.assertTrue(any("没有上屏文字列" in w and "不会因此清空" in w
                            for w in report["warnings"]))

    def test_the_cover_copy_block_does_not_steal_the_header_row(self):
        """对抗复审应修 1：封面块里也有「标题 / 文案 / 素材」，并列时要取靠后的那行。

        选表头仍取第 2 行；但这张表没有待校验字段、封面行本身又像带「标题」的表头，
        2026-09-23 起整份只告警（不是「确定」档）。
        """
        rows = [["标题", "x", "文案", "y", "素材", "z"],
                ["时间轴", "中文文案（直接复用）", "素材搜索策略（中文）"],
                ["0:00-0:07", "先看来料怎样到位。", "码垛 输送带"],
                ["0:07-0:15", "再看机械臂如何抓取。", "机械臂 抓取"]]
        parsed = scf.extract_table_card_fields(rows)
        self.assertEqual(parsed["header_row"], 2)
        self.assertEqual(len(parsed["blocks"]), 2)
        blocks, status, info = self.blocks_of(rows)
        self.assertIsNone(blocks)
        self.assertEqual(status, "skipped:uncertain")
        self.assertEqual(info["header_row"], 2)

    def test_a_trailing_copy_of_the_header_does_not_kill_the_real_table(self):
        """末尾逐字抄了一遍表头：表头仍认第 4 行（不被下方那行抢走、也不整表放弃），
        但 2026-09-23 第二次对抗复审阻断 B1 之后**逐字重复的表头也算第二张表** -> 只告警。
        （原先期望 `ok`；改严，理由见 `table_certainty_problems` 判据 3。）"""
        rows = list(TABLE_ROWS) + [[], list(TABLE_HEADER)]
        self.assertEqual(scf.extract_table_card_fields(rows)["header_row"], 4)
        self.assertEqual(len(scf.extract_table_card_fields(rows)["blocks"]), 2)
        blocks, status, info = self.blocks_of(rows)
        self.assertIsNone(blocks)
        self.assertEqual(status, "skipped:uncertain")
        self.assertEqual(info["header_row"], 4)
        self.assertTrue(any("第 8 行" in problem for problem in info["uncertain"]))

    def test_a_trailing_header_that_is_not_a_verbatim_copy_is_warn_only(self):
        """末尾那行多了一列（不是逐字重复）：选表头仍是第 4 行，但工作簿里有第二行
        带上屏/标题列的表头，拿不准 -> 2026-09-23 起整份只告警。"""
        rows = list(TABLE_ROWS) + [[], ["分镜", "分镜标题", "口播", "字幕", "上屏文字", "卡片样式",
                                        "画面"]]
        self.assertEqual(scf.extract_table_card_fields(rows)["header_row"], 4)
        blocks, status, info = self.blocks_of(rows)
        self.assertIsNone(blocks)
        self.assertEqual(status, "skipped:uncertain")
        self.assertTrue(any("第 8 行" in problem for problem in info["uncertain"]))

    def test_a_second_small_table_below_does_not_steal_the_header(self):
        """第二次对抗复审阻断：靠「同分取靠后」选表头会被下方小表抢走 -> 全片标题被覆盖。

        现在靠**角色密度**分辨（下方那行 3/3、封面块那种 3/6），同分再按行号升序。
        """
        rows = [["分镜", "口播", "上屏文字"],
                ["1", "先看来料怎样到位。", "来料到位"],
                ["2", "再看机械臂如何抓取。", "抓取落放"],
                [None, None, None],
                ["标题", "文案", "素材"],
                ["食品码垛工位观察", "先看来料怎样到位。", "码垛 输送带"],
                ["机械臂抓取要稳", "再看机械臂如何抓取。", "机械臂 抓取"]]
        plan = plan_with(
            {"shot": 1, "title": "来料到位", "voice_text": "先看来料怎样到位。",
             "card_content": "来料到位"},
            {"shot": 2, "title": "抓取落放", "voice_text": "再看机械臂如何抓取。",
             "card_content": "抓取落放"},
        )
        before = json.dumps(plan, ensure_ascii=False, sort_keys=True)
        path = self.workbook(rows)
        report = scf.reconcile(plan, path)
        self.assertEqual(report["corrections"], [])
        self.assertEqual(json.dumps(plan, ensure_ascii=False, sort_keys=True), before)
        _blocks, _status, info = scf.collect_blocks(path)
        self.assertEqual(info["header_row"], 1)

    def test_a_lower_table_with_more_roles_does_not_steal_the_header(self):
        """第四次复审应修 1：下方表角色更多，也不能反超上方真正的分镜表。"""
        rows = [["分镜", "口播", "上屏文字"],
                ["1", "先看来料怎样到位。", "来料到位"],
                ["2", "再看机械臂如何抓取。", "抓取落放"],
                [None, None, None, None],
                ["镜号", "分镜标题", "口播", "画面"],
                ["1", "平台标题一", "先看来料怎样到位。", "码垛 输送带"],
                ["2", "平台标题二", "再看机械臂如何抓取。", "机械臂 抓取"]]
        plan = plan_with(
            {"shot": 1, "title": "来料到位", "voice_text": "先看来料怎样到位。",
             "card_content": "来料到位"},
            {"shot": 2, "title": "抓取落放", "voice_text": "再看机械臂如何抓取。",
             "card_content": "抓取落放"},
        )
        before = json.dumps(plan, ensure_ascii=False, sort_keys=True)
        path = self.workbook(rows)
        report = scf.reconcile(plan, path)
        self.assertEqual(report["corrections"], [])
        self.assertEqual(json.dumps(plan, ensure_ascii=False, sort_keys=True), before)
        blocks, status, _info = scf.collect_blocks(path)
        self.assertIsNone(blocks)
        self.assertEqual(status, "skipped:table")

    def test_a_failed_earlier_header_is_not_replaced_by_a_lower_table(self):
        """上方候选切不出分镜时宁可漏报，不让下方另一张表接管。"""
        rows = [["口播", "分镜", "上屏文字"],
                [None, None, None],
                ["镜号", "分镜标题", "口播", "画面"],
                ["1", "平台标题一", "先看来料怎样到位。", "码垛 输送带"],
                ["2", "平台标题二", "再看机械臂如何抓取。", "机械臂 抓取"]]
        blocks, status, _info = self.blocks_of(rows)
        self.assertIsNone(blocks)
        self.assertEqual(status, "skipped:table")

    def test_a_real_header_with_a_remarks_column_still_wins(self):
        """第三轮对抗复审阻断：真表头多一个 `备注` 列密度就掉到 0.75，
        下面那张干净的 `标题|文案|素材` 小表以 1.0 反超 —— 整片标题改写那条路原样回来。

        所以密度**只当准入闸门**（否决封面块那一类），排名一律行号升序：
        「表头永远在它自己的数据区之上」是结构事实，位置和形状分都是能被构造的。
        """
        for tail in (["备注"], ["备注", "填写人"], ["本表说明"]):
            with self.subTest(tail=tail):
                rows = [["分镜", "口播", "上屏文字"] + tail,
                        ["1", "先看来料怎样到位。", "来料到位"],
                        ["2", "再看机械臂如何抓取。", "抓取落放"],
                        [None, None, None],
                        ["标题", "文案", "素材"],
                        ["食品码垛工位观察", "先看来料怎样到位。", "码垛 输送带"],
                        ["机械臂抓取要稳", "再看机械臂如何抓取。", "机械臂 抓取"]]
                plan = plan_with(
                    {"shot": 1, "title": "来料到位", "voice_text": "先看来料怎样到位。",
                     "card_content": "来料到位"},
                    {"shot": 2, "title": "抓取落放", "voice_text": "再看机械臂如何抓取。",
                     "card_content": "抓取落放"},
                )
                before = json.dumps(plan, ensure_ascii=False, sort_keys=True)
                path = self.workbook(rows)
                _blocks, _status, info = scf.collect_blocks(path)
                self.assertEqual(info["header_row"], 1)
                report = scf.reconcile(plan, path)
                self.assertEqual(report["corrections"], [])
                self.assertEqual(json.dumps(plan, ensure_ascii=False, sort_keys=True), before)

    def test_a_row_where_half_the_cells_are_values_is_not_a_header(self):
        """密度闸门：封面块那种 `标题|x|文案|y|素材|z` 是 3/6 = 0.5，挡掉，选不上表头。

        但它同一行里有「标题」+ 另两个列名，2026-09-23 起算「别处还有一行像表头」，
        整份只告警（宁可漏改）。
        """
        self.assertLess(0.5, scf.MIN_HEADER_DENSITY)
        rows = [["标题", "食品码垛工位观察", "文案", "先看来料", "素材", "码垛"],
                ["分镜", "口播", "上屏文字", "备注"],
                ["1", "先看来料怎样到位。", "甲", None],
                ["2", "再看机械臂如何抓取。", "乙", None]]
        parsed = scf.extract_table_card_fields(rows)
        self.assertEqual(parsed["header_row"], 2)
        self.assertEqual([block["card_content"]["value"] for block in parsed["blocks"]], ["甲", "乙"])
        blocks, status, _info = self.blocks_of(rows)
        self.assertIsNone(blocks)
        self.assertEqual(status, "skipped:uncertain")

    def test_a_note_that_contradicts_the_role_disables_the_column(self):
        """第二次对抗复审应修 1：`中文文案（上屏）` 不是口播，认成口播会清掉作者的卡片。

        冲突词**只给口播 / 字幕两个角色**：`标题` / `title` 本来就被 `GENERIC_KEYS` 挡在
        第一关，能走到第二遍的只剩 `分镜标题` / `镜头标题`——那些本来就是分镜标题列，
        再加冲突词只会把 `分镜标题（视频用）` 这类真列误伤掉（第三轮复审建议 1、2）。
        """
        for name in ("中文文案（上屏）", "英文文案（上屏文字）", "字幕（上屏）",
                     "中文文案（做成卡片）", "字幕（花字）", "标题（封面）", "Title (video)"):
            with self.subTest(name=name):
                self.assertIsNone(scf.column_role(name))
        # 括注不改变含义的一个都不许受影响
        for name, role in (("中文文案（直接复用）", "voice_text"),
                           ("中文文案（带标点断句）", "voice_text"),
                           ("口播（配合标题卡）", "voice_text"),
                           ("素材搜索策略（中文）", "visual"),
                           ("上屏文字（没有就留空）", "card_content"),
                           ("上屏文字（卡片正文）", "card_content"),
                           ("卡片样式（不填就不上卡）", "card_hint"),
                           ("分镜标题（中文）", "title"),
                           ("分镜标题（视频用）", "title"),
                           ("镜头标题（平台）", "title"),
                           ("序号（镜）", "shot_no"),
                           ("编号（镜头）", "shot_no")):
            with self.subTest(name=name):
                self.assertEqual(scf.column_role(name), role)

    def test_a_whole_video_title_note_disables_the_column(self):
        """第四次复审应修 2：全片/整片限定语不能被认成逐镜 title。"""
        self.assertIsNone(scf.column_role("分镜标题（全片通用）"))
        self.assertIsNone(scf.column_role("镜头标题（整片复用）"))
        self.assertEqual(scf.column_role("分镜标题（视频用）"), "title")
        self.assertEqual(scf.column_role("分镜标题（中文）"), "title")

    def test_a_merged_whole_video_title_cannot_overwrite_every_shot_title(self):
        rows = [["分镜", "分镜标题（全片通用）", "口播", "上屏文字"],
                ["1", "食品码垛工位观察", "先看来料怎样到位。", "来料到位"],
                ["2", None, "再看机械臂如何抓取。", "抓取落放"]]
        path = self.workbook(rows, merges={"视频脚本": ["B2:B3"]})
        plan = plan_with(
            {"shot": 1, "title": "来料到位", "voice_text": "先看来料怎样到位。",
             "card_content": "来料到位"},
            {"shot": 2, "title": "抓取落放", "voice_text": "再看机械臂如何抓取。",
             "card_content": "抓取落放"},
        )
        before = json.dumps(plan, ensure_ascii=False, sort_keys=True)
        report = scf.reconcile(plan, path)
        self.assertEqual(report["corrections"], [])
        self.assertEqual(json.dumps(plan, ensure_ascii=False, sort_keys=True), before)

    def test_a_table_without_a_shot_number_column_needs_three_recognised_columns(self):
        """没有分镜号列时只剩「块数 + 锚点」两道闸门，入口门槛抬到 3 个角色。"""
        two = [["口播", "画面"], ["先看来料怎样到位。", "输送带"], ["再看机械臂如何抓取。", "机械臂"]]
        self.assertEqual(self.blocks_of(two)[1], "skipped:table")
        three = [["分镜标题", "口播", "画面"],
                 ["甲", "先看来料怎样到位。", "输送带"],
                 ["乙", "再看机械臂如何抓取。", "机械臂"]]
        self.assertEqual(self.blocks_of(three)[1], "ok")

    def test_a_table_without_recognisable_columns_is_a_zero_action(self):
        rows = [["甲列", "乙列", "丙列"], ["1", "2", "3"]]
        blocks, status, _info = self.blocks_of(rows)
        self.assertIsNone(blocks)
        self.assertEqual(status, "skipped:table")

    def test_one_recognised_column_is_not_enough_to_be_a_header(self):
        rows = [["口播"], ["第一句。"], ["第二句。"]]
        _blocks, status, _info = self.blocks_of(rows)
        self.assertEqual(status, "skipped:table")

    def test_a_header_of_only_numbers_and_durations_is_not_a_shot_table(self):
        rows = [["序号", "时长"], ["1", "7"], ["2", "8"]]
        _blocks, status, _info = self.blocks_of(rows)
        self.assertEqual(status, "skipped:table")

    def test_two_sheets_that_both_look_like_shot_tables_are_a_zero_action(self):
        path = self.workbook(None, sheets=[("中文版", TABLE_ROWS), ("英文版", TABLE_ROWS)])
        plan = sample_plan()
        before = json.dumps(plan, ensure_ascii=False, sort_keys=True)
        report = scf.reconcile(plan, path)
        self.assertEqual(report["status"], "skipped:sheets")
        self.assertEqual(json.dumps(plan, ensure_ascii=False, sort_keys=True), before)
        self.assertTrue(any("不止一个 sheet" in w for w in report["warnings"]))

    def test_real_machine_tending_shape_prefers_the_field_sheet_over_narration_copy(self):
        """B7 真实结构：屏字/大字是正文，原创图层是提示；旁白副表不应挡住正表。"""
        header = ["拍", "时间码(入)", "时间码(出)", "时长s", "段落", "中文旁白",
                  "英文旁白", "屏字/大字", "画面(素材文件,相对资料包根目录)",
                  "取段", "原创图层", "处理要求", "事实编号", "备注"]
        rows = [header,
                ["1", "0:00", "0:05", "5", "钩子", "第一句\n旁白足够确认镜号。",
                 "The first narration anchors this shot.", "大字：第一张卡\n副行：说  明",
                 "素材/a.mp4", "t0-t5", "大字钩子（描边）", "模糊铭牌", "A1", ""],
                ["2", "0:05", "0:10", "5", "正文", "第二句旁白足够确认镜号。",
                 "The second narration anchors this shot.", "02 第二张卡\n流程甲 → 流程乙",
                 "素材/b.mp4", "t5-t10", "编号卡片 02；流程条", "", "A2", ""]]
        narration = [["拍", "中文旁白", "字数", "估时(s)", "英文旁白"],
                     ["1", "第一句 旁白足够确认镜号。", "13", "3", "The first narration anchors this shot."],
                     ["2", "第二句旁白足够确认镜号。", "13", "3", "The second narration anchors this shot."],
                     ["合计", "", "26", "6", ""]]
        path = self.workbook(None, sheets=[("分镜脚本", rows), ("旁白纯文本", narration)])
        # 独立 oracle 是 OOXML 读取层的原始单元格，不能拿 collect_blocks 派生值自证。
        raw_cells = [row[7] for row in script_tabular.read_workbook(path)[0][1][1:]]
        self.assertEqual(raw_cells, ["大字：第一张卡\n副行：说  明", "02 第二张卡\n流程甲 → 流程乙"])
        # 2026-09-23：行首版式标签「大字：/副行：」是写给制作的，不上屏；其余字符逐字保留。
        raw_cards = ["第一张卡\n说  明", "02 第二张卡\n流程甲 → 流程乙"]
        blocks, status, info = scf.collect_blocks(path)
        self.assertEqual(status, "ok")
        self.assertEqual(info["sheets"], ["分镜脚本"])
        self.assertEqual(info["header_row"], 1)
        self.assertEqual(info["ambiguous"], [])
        self.assertEqual(
            info["roles"],
            ["card_content", "card_hint", "duration", "shot_no", "time_range", "visual", "voice_text"],
        )
        self.assertEqual([block["card_content"]["value"] for block in blocks],
                         raw_cards)
        self.assertEqual([block["card_hint"]["value"] for block in blocks],
                         ["大字钩子（描边）", "编号卡片 02；流程条"])

        self.assertEqual(scf.reconcile(plan_with(
            {"shot": 1, "voice_text": "第一句 旁白足够确认镜号。", "card_content": raw_cells[0],
             "card_hint": "大字钩子（描边）"},
            {"shot": 2, "voice_text": "第二句旁白足够确认镜号。", "card_content": raw_cells[1],
             "card_hint": "编号卡片 02；流程条"}), path, autofix=False)["corrections"][0]["script"],
            raw_cards[0])                                   # 模型照抄了标签 -> 按剥标签后的原文纠正

        # 同内容若把 LF 变空格、双空格压成单空格，也必须报告；只报告模式不得改 plan。
        spacing_damaged = plan_with(
            {"shot": 1, "title": "模型标题一", "voice_text": "第一句 旁白足够确认镜号。",
             "card_content": raw_cards[0].replace("\n", " ").replace("  ", " "),
             "card_hint": "大字钩子（描边）"},
            {"shot": 2, "title": "模型标题二", "voice_text": "第二句旁白足够确认镜号。",
             "card_content": raw_cards[1].replace("\n", " "),
             "card_hint": "编号卡片 02；流程条"},
        )
        before = json.dumps(spacing_damaged, ensure_ascii=False, sort_keys=True)
        advisory = scf.reconcile(spacing_damaged, path, autofix=False)
        self.assertEqual([(c["shot"], c["field"], c["applied"])
                          for c in advisory["corrections"]],
                         [(1, "card_content", False), (2, "card_content", False)])
        self.assertEqual(json.dumps(spacing_damaged, ensure_ascii=False, sort_keys=True), before)

        plan = plan_with(
            {"shot": 1, "title": "模型标题一", "voice_text": "第一句 旁白足够确认镜号。",
             "card_content": "模型改写一", "card_hint": "model hint one"},
            {"shot": 2, "title": "模型标题二", "voice_text": "第二句旁白足够确认镜号。",
             "card_content": "模型改写二", "card_hint": "model hint two"},
        )
        report = scf.reconcile(plan, path)
        self.assertEqual(report["checked"], 2)
        self.assertEqual([(item["shot"], item["field"], item["kind"])
                          for item in report["corrections"]],
                         [(1, "card_content", "rewritten"), (1, "card_hint", "rewritten"),
                          (2, "card_content", "rewritten"), (2, "card_hint", "rewritten")])
        self.assertEqual([shot["title"] for shot in plan["shots"]], ["模型标题一", "模型标题二"])
        self.assertEqual([shot["card_content"] for shot in plan["shots"]],
                         raw_cards)
        self.assertEqual([shot["card_hint"] for shot in plan["shots"]],
                         ["大字钩子（描边）", "编号卡片 02；流程条"])

        # 已经逐字保留 LF/双空格的 plan 不应产生 correction。
        exact = plan_with(
            {"shot": 1, "title": "模型标题一", "voice_text": "第一句 旁白足够确认镜号。",
             "card_content": raw_cards[0], "card_hint": "大字钩子（描边）"},
            {"shot": 2, "title": "模型标题二", "voice_text": "第二句旁白足够确认镜号。",
             "card_content": raw_cards[1], "card_hint": "编号卡片 02；流程条"},
        )
        before = json.loads(json.dumps(exact, ensure_ascii=False))
        self.assertEqual(scf.reconcile(exact, path)["corrections"], [])
        # 2026-09-23 版式功能：文字一个不动，只多了一个由脚本标签得出的 `card_layout`
        # （第 1 镜「大字：/副行：」-> 大字+小字；第 2 镜没写标签 -> 不带）。
        before["shots"][0]["card_layout"] = "headline_sub"
        self.assertEqual(exact, before)

        # 2026-09-23：CRLF / CR 与 LF 是同一个换行（Excel 的 `_x000D_\n` 解码后就是 CRLF），
        # 不算改写；plan 侧的 CRLF 由 `normalize_script.compact_plan` 统一成 LF。
        crlf = json.loads(json.dumps(exact, ensure_ascii=False))
        crlf["shots"][1]["card_content"] = raw_cards[1].replace("\n", "\r\n")
        self.assertEqual(scf.reconcile(crlf, path)["corrections"], [])

    def test_a_later_target_sheet_with_copied_voice_cannot_replace_the_first_shot_table(self):
        """跨 sheet 对抗：不能按“有待校验字段”让后面的平台表反超主表。"""
        narration = [["拍", "时间码", "中文旁白", "画面"],
                     ["1", "0:00-0:05", "第一句旁白足够确认镜号。", "素材一"],
                     ["2", "0:05-0:10", "第二句旁白足够确认镜号。", "素材二"]]
        platform = [["拍", "时间码", "中文旁白", "画面", "标题", "上屏文字"],
                    ["1", "0:00-0:05", "第一句旁白足够确认镜号。", "素材一",
                     "平台标题一", "平台卡片一"],
                    ["2", "0:05-0:10", "第二句旁白足够确认镜号。", "素材二",
                     "平台标题二", "平台卡片二"]]
        path = self.workbook(None, sheets=[("分镜脚本", narration), ("平台发布", platform)])
        plan = plan_with(
            {"shot": 1, "title": "原标题一", "voice_text": "第一句旁白足够确认镜号。",
             "card_content": "原卡片一"},
            {"shot": 2, "title": "原标题二", "voice_text": "第二句旁白足够确认镜号。",
             "card_content": "原卡片二"},
        )
        before = json.dumps(plan, ensure_ascii=False, sort_keys=True)
        report = scf.reconcile(plan, path)
        self.assertEqual(report["status"], "skipped:sheets")
        self.assertEqual(report["corrections"], [])
        self.assertEqual(json.dumps(plan, ensure_ascii=False, sort_keys=True), before)

    def test_two_differently_laid_out_card_values_in_one_shot_are_advisory(self):
        rows = [["拍", "中文旁白", "屏字/大字"],
                ["1", "第一句旁白足够确认镜号。", "甲 乙"],
                ["", "", "甲\n乙"],
                ["2", "第二句旁白足够确认镜号。", "丙"]]
        path = self.workbook(rows)
        blocks, status, _info = scf.collect_blocks(path)
        self.assertEqual(status, "ok")
        self.assertFalse(blocks[0]["card_content"]["reliable"])

        plan = plan_with(
            {"shot": 1, "title": "原标题一", "voice_text": "第一句旁白足够确认镜号。",
             "card_content": "保留模型结果"},
            {"shot": 2, "title": "原标题二", "voice_text": "第二句旁白足够确认镜号。",
             "card_content": "丙"},
        )
        report = scf.reconcile(plan, path)
        self.assertEqual(plan["shots"][0]["card_content"], "保留模型结果")
        self.assertEqual(report["corrections"], [])
        self.assertTrue(any("写法不唯一" in warning for warning in report["warnings"]))

    def test_text_route_keeps_its_existing_whitespace_collapse(self):
        text = SAMPLE.replace("来料到位是码垛稳定的第一道关", "来料  \t到位是码垛稳定的第一道关")
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / "script.md"
        path.write_text(text, encoding="utf-8")
        plan = sample_plan(s1={"card_content": "来料 到位是码垛稳定的第一道关"})
        before = json.dumps(plan, ensure_ascii=False, sort_keys=True)
        report = scf.reconcile(plan, path)
        self.assertEqual(report["route"], "text")
        self.assertEqual(report["corrections"], [])
        self.assertEqual(json.dumps(plan, ensure_ascii=False, sort_keys=True), before)

    def test_a_narration_sheet_that_only_looks_equal_after_markup_stripping_is_not_ignored(self):
        primary = [["拍", "中文旁白", "屏字/大字"],
                   ["1", "第一句旁白足够确认镜号。", "卡片一"],
                   ["2", "第二句旁白足够确认镜号。", "卡片二"]]
        quoted_copy = [["拍", "中文旁白"],
                       ["1", "**第一句旁白足够确认镜号。**"],
                       ["2", "第二句旁白足够确认镜号。"]]
        path = self.workbook(None, sheets=[("分镜脚本", primary), ("旁白纯文本", quoted_copy)])
        plan = plan_with(
            {"shot": 1, "title": "原标题一", "voice_text": "第一句旁白足够确认镜号。",
             "card_content": "原卡片一"},
            {"shot": 2, "title": "原标题二", "voice_text": "第二句旁白足够确认镜号。",
             "card_content": "原卡片二"},
        )
        before = json.dumps(plan, ensure_ascii=False, sort_keys=True)
        report = scf.reconcile(plan, path)
        self.assertEqual(report["status"], "skipped:sheets")
        self.assertEqual(report["corrections"], [])
        self.assertEqual(json.dumps(plan, ensure_ascii=False, sort_keys=True), before)

    def test_an_empty_second_sheet_does_not_block_the_real_one(self):
        path = self.workbook(None, sheets=[("视频脚本", TABLE_ROWS), ("说明", [["备注"], ["随便"]])])
        blocks, status, _info = scf.collect_blocks(path)
        self.assertEqual(status, "ok")
        self.assertEqual(len(blocks), 2)

    def test_two_columns_for_one_field_make_that_field_advisory_only(self):
        """中英双语表：同一字段两列，谁也不能当准。

        带括注的写法（`上屏文字（中文）` / `（英文）`）是剥括注才认出来的，
        2026-09-23 起整份只告警；两列都用白名单原名时走「该字段只告警」那条老路。
        """
        for header, status in ((["分镜", "口播", "上屏文字（中文）", "上屏文字（英文）"],
                                "skipped:uncertain"),
                               (["分镜", "口播", "上屏文字", "上屏内容"], "ok")):
            with self.subTest(header=header[2]):
                rows = [header,
                        ["1", "袋装物料码垛，先看来料怎样到位。", "来料到位", "Incoming first"],
                        ["2", "袋料和箱体的外形不同。", "分开核对", "Check separately"]]
                plan = sample_plan(s1={"card_content": "模型自己改写的一句"})
                report = scf.reconcile(plan, self.workbook(rows))
                self.assertEqual(report["status"], status)
                self.assertEqual(report["corrections"], [])
                self.assertEqual(plan["shots"][0]["card_content"], "模型自己改写的一句")
                if status == "ok":
                    self.assertTrue(any("不止一列" in w for w in report["warnings"]))


# ----------------------------------------------------------------------------
# 表格脚本：分组（哪些行是一镜）
# ----------------------------------------------------------------------------

class TableGroupingTests(unittest.TestCase, TableWorkbookMixin):
    def test_a_shot_spanning_several_rows_via_a_merged_number_stays_one_shot(self):
        rows = [["分镜", "口播", "上屏文字"],
                ["1", "袋装物料码垛，先看来料怎样到位。", "来料到位是码垛稳定的第一道关"],
                [None, "补一句画面说明。", None],
                ["2", "袋料和箱体的外形不同。", None]]
        path = self.workbook(rows, merges={"视频脚本": ["A2:A3", "C2:C3"]})
        blocks, status, _info = scf.collect_blocks(path)
        self.assertEqual(status, "ok")
        self.assertEqual(len(blocks), 2)
        # 合并的上屏文字摊到两行后仍是同一个值 -> 唯一 -> 可靠
        self.assertTrue(blocks[0]["card_content"]["reliable"])
        self.assertEqual(blocks[0]["card_content"]["value"], "来料到位是码垛稳定的第一道关")

    def test_a_shot_whose_rows_give_two_different_values_is_advisory_only(self):
        rows = [["分镜", "口播", "上屏文字"],
                ["1", "袋装物料码垛，先看来料怎样到位。", "上半句"],
                [None, None, "下半句"],
                ["2", "袋料和箱体的外形不同。", None]]
        blocks, _status, _info = self.blocks_of(rows)
        self.assertEqual(len(blocks), 2)
        self.assertFalse(blocks[0]["card_content"]["reliable"])

    def test_a_row_holding_two_shot_numbers_makes_that_shot_advisory_only(self):
        rows = [["分镜", "口播", "上屏文字"],
                ["1", "袋装物料码垛，先看来料怎样到位。", "甲"],
                ["2-3", "两镜写在一行里。", "乙"],
                ["2", "袋料和箱体的外形不同。", "丙"]]
        blocks, _status, _info = self.blocks_of(rows)
        self.assertEqual(len(blocks), 2)
        self.assertFalse(blocks[0]["card_content"]["reliable"])

    def test_an_unreadable_shot_number_makes_the_whole_group_doubtful(self):
        """对抗复审建议 2：`1-2` 那一行在上屏列上是空的，值仍然唯一——不能只靠「不唯一」。"""
        rows = [["分镜", "口播", "上屏文字"],
                ["1", "先看来料怎样到位。", "甲"],
                ["1-2", "两镜写在一行里。", None],
                ["2", "再看机械臂如何抓取。", "乙"]]
        blocks, status, _info = self.blocks_of(rows)
        self.assertEqual(status, "ok")
        self.assertEqual(len(blocks), 2)
        self.assertEqual(blocks[0]["card_content"]["value"], "甲")
        self.assertFalse(blocks[0]["card_content"]["reliable"])
        self.assertTrue(blocks[1]["card_content"]["reliable"])

    def test_columns_that_are_not_validated_still_protect_a_correct_plan(self):
        """对抗复审建议 4：画面 / 时长这类列的值也要算进「表外值」，与纯文本路一致。"""
        rows = [["分镜", "口播", "画面"],
                ["1", "先看来料怎样到位。", "来料到位是第一道关"],
                ["2", "再看机械臂如何抓取。", "抓取要稳"]]
        plan = plan_with(
            {"shot": 1, "title": "甲", "voice_text": "先看来料怎样到位。",
             "card_hint": "来料到位是第一道关"},
            {"shot": 2, "title": "乙", "voice_text": "再看机械臂如何抓取。"},
        )
        report = scf.reconcile(plan, self.workbook(rows))
        self.assertEqual(report["corrections"], [])
        self.assertEqual(plan["shots"][0]["card_hint"], "来料到位是第一道关")

    def test_blank_rows_are_skipped(self):
        rows = [["分镜", "口播", "上屏文字"],
                ["1", "袋装物料码垛，先看来料怎样到位。", "甲"],
                [None, None, None],
                ["2", "袋料和箱体的外形不同。", "乙"]]
        blocks, _status, _info = self.blocks_of(rows)
        self.assertEqual([block["card_content"]["value"] for block in blocks], ["甲", "乙"])

    def test_a_note_row_after_the_last_shot_does_not_become_a_shot(self):
        rows = [["分镜", "口播", "上屏文字"],
                ["1", "袋装物料码垛，先看来料怎样到位。", "甲"],
                ["2", "袋料和箱体的外形不同。", "乙"],
                ["小计", None, None]]
        blocks, _status, _info = self.blocks_of(rows)
        self.assertEqual(len(blocks), 2)

    def test_a_note_row_with_content_poisons_only_the_shot_it_follows(self):
        rows = [["分镜", "口播", "上屏文字"],
                ["1", "袋装物料码垛，先看来料怎样到位。", "甲"],
                ["2", "袋料和箱体的外形不同。", "乙"],
                ["说明", "以上时长为估算，实际以剪辑为准。", "示例：这里写上屏文字"]]
        blocks, _status, _info = self.blocks_of(rows)
        self.assertEqual(len(blocks), 2)
        self.assertTrue(blocks[0]["card_content"]["reliable"])
        self.assertFalse(blocks[1]["card_content"]["reliable"])

    def test_shot_numbers_that_are_not_strictly_one_to_n_are_a_zero_action(self):
        for numbers in (["1", "3"], ["2", "1"], ["1", "1"], ["0", "1"]):
            with self.subTest(numbers=numbers):
                rows = [["分镜", "口播", "上屏文字"],
                        [numbers[0], "袋装物料码垛，先看来料怎样到位。", "甲"],
                        [numbers[1], "袋料和箱体的外形不同。", "乙"]]
                _blocks, status, _info = self.blocks_of(rows)
                self.assertIn(status, {"skipped:table", "ok"})
                if status == "ok":
                    # `1,1` 是合并单元格的合法形状，会并成一镜而不是错位
                    blocks, _s, _i = self.blocks_of(rows)
                    self.assertEqual(len(blocks), 1)

    def test_shot_numbers_may_be_written_with_decorations(self):
        rows = [["镜号", "口播", "上屏文字"],
                ["第1镜", "袋装物料码垛，先看来料怎样到位。", "甲"],
                ["2.0", "袋料和箱体的外形不同。", "乙"]]
        blocks, status, _info = self.blocks_of(rows)
        self.assertEqual(status, "ok")
        self.assertEqual(len(blocks), 2)

    def test_a_table_without_a_shot_number_column_uses_one_row_per_shot(self):
        rows = [["分镜标题", "口播", "上屏文字"],
                ["来料到位是第一道关", "袋装物料码垛，先看来料怎样到位。", "甲"],
                ["袋料和箱体要分开核对", "袋料和箱体的外形不同。", "乙"]]
        blocks, status, _info = self.blocks_of(rows)
        self.assertEqual(status, "ok")
        self.assertEqual([block["card_content"]["value"] for block in blocks], ["甲", "乙"])

    def test_a_repeated_header_row_is_not_taken_for_a_shot(self):
        """重复的表头行不会被当成一镜（分组仍是 2 镜）；2026-09-23 第二次对抗复审起
        逐字重复表头整份只告警（原先期望 `ok`，改严，见判据 3）。"""
        rows = [list(TABLE_HEADER), list(TABLE_HEADER)] + TABLE_ROWS[4:]
        self.assertEqual(len(scf.extract_table_card_fields(rows)["blocks"]), 2)
        blocks, status, _info = self.blocks_of(rows)
        self.assertIsNone(blocks)
        self.assertEqual(status, "skipped:uncertain")


# ----------------------------------------------------------------------------
# 表格脚本：比对与纠正
# ----------------------------------------------------------------------------

class TableReconcileTests(unittest.TestCase, TableWorkbookMixin):
    def test_the_same_three_kinds_are_caught_through_a_workbook(self):
        plan = sample_plan(s1={"card_hint": "on-screen text display"},
                           s2={"card_content": "解析器凭空造的一句"})
        report = scf.reconcile(plan, self.workbook(TABLE_ROWS))
        self.assertEqual(report["route"], "table")
        self.assertEqual([(c["shot"], c["field"], c["kind"]) for c in report["corrections"]],
                         [(1, "card_content", "missing"), (1, "card_hint", "invented"),
                          (2, "card_content", "invented")])
        self.assertEqual(plan["shots"][0]["card_content"], "来料到位是码垛稳定的第一道关")
        self.assertNotIn("card_hint", plan["shots"][0])
        self.assertNotIn("card_content", plan["shots"][1])

    def test_placeholder_cells_count_as_not_written(self):
        for placeholder in ("（不填）", "无", "N/A", "—", "/"):
            with self.subTest(value=placeholder):
                rows = [["分镜", "口播", "卡片样式"],
                        ["1", "袋装物料码垛，先看来料怎样到位。", placeholder],
                        ["2", "袋料和箱体的外形不同。", placeholder]]
                plan = sample_plan(s1={"card_hint": "模型造的样式"})
                report = scf.reconcile(plan, self.workbook(rows))
                self.assertEqual([c["kind"] for c in report["corrections"]], ["invented"])
                self.assertNotIn("card_hint", plan["shots"][0])

    def test_shot_count_mismatch_only_warns(self):
        plan = plan_with(SAMPLE_SHOTS[0])
        report = scf.reconcile(plan, self.workbook(TABLE_ROWS))
        self.assertEqual(report["status"], "skipped:shot_count")
        self.assertEqual(report["corrections"], [])
        self.assertNotIn("card_content", plan["shots"][0])

    def test_rows_in_a_different_order_than_the_plan_are_caught_by_the_anchors(self):
        rows = list(TABLE_ROWS[:4]) + [TABLE_ROWS[5], TABLE_ROWS[4]]
        rows[4] = ["1"] + list(rows[4][1:])
        rows[5] = ["2"] + list(rows[5][1:])
        plan = sample_plan()
        report = scf.reconcile(plan, self.workbook(rows))
        self.assertEqual(report["corrections"], [])
        self.assertNotIn("card_content", plan["shots"][0])
        self.assertTrue(any("镜号可能错位" in w for w in report["warnings"]))

    def test_a_column_this_table_does_not_know_protects_a_correct_plan(self):
        rows = [["分镜", "口播", "上屏文字", "花字文案"],
                ["1", "袋装物料码垛，先看来料怎样到位。", None, "来料到位是码垛稳定的第一道关"],
                ["2", "袋料和箱体的外形不同。", None, None]]
        plan = sample_plan(s1={"card_content": "来料到位是码垛稳定的第一道关"})
        report = scf.reconcile(plan, self.workbook(rows))
        self.assertEqual(report["corrections"], [])
        self.assertEqual(plan["shots"][0]["card_content"], "来料到位是码垛稳定的第一道关")
        self.assertTrue(any("本表不认识的字段名" in w for w in report["warnings"]))

    def test_a_plain_table_without_card_columns_leaves_a_correct_plan_byte_identical(self):
        """真实生产脚本（时间轴 / 中文文案 / 素材搜索）就是这个形状，一个上屏列都没有。"""
        rows = [["时间轴", "中文文案", "英文文案", "素材搜索(中文)", "素材质量标准"],
                ["0:00-0:07\n钩子", "袋装物料码垛，先看来料怎样到位。",
                 "Bagged palletizing first.", "码垛 输送带", "分辨率≥1080P"],
                ["0:07-0:15\n问题深化", "袋料和箱体的外形不同。",
                 "Bags differ from cases.", "袋料 箱体", "分辨率≥1080P"]]
        plan = sample_plan()
        before = json.dumps(plan, ensure_ascii=False, sort_keys=True)
        report = scf.reconcile(plan, self.workbook(rows))
        self.assertEqual(report["status"], "skipped:uncertain")     # 没有可校验字段 -> 只告警
        self.assertEqual(report["corrections"], [])
        self.assertEqual(json.dumps(plan, ensure_ascii=False, sort_keys=True), before)
        self.assertTrue(any("没有上屏文字" in w for w in report["warnings"]))

    def test_the_fuse_only_freezes_the_card_fields_not_the_title(self):
        """保险丝只冻上屏两个字段——标题该纠正还得纠正。"""
        rows = [["分镜", "分镜标题", "口播", "画面"],
                ["1", "来料到位是第一道关", "先看来料怎样到位。", "输送带"],
                ["2", "袋料和箱体要分开核对", "再看机械臂如何抓取。", "机械臂"]]
        plan = plan_with(
            {"shot": 1, "title": "解析器改写过的甲", "voice_text": "先看来料怎样到位。",
             "card_content": "甲"},
            {"shot": 2, "title": "解析器改写过的乙", "voice_text": "再看机械臂如何抓取。",
             "card_content": "乙"},
        )
        report = scf.reconcile(plan, self.workbook(rows))
        self.assertEqual([(c["shot"], c["field"], c["kind"]) for c in report["corrections"]],
                         [(1, "title", "rewritten"), (2, "title", "rewritten")])
        self.assertEqual([shot["title"] for shot in plan["shots"]],
                         ["来料到位是第一道关", "袋料和箱体要分开核对"])
        self.assertEqual([shot["card_content"] for shot in plan["shots"]], ["甲", "乙"])

    def test_the_fuse_fires_at_one_third_not_only_past_a_half(self):
        """第二次对抗复审应修 3：4 镜里清掉 2 镜的卡片，和清掉全部是同一量级的事故。

        2026-09-23 起更严：没有上屏列就一律不清（见下一条），这里整份只告警。
        """
        rows = [["时间轴", "中文文案", "素材搜索(中文)"]] + [
            [f"0:0{i}-0:0{i + 1}", f"第{i}句口播在这里。", f"关键词{i}"] for i in range(1, 5)]
        plan = plan_with(*[
            {"shot": i, "title": f"分镜{i}", "voice_text": f"第{i}句口播在这里。",
             **({"card_content": f"卡{i}"} if i <= 2 else {})} for i in range(1, 5)])
        before = json.dumps(plan, ensure_ascii=False, sort_keys=True)
        report = scf.reconcile(plan, self.workbook(rows))
        self.assertEqual(report["corrections"], [])
        self.assertEqual(json.dumps(plan, ensure_ascii=False, sort_keys=True), before)
        self.assertEqual(report["status"], "skipped:uncertain")

    def test_a_table_without_a_card_column_never_clears_even_one_card(self):
        """2026-09-23 用户拍板（取代 9/21 的 1/3 保险丝）：表里没有上屏列时**绝不清空**，
        哪怕只有一镜有卡片。「没写所以清掉」只允许在表里确实有上屏列、该镜那格为空时发生。
        表里有分镜标题列 -> 仍是「确定」档，标题照常纠正，只有两个上屏字段冻结。"""
        rows = [["分镜", "分镜标题", "口播"],
                ["1", "来料到位", "先看来料怎样到位。"],
                ["2", "抓取落放", "再看机械臂如何抓取。"]]
        plan = plan_with(
            {"shot": 1, "title": "来料到位", "voice_text": "先看来料怎样到位。",
             "card_content": "作者其实写在别处的卡", "card_hint": "大字"},
            {"shot": 2, "title": "模型改的标题", "voice_text": "再看机械臂如何抓取。"},
        )
        report = scf.reconcile(plan, self.workbook(rows))
        self.assertEqual(report["tier"], "certain")
        self.assertEqual([(c["shot"], c["field"], c["kind"]) for c in report["corrections"]],
                         [(2, "title", "rewritten")])
        self.assertEqual(plan["shots"][0]["card_content"], "作者其实写在别处的卡")
        self.assertEqual(plan["shots"][0]["card_hint"], "大字")
        self.assertTrue(any("不会因此清空" in w for w in report["warnings"]))

    def test_a_card_column_that_exists_still_clears_an_invented_card(self):
        """反面：表里**有**上屏列、该镜那格为空（或占位）-> 确定档照常清掉臆造的卡。"""
        for empty in (None, "—", "不上屏", "大字：", "／"):
            with self.subTest(cell=empty):
                rows = [["分镜", "口播", "上屏文字"],
                        ["1", "先看来料怎样到位。", empty],
                        ["2", "再看机械臂如何抓取。", "抓取卡"]]
                plan = plan_with(
                    {"shot": 1, "title": "分镜1", "voice_text": "先看来料怎样到位。",
                     "card_content": "模型造的"},
                    {"shot": 2, "title": "分镜2", "voice_text": "再看机械臂如何抓取。",
                     "card_content": "抓取卡"},
                )
                report = scf.reconcile(plan, self.workbook(rows))
                self.assertEqual([(c["shot"], c["field"], c["kind"]) for c in report["corrections"]],
                                 [(1, "card_content", "invented")])
                self.assertNotIn("card_content", plan["shots"][0])

    def test_a_csv_shot_table_goes_down_the_table_route(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / "s.csv"
        path.write_text("分镜,口播,上屏文字\n"
                        "1,袋装物料码垛，先看来料怎样到位。,来料到位是码垛稳定的第一道关\n"
                        "2,袋料和箱体的外形不同。,\n", encoding="utf-8")
        plan = sample_plan()
        report = scf.reconcile(plan, path)
        self.assertEqual(report["route"], "table")
        self.assertEqual([c["kind"] for c in report["corrections"]], ["missing"])

    def test_a_csv_that_is_really_free_text_falls_back_to_the_text_route(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / "s.csv"
        path.write_text(SAMPLE, encoding="utf-8")
        plan = sample_plan()
        report = scf.reconcile(plan, path)
        self.assertEqual(report["route"], "text")
        self.assertEqual([c["kind"] for c in report["corrections"]], ["missing"])


# ----------------------------------------------------------------------------
# docx / pdf / doc / xls
# ----------------------------------------------------------------------------

def write_docx(path: Path, paragraphs: list[str]) -> Path:
    """**测试专用**的最小 docx：标准库 zip + XML，与 `script_tabular` 读的是同一套。"""
    body = "".join(
        "<w:p><w:r><w:t xml:space=\"preserve\">"
        + text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        + "</w:t></w:r></w:p>" for text in paragraphs)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml",
                         '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                         '<Types xmlns="http://schemas.openxmlformats.org/package/2006/'
                         'content-types"><Default Extension="xml" ContentType="application/xml"/>'
                         '<Default Extension="rels" ContentType="application/vnd.openxmlformats-'
                         'package.relationships+xml"/><Override PartName="/word/document.xml" '
                         'ContentType="application/vnd.openxmlformats-officedocument.'
                         'wordprocessingml.document.main+xml"/></Types>')
        archive.writestr("_rels/.rels",
                         '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                         '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/'
                         'relationships"><Relationship Id="rId1" Type="http://schemas.'
                         'openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
                         'Target="word/document.xml"/></Relationships>')
        archive.writestr("word/document.xml",
                         '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                         '<w:document xmlns:w="http://schemas.openxmlformats.org/'
                         f'wordprocessingml/2006/main"><w:body>{body}</w:body></w:document>')
    return path


class OtherFormatTests(unittest.TestCase, TempScriptMixin):
    def docx(self, paragraphs: list[str]) -> Path:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        return write_docx(Path(directory.name) / "s.docx", paragraphs)

    def test_a_docx_shot_script_goes_down_the_text_route(self):
        path = self.docx(SAMPLE.splitlines())
        plan = sample_plan()
        report = scf.reconcile(plan, path)
        self.assertEqual(report["route"], "text")
        self.assertEqual([c["kind"] for c in report["corrections"]], ["missing"])
        self.assertEqual(plan["shots"][0]["card_content"], "来料到位是码垛稳定的第一道关")

    def test_a_docx_without_shot_markers_is_a_zero_action(self):
        path = self.docx(["一段自由格式的说明。", "上屏文字：随便写的"])
        plan = sample_plan(s1={"card_content": "随便"})
        before = json.dumps(plan, ensure_ascii=False, sort_keys=True)
        report = scf.reconcile(plan, path)
        self.assertEqual(report["status"], "skipped:no_markers")
        self.assertEqual(json.dumps(plan, ensure_ascii=False, sort_keys=True), before)

    def test_pdf_doc_and_xls_are_never_opened(self):
        for suffix in (".pdf", ".doc", ".xls"):
            with self.subTest(suffix=suffix):
                script = self.write_script(SAMPLE, name=f"s{suffix}")
                plan = sample_plan(s1={"card_content": "随便"})
                before = json.dumps(plan, ensure_ascii=False, sort_keys=True)
                report = scf.reconcile(plan, script)
                self.assertEqual(report["status"], "skipped:format")
                self.assertEqual(json.dumps(plan, ensure_ascii=False, sort_keys=True), before)

    def test_an_unknown_suffix_is_a_zero_action(self):
        script = self.write_script(SAMPLE, name="s.pages")
        report = scf.reconcile(sample_plan(), script)
        self.assertEqual(report["status"], "skipped:format")

    def test_a_corrupt_workbook_is_a_zero_action(self):
        script = self.write_script("这不是 xlsx", name="s.xlsx")
        plan = sample_plan(s1={"card_content": "随便"})
        before = json.dumps(plan, ensure_ascii=False, sort_keys=True)
        report = scf.reconcile(plan, script)
        self.assertEqual(report["status"], "skipped:format")
        self.assertEqual(json.dumps(plan, ensure_ascii=False, sort_keys=True), before)


# ----------------------------------------------------------------------------
# title：三类照纠，但 schema 兜底不许误判
# ----------------------------------------------------------------------------

class TitleTests(unittest.TestCase, TempScriptMixin, TableWorkbookMixin):
    def setUp(self):
        self.script = self.write_script(SAMPLE)

    def test_a_rewritten_title_is_replaced_by_the_script_text(self):
        plan = sample_plan(s2={"title": "解析器自己改短了的标题"})
        report = scf.reconcile(plan, self.script)
        self.assertEqual([(c["shot"], c["field"], c["kind"]) for c in report["corrections"]],
                         [(1, "card_content", "missing"), (2, "title", "rewritten")])
        self.assertEqual(plan["shots"][1]["title"], "袋料和箱体要分开核对")

    def test_a_lost_title_is_restored(self):
        plan = sample_plan(s2={"title": ""})
        report = scf.reconcile(plan, self.script)
        self.assertIn((2, "title", "missing"),
                      [(c["shot"], c["field"], c["kind"]) for c in report["corrections"]])
        self.assertEqual(plan["shots"][1]["title"], "袋料和箱体要分开核对")

    def test_a_schema_fallback_title_is_not_treated_as_invented(self):
        """脚本没写标题 -> plan 里的「分镜N」是 schema 兜底的，不许清、也不吵。"""
        text = ("# t\n\n## 分镜 1\n\n- 口播：袋装物料码垛，先看来料怎样到位。\n"
                "- 上屏文字：甲\n\n## 分镜 2\n\n- 口播：袋料和箱体的外形不同。\n"
                "- 上屏文字：乙\n")
        script = self.write_script(text)
        plan = plan_with(
            {"shot": 1, "title": "分镜1", "voice_text": SAMPLE_SHOTS[0]["voice_text"],
             "card_content": "甲"},
            {"shot": 2, "title": "模型自己拟的一个标题",
             "voice_text": SAMPLE_SHOTS[1]["voice_text"], "card_content": "乙"},
        )
        before = json.dumps(plan, ensure_ascii=False, sort_keys=True)
        report = scf.reconcile(plan, script)
        self.assertEqual(report["corrections"], [])
        self.assertEqual(report["warnings"], [])
        self.assertEqual(json.dumps(plan, ensure_ascii=False, sort_keys=True), before)

    def test_a_title_the_author_left_blank_is_also_a_fallback(self):
        script = self.write_script(SAMPLE.replace("- 分镜标题：来料到位是第一道关",
                                                  "- 分镜标题：（不填）"))
        plan = sample_plan(s1={"title": "分镜1", "card_content": "来料到位是码垛稳定的第一道关"})
        report = scf.reconcile(plan, script)
        self.assertEqual(report["corrections"], [])
        self.assertEqual(plan["shots"][0]["title"], "分镜1")

    def test_module_label_is_never_touched(self):
        """章节标签是解析器按规则生成的，不是作者原文——不在校验范围里。"""
        script = self.write_script(SAMPLE.replace("- 时长：7 秒", "- 章节标签：来料到位"))
        plan = sample_plan(s1={"module_label": "解析器生成的章节名",
                               "card_content": "来料到位是码垛稳定的第一道关"})
        report = scf.reconcile(plan, script)
        self.assertEqual(report["corrections"], [])
        self.assertEqual(plan["shots"][0]["module_label"], "解析器生成的章节名")

    def test_a_title_cannot_be_corrected_when_it_is_the_only_anchor(self):
        """只有标题能认人，而标题恰恰被改写了 -> 认不了人 -> 只告警。"""
        script = self.write_script(
            "## 分镜 1\n\n- 分镜标题：来料到位是第一道关\n- 上屏文字：甲\n\n"
            "## 分镜 2\n\n- 分镜标题：袋料和箱体要分开核对\n- 上屏文字：乙\n")
        plan = plan_with({"shot": 1, "title": "改写过的甲"}, {"shot": 2, "title": "改写过的乙"})
        report = scf.reconcile(plan, script)
        self.assertEqual(report["corrections"], [])
        self.assertEqual(plan["shots"][0]["title"], "改写过的甲")
        self.assertTrue(report["warnings"])

    def test_title_is_validated_on_the_table_route_too(self):
        plan = sample_plan(s1={"title": "解析器改写过的标题",
                               "card_content": "来料到位是码垛稳定的第一道关"})
        report = scf.reconcile(plan, self.workbook(TABLE_ROWS))
        self.assertEqual([(c["shot"], c["field"], c["kind"]) for c in report["corrections"]],
                         [(1, "title", "rewritten")])
        self.assertEqual(plan["shots"][0]["title"], "来料到位是第一道关")

    def test_a_table_without_a_title_column_leaves_titles_alone(self):
        rows = [["分镜", "口播", "上屏文字"],
                ["1", "袋装物料码垛，先看来料怎样到位。", "来料到位是码垛稳定的第一道关"],
                ["2", "袋料和箱体的外形不同。", None]]
        plan = sample_plan(s1={"card_content": "来料到位是码垛稳定的第一道关"},
                           s2={"title": "分镜2"})
        report = scf.reconcile(plan, self.workbook(rows))
        self.assertEqual(report["corrections"], [])
        self.assertEqual(plan["shots"][0]["title"], "来料到位是第一道关")
        self.assertEqual(plan["shots"][1]["title"], "分镜2")


# ----------------------------------------------------------------------------
# 新增路径的日志也不许在 gbk stdout 上崩
# ----------------------------------------------------------------------------

class NewRouteOutputTests(unittest.TestCase, TempScriptMixin, TableWorkbookMixin):
    def test_every_new_log_line_survives_a_gbk_stdout(self):
        cases = [
            (sample_plan(), self.workbook(TABLE_ROWS)),                       # 表格有纠正
            (sample_plan(), self.workbook([["甲列", "乙列"], ["1", "2"]])),      # 认不出表头
            (sample_plan(), self.workbook(
                None, sheets=[("中文版", TABLE_ROWS), ("英文版", TABLE_ROWS)])),  # 多 sheet
            (sample_plan(), self.write_script(SAMPLE, name="s.pdf")),         # 零动作
            (sample_plan(s1={"card_content": "来料到位是码垛稳定的第一道关"}),
             self.workbook([["时间轴", "中文文案"],
                            ["0:00-0:07", "袋装物料码垛，先看来料怎样到位。"],
                            ["0:07-0:15", "袋料和箱体的外形不同。"]])),           # 没有上屏列
        ]
        for index, (plan, script) in enumerate(cases):
            with self.subTest(case=index):
                _report, printed = capture(scf.verify_and_fix, plan, script)
                printed.encode("gbk")
                self.assertNotIn("Traceback", printed)

    def test_the_table_route_still_emits_one_event(self):
        plan = sample_plan()
        _report, printed = capture(scf.verify_and_fix, plan, self.workbook(TABLE_ROWS))
        events = [line for line in printed.splitlines() if line.startswith("VACUT_EVENT:")]
        self.assertEqual(len(events), 1)
        payload = json.loads(events[0][len("VACUT_EVENT:"):])
        self.assertEqual(payload["workflowProgress"]["phase"], "card_fields")


# ----------------------------------------------------------------------------
# B7 的两份等价脚本：表格版 / 纯文本版
# ----------------------------------------------------------------------------

EQUIVALENT = {
    "markdown": "03_混合_show判定_食品码垛_CN.md",
    "table": "07_表格版_混合_show判定_食品码垛_CN.xlsx",
    "text": "07_纯文本版_混合_show判定_食品码垛_CN.txt",
}


@unittest.skipUnless(SCRIPTS.is_dir(), "测试脚本目录不在（只在仓库里跑）")
class EquivalentScriptTests(unittest.TestCase):
    def fields_of(self, name: str) -> list[tuple[str, str, str]]:
        blocks, status, _info = scf.collect_blocks(SCRIPTS / name)
        self.assertEqual(status, "ok", name)
        return [tuple(block[field]["value"] for field in scf.FIELDS) for block in blocks]

    def test_the_three_formats_of_script_03_extract_identically(self):
        """B7 的前提：xlsx 版、txt 版、md 版必须抽出一模一样的东西。"""
        reference = self.fields_of(EQUIVALENT["markdown"])
        self.assertEqual(len(reference), 7)
        for label in ("table", "text"):
            with self.subTest(format=label):
                self.assertEqual(self.fields_of(EQUIVALENT[label]), reference)

    def test_the_table_version_keeps_the_two_title_probes(self):
        """B8 的两个探针：第 4 镜的长句标题、第 6 镜的「开场」。"""
        fields = self.fields_of(EQUIVALENT["table"])
        self.assertEqual(fields[3][2],
                         "包装落到托盘以后还要核对排列方向垛层边缘和抓具退出的路径")
        self.assertEqual(fields[5][2], "开场")

    def test_u7_table_repairs_titles_even_when_parser_copied_chapter_labels(self):
        """51405257：用原 07 表和 U7 首次导入 plan 复现第 4/6 镜标题被保护逻辑拦住。"""
        plan = json.loads(U7_CAPTURED_PLAN.read_text(encoding="utf-8"))
        report = scf.reconcile(plan, SCRIPTS / EQUIVALENT["table"])

        self.assertEqual(
            [(item["shot"], item["field"], item["kind"]) for item in report["corrections"]],
            [(4, "title", "rewritten"), (6, "title", "rewritten")],
        )
        self.assertEqual(
            [plan["shots"][3]["title"], plan["shots"][5]["title"]],
            ["包装落到托盘以后还要核对排列方向垛层边缘和抓具退出的路径", "开场"],
        )

    def test_u7_exception_does_not_unprotect_table_card_fields(self):
        rows = [["分镜", "分镜标题", "口播", "上屏文字", "章节标签"],
                ["1", "来料到位", "先看来料怎样到位。", None, "解析器抄来的章节标签"]]
        path = TableWorkbookMixin.workbook(self, rows)
        plan = plan_with({"shot": 1, "title": "来料到位", "voice_text": "先看来料怎样到位。",
                          "card_content": "解析器抄来的章节标签"})
        report = scf.reconcile(plan, path)
        self.assertEqual(report["corrections"], [])
        self.assertEqual(plan["shots"][0]["card_content"], "解析器抄来的章节标签")
        self.assertTrue(any("本表不认识的字段名" in warning for warning in report["warnings"]))

    def test_u7_exception_does_not_apply_to_plain_text_titles(self):
        script = TempScriptMixin.write_script(
            self,
            SAMPLE.replace("- 时长：7 秒", "- 章节标签：解析器抄来的章节标签"),
        )
        plan = sample_plan(s1={"title": "解析器抄来的章节标签",
                               "card_content": "来料到位是码垛稳定的第一道关"})
        report = scf.reconcile(plan, script)
        self.assertEqual([(item["field"], item["kind"]) for item in report["corrections"]],
                         [("title", "rewritten")])
        self.assertEqual(plan["shots"][0]["title"], "来料到位是第一道关")
        self.assertEqual(report["warnings"], [])

    def test_the_table_version_corrects_exactly_what_the_markdown_one_does(self):
        name = "03_混合_show判定_食品码垛_CN.md"
        expected = None
        for label in ("markdown", "table", "text"):
            with self.subTest(format=label):
                plan = plan_for(name, [("", ""), ("", ""), ("", ""), ("", ""),
                                       ("占位卡 05", "placeholder card"), ("", ""),
                                       ("带上你的包装形态和目标垛型，一起把这条线试一遍",
                                        "CTA 行动号召")])
                plan["shots"][3]["title"] = "落盘后核对方向与路径"
                plan["shots"][5]["title"] = "整合视图看工位衔接"
                report = scf.reconcile(plan, SCRIPTS / EQUIVALENT[label])
                actual = [(c["shot"], c["field"], c["kind"]) for c in report["corrections"]]
                if expected is None:
                    expected = actual
                    self.assertEqual(actual, [(1, "card_content", "missing"),
                                              (4, "title", "rewritten"),
                                              (5, "card_hint", "invented"),
                                              (6, "title", "rewritten")])
                self.assertEqual(actual, expected)
                self.assertEqual(report["warnings"], [])


# ----------------------------------------------------------------------------
# 2026-09-23 收紧：只有「确定」档才自动改 plan（复盘阻断 A / B 与应修项）
# ----------------------------------------------------------------------------

# 复盘夹具共用：真表 3 镜，只有第 1 镜作者写了上屏文字。
REAL_TABLE = [["分镜", "分镜标题", "口播", "上屏文字"],
              ["1", "来料到位", "先看来料怎样到位。", "来料卡"],
              ["2", "抓取落放", "再看机械臂如何抓取。", None],
              ["3", "落放确认", "最后确认落放位置。", None]]


def three_shot_plan(first_card: str | None = "来料卡") -> dict:
    shots = [{"shot": 1, "title": "来料到位", "voice_text": "先看来料怎样到位。"},
             {"shot": 2, "title": "抓取落放", "voice_text": "再看机械臂如何抓取。"},
             {"shot": 3, "title": "落放确认", "voice_text": "最后确认落放位置。"}]
    if first_card:
        shots[0]["card_content"] = first_card
    return plan_with(*shots)


def dumps(plan: dict) -> str:
    return json.dumps(plan, ensure_ascii=False, sort_keys=True)


class CertaintyGateTests(unittest.TestCase, TableWorkbookMixin):
    """「确定」判据：不满足任何一条 -> 整份只告警、plan 一个字节都不变。"""

    def assert_untouched_warn_only(self, path: Path, plan: dict) -> dict:
        before = dumps(plan)
        report = scf.reconcile(plan, path)
        self.assertEqual(report["status"], "skipped:uncertain")
        self.assertEqual(report["tier"], "warn_only")
        self.assertEqual(report["corrections"], [])
        self.assertEqual(dumps(plan), before)
        self.assertTrue(any("一个字段都不改" in w for w in report["warnings"]))
        return report

    def test_block_a_legend_or_example_header_above_the_real_table(self):
        """阻断 A（1a5f5d0 引入）：真表上方的图例 / 填写示例表头抢表，口播被写进无卡镜。
        e5b5bec 上 X1/X2/X4/X5 都会把口播写成第 2、3 镜的 card_content。"""
        shapes = {
            "X1": [["填写示例"], ["序号", "分镜标题", "上屏文字"],
                   ["1", "示例：开场", "示例：大字钩子"], []] + REAL_TABLE,
            "X2": [["序号", "分镜标题", "口播", "上屏文字"], ["1", "示例标题", "示例口播", "示例卡片"], [],
                   ["分镜", "分镜标题", "口播", "上屏文字", "备注"]]
                  + [row + [None] for row in REAL_TABLE[1:]],
            "X4": [["序号", "分镜标题", "上屏文字"], ["例", "示例：开场", "示例：大字钩子"], []] + REAL_TABLE,
            "X5": [["序号", "分镜标题", "上屏文字"], []] + REAL_TABLE,
        }
        for label, rows in shapes.items():
            with self.subTest(shape=label):
                report = self.assert_untouched_warn_only(self.workbook(rows), three_shot_plan())
                self.assertTrue(any("也像带上屏/标题列的表头" in w for w in report["warnings"]))

    def test_the_same_table_without_the_legend_is_certain(self):
        """对照组：去掉图例后是确定档；第 1 镜被丢的卡按原文补回，2/3 镜不造卡。"""
        plan = three_shot_plan(first_card=None)
        report = scf.reconcile(plan, self.workbook(REAL_TABLE))
        self.assertEqual(report["tier"], "certain")
        self.assertEqual([(c["shot"], c["field"], c["kind"]) for c in report["corrections"]],
                         [(1, "card_content", "missing")])
        self.assertEqual([shot.get("card_content") for shot in plan["shots"]], ["来料卡", None, None])

    def test_block_b_real_v1_shape_never_clears_author_cards(self):
        """阻断 B（2976c0a 引入）：真实 `上下料B端视频脚本_v1.xlsx` 主表列名
        `画面(素材文件,相对本文件夹)` 不在词表 -> 主表过不了密度闸门 -> 只认出没有上屏列的
        「旁白纯文本」副表 -> e5b5bec 把作者卡片当「没写」清掉。"""
        header = ["拍", "时间码(入)", "时间码(出)", "时长s", "段落", "中文旁白", "英文旁白",
                  "屏字/大字", "画面(素材文件,相对本文件夹)", "取段", "原创图层", "处理要求",
                  "事实编号", "备注"]
        main = [header,
                ["1", "0:00", "0:06", "6", "钩子", "第一句旁白内容在这里。", "First.",
                 "机床在等人？", "a.mp4", "t1", "大字钩子", "p", "—", ""],
                ["2", "0:06", "0:20", "14", "方案", "第二句旁白内容在这里。", "Second.",
                 "", "b.mp4", "t2", "", "p", "—", ""],
                ["3", "0:20", "0:40", "20", "原理", "第三句旁白内容在这里。", "Third.",
                 "", "c.mp4", "t3", "", "p", "—", ""]]
        narration = [["拍", "中文旁白", "字数", "英文旁白"],
                     ["1", "第一句旁白内容在这里。", "11", "First."],
                     ["2", "第二句旁白内容在这里。", "11", "Second."],
                     ["3", "第三句旁白内容在这里。", "11", "Third."]]
        path = self.workbook(None, sheets=[("分镜脚本", main), ("旁白纯文本", narration)])
        plan = plan_with(
            {"shot": 1, "title": "钩子", "voice_text": "第一句旁白内容在这里。",
             "card_content": "机床在等人？", "card_hint": "大字钩子"},
            {"shot": 2, "title": "方案", "voice_text": "第二句旁白内容在这里。"},
            {"shot": 3, "title": "原理", "voice_text": "第三句旁白内容在这里。"})
        report = self.assert_untouched_warn_only(path, plan)
        self.assertEqual(report["info"]["sheets"], ["旁白纯文本"])
        self.assertTrue(any("没有上屏文字" in w for w in report["warnings"]))
        self.assertTrue(any("「分镜脚本」第 1 行" in w for w in report["warnings"]))

    def test_real_v2a_shape_stays_certain_and_restores_the_author_cards(self):
        """真实 v2A 的完整形状（14 列主表 + 旁白副本 + 红线 / 素材 / 图层三张附表）
        必须仍是确定档：模型把卡片折成一行、还照抄了版式标签时，按原文恢复。"""
        header = ["拍", "时间码(入)", "时间码(出)", "时长s", "段落", "中文旁白", "英文旁白",
                  "屏字/大字", "画面(素材文件,相对资料包根目录)", "取段", "原创图层", "处理要求",
                  "事实编号", "备注"]
        cards = ["大字：抓起来、放进去？\n副行：决定成败的其实是三件事",
                 "01 料的呈现\n料盘 / 旋转料仓 · 人工预放 · 位置固定",
                 "缓存 → 上下料 → 在线检测\n对接：AGV · AMR · 皮带机 · 理料机"]
        voices = ["机器人给机床上下料，看起来就是抓起来、放进去。",
                  "第一件事，料怎么呈现。毛坯不能乱堆。",
                  "如果要成一条线，上下料前面加缓存。"]
        main = [header] + [[str(i + 1), "0:00", "0:11", Number("11"), "段", voices[i], "EN",
                            cards[i], "03_原始资料/a.mp4", "t1", f"图层{i + 1}", "处理", "—", ""]
                           for i in range(3)]
        narration = [["拍", "中文旁白", "字数", "按4.2字/秒估时(s)", "英文旁白"]] + [
            [str(i + 1), voices[i], Number("41"), Number("9.800000000000001"), "EN"] for i in range(3)]
        redline = [["#", "规则", "依据", "自查"], ["1", "全片不出现任何公司名", "S1", "☐"]]
        material = [["拍", "文件（相对资料包根目录）", "规格", "注意"], ["1, 7", "a.mp4", "1280×720", "P 掉"]]
        layers = [["类型", "位置", "内容"], ["图层", "拍1", "大字钩子（描边/halo，不压深色底带）"]]
        path = self.workbook(None, sheets=[("分镜脚本", main), ("旁白纯文本", narration),
                                           ("红线自查", redline), ("素材对照", material),
                                           ("图层与待确认", layers)])
        expected = ["抓起来、放进去？\n决定成败的其实是三件事", cards[1], cards[2]]
        plan = plan_with(*[{"shot": i + 1, "title": f"分镜{i + 1}", "voice_text": voices[i],
                            "card_content": collapse_like_e5b5bec(cards[i]),
                            "card_hint": f"图层{i + 1}"} for i in range(3)])
        report = scf.reconcile(plan, path)
        self.assertEqual(report["tier"], "certain")
        self.assertEqual(report["info"]["sheets"], ["分镜脚本"])
        self.assertEqual([c["kind"] for c in report["corrections"]], ["rewritten"] * 3)
        self.assertEqual([shot["card_content"] for shot in plan["shots"]], expected)
        again = json.loads(dumps(plan))
        self.assertEqual(scf.reconcile(again, path)["corrections"], [])
        self.assertEqual(dumps(again), dumps(plan))

    def test_the_y1_y2_fixes_of_the_fourth_review_are_not_undone(self):
        """第四次复审 Y1 / Y2：下方角色更多的小表、`分镜标题（全片通用）` + 纵向合并
        都不能改写任何 title。
        （2026-09-23 第二次对抗复审应修 5：原注释写「两者都落到只告警 / 跳过」不准，改正并锁住档位——）
        Y1 = 跳过（`skipped:table`：下方小表的镜号接着 1、2 往下排，镜号不再是严格 1..N，整表放弃）；
        Y2 = **确定档**，只是 `分镜标题（全片通用）` 这一列因括注与 title 角色冲突认不出来，
        title 根本不参与校验，所以一个都不动。"""
        y1 = [["分镜", "口播", "上屏文字"],
              ["1", "先看来料怎样到位。", "来料卡"],
              ["2", "再看机械臂如何抓取。", "抓取卡"],
              [],
              ["镜号", "分镜标题", "口播", "画面"],
              ["1", "平台标题一", "先看来料怎样到位。", "x"],
              ["2", "平台标题二", "再看机械臂如何抓取。", "y"]]
        plan = plan_with({"shot": 1, "title": "来料到位", "voice_text": "先看来料怎样到位。",
                          "card_content": "来料卡"},
                         {"shot": 2, "title": "抓取落放", "voice_text": "再看机械臂如何抓取。",
                          "card_content": "抓取卡"})
        before = dumps(plan)
        report = scf.reconcile(plan, self.workbook(y1))
        self.assertEqual(report["status"], "skipped:table")
        self.assertEqual(report["corrections"], [])
        self.assertEqual(dumps(plan), before)
        y2 = [["分镜", "分镜标题（全片通用）", "口播", "上屏文字"],
              ["1", "码垛工位观察", "先看来料怎样到位。", "来料卡"],
              ["2", None, "再看机械臂如何抓取。", "抓取卡"],
              ["3", None, "最后确认落放位置。", None]]
        plan = three_shot_plan()
        before = dumps(plan)
        report = scf.reconcile(plan, self.workbook(y2, merges={"视频脚本": ["B2:B4"]}))
        self.assertEqual(report["tier"], "certain")
        self.assertNotIn("title", report["info"]["roles"])
        self.assertNotIn("title", {c["field"] for c in report["corrections"]})
        self.assertEqual([shot["title"] for shot in plan["shots"]], ["来料到位", "抓取落放", "落放确认"])

    def test_a_horizontal_merge_over_a_key_column_is_warn_only(self):
        """口播格横向合并盖住右边的上屏列（C2:D2）：读取层不再往右摊，上层整份只告警。"""
        rows = [["分镜", "分镜标题", "口播", "上屏文字", "卡片样式"],
                ["1", "来料到位", "先看来料怎样到位。", None, None],
                ["2", "抓取落放", "再看机械臂如何抓取。", "抓取卡", None]]
        path = self.workbook(rows, merges={"视频脚本": ["C2:D2"]})
        self.assertEqual(script_tabular.read_workbook(path)[0][1][1][3], "")
        plan = plan_with({"shot": 1, "title": "来料到位", "voice_text": "先看来料怎样到位。"},
                         {"shot": 2, "title": "抓取落放", "voice_text": "再看机械臂如何抓取。",
                          "card_content": "抓取卡"})
        report = self.assert_untouched_warn_only(path, plan)
        self.assertTrue(any("横向合并" in w for w in report["warnings"]))

    def test_a_card_merged_down_across_two_shots_is_warn_only(self):
        rows = [["分镜", "口播", "上屏文字"],
                ["1", "先看来料怎样到位。", "统一卡"],
                ["2", "再看机械臂如何抓取。", None]]
        path = self.workbook(rows, merges={"视频脚本": ["C2:C3"]})
        plan = plan_with({"shot": 1, "title": "a", "voice_text": "先看来料怎样到位。",
                          "card_content": "统一卡"},
                         {"shot": 2, "title": "b", "voice_text": "再看机械臂如何抓取。"})
        report = self.assert_untouched_warn_only(path, plan)
        self.assertTrue(any("跨了不止一镜" in w for w in report["warnings"]))

    def test_a_card_merged_down_within_one_shot_is_still_certain(self):
        rows = [["分镜", "口播", "上屏文字"],
                ["1", "先看来料怎样到位。", "同一张卡"],
                [None, "补一句。", None],
                ["2", "再看机械臂如何抓取。", "抓取卡"]]
        path = self.workbook(rows, merges={"视频脚本": ["A2:A3", "C2:C3"]})
        plan = plan_with({"shot": 1, "title": "a", "voice_text": "先看来料怎样到位。"},
                         {"shot": 2, "title": "b", "voice_text": "再看机械臂如何抓取。",
                          "card_content": "抓取卡"})
        report = scf.reconcile(plan, path)
        self.assertEqual(report["tier"], "certain")
        self.assertEqual(plan["shots"][0]["card_content"], "同一张卡")

    def test_tiers_are_reported_for_every_route(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        text = Path(directory.name) / "s.md"
        text.write_text(SAMPLE, encoding="utf-8")
        pdf = Path(directory.name) / "s.pdf"
        pdf.write_bytes(b"%PDF-1.4")
        self.assertEqual(scf.reconcile(sample_plan(), text)["tier"], "certain")
        self.assertEqual(scf.reconcile(sample_plan(), pdf)["tier"], "skipped")
        self.assertEqual(scf.reconcile(plan_with(SAMPLE_SHOTS[0]), text)["tier"], "warn_only")


def collapse_like_e5b5bec(value: str) -> str:
    """e5b5bec 的 `compact_plan` 对 card_content 做的事：整段空白折叠成一个空格。"""
    return " ".join(value.split())


class CellKindTests(unittest.TestCase, TableWorkbookMixin):
    """数值 / 公式格：读到的不是作者看到的字，待校验字段落在上面只告警。"""

    def reconcile_card(self, cell, plan_card):
        rows = [["分镜", "口播", "上屏文字"],
                ["1", "先看来料怎样到位。", cell],
                ["2", "再看机械臂如何抓取。", "抓取卡"]]
        plan = plan_with({"shot": 1, "title": "a", "voice_text": "先看来料怎样到位。",
                          "card_content": plan_card},
                         {"shot": 2, "title": "b", "voice_text": "再看机械臂如何抓取。",
                          "card_content": "抓取卡"})
        before = dumps(plan)
        report = scf.reconcile(plan, self.workbook(rows))
        return plan, before, report

    def test_numeric_cells_are_flagged_by_the_reader(self):
        rows = [["分镜", "上屏文字"], [Number("1"), Number("0.95")], ["2", Formula("A2")]]
        grid = script_tabular.read_workbook(self.workbook(rows))[0][1]
        self.assertEqual(grid[1][1], "0.95")
        self.assertEqual(script_tabular.cell_kind(grid[1][1]), "number")
        self.assertEqual(script_tabular.cell_kind(grid[1][0]), "number")
        self.assertEqual(grid[2][1], "")
        self.assertEqual(script_tabular.cell_kind(grid[2][1]), "formula")
        self.assertEqual(script_tabular.cell_kind(grid[0][1]), "")

    def test_a_percent_or_float_card_only_warns(self):
        for raw, shown in (("0.95", "95%"), ("0.30000000000000004", "0.3")):
            with self.subTest(raw=raw):
                plan, before, report = self.reconcile_card(Number(raw), shown)
                self.assertEqual(report["tier"], "certain")
                self.assertEqual(report["corrections"], [])
                self.assertEqual(dumps(plan), before)
                self.assertTrue(any("数值" in w for w in report["warnings"]))

    def test_a_formula_card_without_a_cached_value_is_not_called_invented(self):
        plan, before, report = self.reconcile_card(Formula("B2"), "来料到位")
        self.assertEqual(report["corrections"], [])
        self.assertEqual(dumps(plan), before)
        self.assertTrue(any("公式" in w for w in report["warnings"]))

    def test_a_formula_card_with_a_cached_value_also_only_warns(self):
        plan, before, report = self.reconcile_card(Formula("B2", "别的字"), "来料到位")
        self.assertEqual(report["corrections"], [])
        self.assertEqual(dumps(plan), before)

    def test_a_numeric_shot_number_column_is_fine(self):
        rows = [["分镜", "口播", "上屏文字"],
                [Number("1"), "先看来料怎样到位。", "来料卡"],
                [Number("2"), "再看机械臂如何抓取。", None]]
        plan = plan_with({"shot": 1, "title": "a", "voice_text": "先看来料怎样到位。"},
                         {"shot": 2, "title": "b", "voice_text": "再看机械臂如何抓取。"})
        report = scf.reconcile(plan, self.workbook(rows))
        self.assertEqual([(c["shot"], c["kind"]) for c in report["corrections"]], [(1, "missing")])


class XstringAndMergeReaderTests(unittest.TestCase, TableWorkbookMixin):
    def test_x000d_is_decoded_in_shared_and_inline_strings(self):
        rows = [["分镜", "上屏文字"], ["1", "第一行_x000D_\n第二行"]]
        for shared in (True, False):
            with self.subTest(shared=shared):
                grid = script_tabular.read_workbook(self.workbook(rows, shared=shared))[0][1]
                self.assertEqual(grid[1][1], "第一行\r\n第二行")

    def test_x005f_escapes_the_underscore_itself(self):
        self.assertEqual(script_tabular.decode_xstring("_x005F_x000D_"), "_x000D_")
        self.assertEqual(script_tabular.decode_xstring("a_x0009_b"), "a\tb")
        self.assertEqual(script_tabular.decode_xstring("snake_case_x"), "snake_case_x")
        self.assertEqual(script_tabular.decode_xstring("_xD800_"), "_xD800_")   # 半个代理对不解

    def test_a_crlf_card_is_compared_as_a_plain_line_break(self):
        rows = [["分镜", "口播", "上屏文字"],
                ["1", "先看来料怎样到位。", "第一行_x000D_\n第二行"],
                ["2", "再看机械臂如何抓取。", "抓取卡"]]
        path = self.workbook(rows)
        blocks, _status, _info = scf.collect_blocks(path)
        self.assertEqual(blocks[0]["card_content"]["value"], "第一行\n第二行")
        plan = plan_with({"shot": 1, "title": "a", "voice_text": "先看来料怎样到位。",
                          "card_content": "第一行 第二行"},
                         {"shot": 2, "title": "b", "voice_text": "再看机械臂如何抓取。",
                          "card_content": "抓取卡"})
        scf.reconcile(plan, path)
        self.assertEqual(plan["shots"][0]["card_content"], "第一行\n第二行")
        self.assertNotIn("_x000D_", plan["shots"][0]["card_content"])

    def test_a_horizontal_merge_is_only_spread_down_its_own_column(self):
        rows = [["分镜", "口播", "上屏文字", "卡片样式"],
                ["1", "跨两列的口播", None, None],
                [None, None, None, "占位让第 3 行存在"]]
        grid = script_tabular.read_workbook(
            self.workbook(rows, merges={"视频脚本": ["B2:C3"]}))[0][1]
        self.assertEqual([grid[1][1], grid[1][2], grid[2][1], grid[2][2]],
                         ["跨两列的口播", "", "跨两列的口播", ""])


class LayoutLabelTests(unittest.TestCase, TableWorkbookMixin, TempScriptMixin):
    """行首版式标签（大字：/副行：/小字：/参数卡：/决策树：）是写给制作的，不上屏。"""

    def test_labels_are_stripped_at_the_start_of_every_line_only(self):
        cases = {
            "大字：抓起来、放进去？\n副行：决定成败的其实是三件事": "抓起来、放进去？\n决定成败的其实是三件事",
            "大字:  5 个误区": "5 个误区",
            " 参数卡 ： <3 kW ｜ 单相 220V": "<3 kW ｜ 单相 220V",
            "决策树：节拍 · 重量\n→ 料盘式单元": "节拍 · 重量\n→ 料盘式单元",
            "上下料 → 缓存\n小字：AGV / AMR 对接": "上下料 → 缓存\nAGV / AMR 对接",
            "缓存 → 上下料\n对接：AGV · AMR": "缓存 → 上下料\n对接：AGV · AMR",
            "下一期：什么样的机床适合上": "下一期：什么样的机床适合上",
            "大字钩子：不是标签": "大字钩子：不是标签",
            "主句里的大字：不剥": "主句里的大字：不剥",
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(scf.script_value(raw, "card_content", preserve_layout=True), expected)

    def test_a_cell_that_is_only_a_label_counts_as_not_written(self):
        for raw in ("大字：", "副行：—", "大字：\n副行：", "参数卡： 无"):
            with self.subTest(raw=raw):
                self.assertEqual(scf.script_value(raw, "card_content", preserve_layout=True), "")

    def test_labels_are_not_stripped_from_hints_or_titles(self):
        self.assertEqual(scf.script_value("大字：钩子", "card_hint"), "大字：钩子")
        self.assertEqual(scf.script_value("大字：钩子", "title"), "大字：钩子")

    def test_the_text_route_strips_the_label_too(self):
        text = SAMPLE.replace("上屏文字：来料到位是码垛稳定的第一道关",
                              "上屏文字：大字：来料到位是码垛稳定的第一道关")
        script = self.write_script(text)
        plan = sample_plan(s1={"card_content": "大字：来料到位是码垛稳定的第一道关"})
        report = scf.reconcile(plan, script)
        self.assertEqual([(c["shot"], c["field"], c["kind"]) for c in report["corrections"]],
                         [(1, "card_content", "rewritten")])
        self.assertEqual(plan["shots"][0]["card_content"], "来料到位是码垛稳定的第一道关")

    def test_the_parse_prompt_tells_the_model_the_same_whitelist(self):
        prompt = (TOOLS / "prompts" / "script_parse.md").read_text(encoding="utf-8")
        for label in scf.LAYOUT_LABELS:
            self.assertIn(f"「{label}：」", prompt)
        for placeholder in ("不上屏", "空白", "——", "／"):
            self.assertIn(placeholder, prompt)


class CompactPlanLayoutTests(unittest.TestCase, TableWorkbookMixin):
    """`normalize_script.compact_plan`：表格脚本的 card_content 不再折叠内部换行，
    真实流程再跑一次校验应 0 纠正（e5b5bec 每次导入都报 6 条「改写」）。"""

    def setUp(self):
        import normalize_script
        self.compact_plan = normalize_script.compact_plan

    def model_output(self, card: str) -> dict:
        return {"shots": [{"title": "分镜1", "voice_text": "先看来料怎样到位。",
                           "download_query": "q", "card_content": card},
                          {"title": "分镜2", "voice_text": "再看机械臂如何抓取。",
                           "download_query": "q", "card_content": "抓取卡"}]}

    def test_table_scripts_keep_card_line_breaks_and_text_scripts_still_fold(self):
        raw = self.model_output("  主句\r\n副行  两个空格 \n")
        kept = self.compact_plan(raw, "t", preserve_card_layout=True)
        self.assertEqual(kept["shots"][0]["card_content"], "主句\n副行  两个空格")
        folded = self.compact_plan(raw, "t")
        self.assertEqual(folded["shots"][0]["card_content"], "主句 副行 两个空格")
        self.assertEqual(kept["shots"][0]["voice_text"], folded["shots"][0]["voice_text"])

    def test_a_faithful_parse_of_a_multi_line_card_needs_no_correction(self):
        rows = [["分镜", "口播", "上屏文字"],
                ["1", "先看来料怎样到位。", "大字：主句\n副行：副行内容"],
                ["2", "再看机械臂如何抓取。", "抓取卡"]]
        path = self.workbook(rows)
        plan = self.compact_plan(self.model_output("主句\n副行内容"), "t", preserve_card_layout=True)
        report = scf.reconcile(plan, path)
        self.assertEqual(report["tier"], "certain")
        self.assertEqual(report["corrections"], [])
        old = self.compact_plan(self.model_output("主句\n副行内容"), "t")
        self.assertEqual([c["kind"] for c in scf.reconcile(old, path)["corrections"]], ["rewritten"])

if __name__ == "__main__":
    unittest.main()


# ----------------------------------------------------------------------------
# 2026-09-23 第二次对抗复审：阻断 B1 / B2、应修 1 / 2 与建议项（夹具 C1 C2 C4 C5）
# ----------------------------------------------------------------------------

V3 = ["先看来料怎样到位。", "再看机械臂如何抓取。", "最后确认落放位置。"]
H3 = ["分镜", "口播", "上屏文字"]


def voice_plan(cards, voices=V3, titles=None) -> dict:
    shots = []
    for index, card in enumerate(cards):
        shot = {"shot": index + 1, "title": titles[index] if titles else f"分镜{index + 1}",
                "voice_text": voices[index]}
        if card:
            shot["card_content"] = card
        shots.append(shot)
    return plan_with(*shots)


class SecondReviewTests(unittest.TestCase, TableWorkbookMixin):
    """每条都要求 plan 逐字节不变（宁可漏改，绝不改错）。"""

    def run_table(self, rows, plan, **kwargs):
        before = dumps(plan)
        report = scf.reconcile(plan, self.workbook(rows, **kwargs))
        return report, before

    def test_b1_an_example_block_with_the_same_header_above_is_warn_only(self):
        """阻断 B1（夹具 C1 / C1b）：上方示例块表头与正表逐字相同、示例行号写 1（或空）
        -> 556210e 把「示例卡片」写进第 1 镜并判确定。现在逐字重复的表头也算第二张表。"""
        example = ["1", "示例：这里写口播", "示例卡片"]
        real = [H3, ["1", V3[0], ""], ["2", V3[1], "抓取卡"], ["3", V3[2], ""]]
        shapes = {"C1": [H3, example, []] + real,
                  "C1b": [["填写示例"], H3, ["", example[1], example[2]], []] + real}
        for label, rows in shapes.items():
            with self.subTest(shape=label):
                plan = voice_plan([None, "抓取卡", None])
                report, before = self.run_table(rows, plan)
                self.assertEqual(report["status"], "skipped:uncertain")
                self.assertEqual(report["tier"], "warn_only")
                self.assertEqual(report["corrections"], [])
                self.assertEqual(dumps(plan), before)
                self.assertNotIn("示例卡片", dumps(plan))

    def test_b2_a_trailing_note_in_the_card_column_is_not_merged_into_the_last_shot(self):
        """阻断 B2（夹具 C2）：表尾隔两行空白、不写镜号的说明落在上屏列 -> 556210e 把它
        并进第 3 镜的上屏文字。现在那一镜只告警；其余镜照常是确定档。"""
        rows = [H3, ["1", V3[0], ""], ["2", V3[1], "抓取卡"], ["3", V3[2], ""], [], [],
                ["", "", "注：没有上屏文字的镜留空即可"]]
        plan = voice_plan([None, "抓取卡", None])
        report, before = self.run_table(rows, plan)
        self.assertEqual(report["tier"], "certain")
        self.assertEqual(report["corrections"], [])
        self.assertEqual(dumps(plan), before)
        self.assertTrue(any(w.startswith("分镜 3 的 card_content") for w in report["warnings"]))
        # 对照：没有表尾说明时第 3 镜没有告警
        clean = voice_plan([None, "抓取卡", None])
        report, _ = self.run_table(rows[:4], clean)
        self.assertEqual((report["tier"], report["corrections"]), ("certain", []))
        self.assertFalse(any(w.startswith("分镜 3") for w in report["warnings"]))

    def test_b2_variants_trailing_example_blocks(self):
        """C2b：表尾同表头示例 -> 整份只告警；C2c：表尾示例行号写「例」-> 第 3 镜只告警；
        另加：空行之后又冒出同号行（另一张表的第 3 行）-> 第 3 镜只告警。"""
        body = [H3, ["1", V3[0], ""], ["2", V3[1], "抓取卡"], ["3", V3[2], ""], []]
        shapes = {
            "C2b": (body + [["填写示例"], H3, ["", "示例口播", "示例卡片"]], "warn_only"),
            "C2c": (body + [["例", "示例口播", "示例卡片"]], "certain"),
            "same_number": (body + [["3", "另一张表的口播", "另一张卡"]], "certain"),
        }
        for label, (rows, tier) in shapes.items():
            with self.subTest(shape=label):
                plan = voice_plan([None, "抓取卡", None])
                report, before = self.run_table(rows, plan)
                self.assertEqual(report["tier"], tier)
                self.assertEqual(report["corrections"], [])
                self.assertEqual(dumps(plan), before)

    def test_c4_a_shared_title_cannot_vouch_for_a_mismatched_voice(self):
        """应修 1（夹具 C4）：第 1、2 镜标题都叫「痛点」，plan 把两镜口播顺序颠倒了。
        556210e 靠同名标题判「认人成功」，把第 2 镜的卡写进第 1 镜。"""
        header = ["分镜", "分镜标题", "口播", "上屏文字"]
        rows = [header, ["1", "痛点", V3[0], ""], ["2", "痛点", V3[1], "卡2"], ["3", "方案", V3[2], ""]]
        plan = voice_plan(["卡2", None, None], voices=[V3[1], V3[0], V3[2]],
                          titles=["痛点", "痛点", "方案"])
        report, before = self.run_table(rows, plan)
        self.assertEqual(report["corrections"], [])
        self.assertEqual(dumps(plan), before)
        self.assertTrue(any("镜号可能错位" in w for w in report["warnings"]))
        block = {"anchors": {"title": ["痛点"], "voice_text": [V3[0]]}}
        self.assertEqual(scf.anchor_verdict(block, {"title": "痛点", "voice_text": V3[1]}), "mismatch")
        self.assertEqual(scf.anchor_verdict(block, {"title": "痛点", "voice_text": V3[0]}), "ok")
        self.assertEqual(scf.anchor_verdict({"anchors": {"title": ["痛点"]}}, {"title": "痛点"}), "ok")

    def test_placeholder_variants_are_never_put_on_screen(self):
        """应修 2：这些写法模型留空是对的，556210e 判「丢失」写回、渲上屏。"""
        for value in ("不上屏（本镜）", "——（不填）", "— —", "-\n-", "Ｎ／Ａ", "无。", "（ 无 ）"):
            with self.subTest(value=value):
                rows = [H3, ["1", V3[0], value], ["2", V3[1], "抓取卡"], ["3", V3[2], ""]]
                plan = voice_plan([None, "抓取卡", None])
                report, before = self.run_table(rows, plan)
                self.assertEqual(report["tier"], "certain")
                self.assertEqual(report["corrections"], [])
                self.assertEqual(dumps(plan), before)
        self.assertTrue(all(scf.is_placeholder(v) for v in ("— —", "-\n-", "Ｎ／Ａ", "（ 无 ）")))
        # 第三次复审建议 3：占位收窄后这两个只是「像占位」——不再当没写，但仍然 0 改（只告警）
        for value in ("——（不填）", "无。"):
            self.assertFalse(scf.is_placeholder(value), value)
            self.assertTrue(scf.looks_like_placeholder(value), value)
        self.assertFalse(scf.is_placeholder("不上屏（本镜）"))   # 靠「丢失」闸门兜，不扩占位名单
        for value in ("无人化产线", "N/A 版本", "— 抓取 —", "空压机"):
            self.assertFalse(scf.is_placeholder(value), value)
        # 对照：真写了的卡照样补回（占位口径没有放宽到正文）
        rows = [H3, ["1", V3[0], "无人化产线"], ["2", V3[1], "抓取卡"], ["3", V3[2], ""]]
        plan = voice_plan([None, "抓取卡", None])
        report, _ = self.run_table(rows, plan)
        self.assertEqual([(c["shot"], c["kind"]) for c in report["corrections"]], [(1, "missing")])
        self.assertEqual(plan["shots"][0]["card_content"], "无人化产线")

    def test_a_copied_placeholder_explanation_is_flagged_not_changed(self):
        rows = [H3, ["1", V3[0], "不上屏（本镜）"], ["2", V3[1], "抓取卡"], ["3", V3[2], ""]]
        plan = voice_plan(["不上屏（本镜）", "抓取卡", None])
        report, before = self.run_table(rows, plan)
        self.assertEqual(report["corrections"], [])
        self.assertEqual(dumps(plan), before)
        self.assertTrue(any("分镜 1 的 card_content 里有「不上屏" in w for w in report["warnings"]))

    def test_chained_labels_and_markdown_around_labels_are_stripped(self):
        cases = {
            "大字：副行：抓取卡": "抓取卡",
            "**大字：**抓取卡": "抓取卡",
            "**大字**：抓取卡": "抓取卡",
            "大字：**A**\n小字：**B**": "A\nB",
            "对接：AGV · AMR": "对接：AGV · AMR",
            "大字钩子：X": "大字钩子：X",
            "正文里的 **强调** 不动": "正文里的 **强调** 不动",
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(scf.script_value(raw, "card_content", preserve_layout=True), expected)

    def test_x0000_and_other_controls_are_dropped_but_tab_newline_cr_are_kept(self):
        decode = script_tabular.decode_xstring
        self.assertEqual(decode("A_x0000_B"), "AB")
        self.assertEqual(decode("A_x0007__x001F__x0085_B"), "AB")
        self.assertEqual(decode("A_x0009_B_x000A_C_x000D_D"), "A\tB\nC\rD")
        self.assertEqual(decode("_x0041__x005F_x0000_"), "A_x0000_")
        rows = [H3, ["1", V3[0], "来料_x0000_卡"], ["2", V3[1], ""], ["3", V3[2], ""]]
        blocks, status, _info = self.blocks_of(rows)
        self.assertEqual(status, "ok")
        self.assertEqual(blocks[0]["card_content"]["value"], "来料卡")

    def test_hidden_columns_or_rows_make_the_table_warn_only(self):
        """夹具 C5 的真实形状：隐藏的旧上屏列 / 隐藏的示例行，解析器读不读说不准 -> 只告警。"""
        for label, kwargs in {"hidden_column": {"hidden_columns": {"视频脚本": [3]}},
                              "hidden_row": {"hidden_rows": {"视频脚本": [2]}}}.items():
            with self.subTest(shape=label):
                plan = three_shot_plan(first_card=None)
                report, before = self.run_table(REAL_TABLE, plan, **kwargs)
                self.assertEqual(report["status"], "skipped:uncertain")
                self.assertEqual(dumps(plan), before)
                self.assertTrue(any("隐藏的列 / 行" in w for w in report["warnings"]))
        details = script_tabular.read_workbook_detail(
            self.workbook(REAL_TABLE, hidden_columns={"视频脚本": [3]}, hidden_rows={"视频脚本": [2]}))
        self.assertEqual(details[0].hidden, ("第 D 列", "第 3 行"))
        report, _ = self.run_table(REAL_TABLE, three_shot_plan(first_card=None))
        self.assertEqual(report["tier"], "certain")                       # 对照：不隐藏就是确定档

    def test_a_csv_that_falls_back_to_the_text_route_folds_card_breaks(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        table = Path(directory.name) / "t.csv"
        table.write_text("分镜,口播,上屏文字\n1,先看来料。,来料卡\n2,再看抓取。,\n", encoding="utf-8")
        prose = Path(directory.name) / "p.csv"
        prose.write_text("分镜 1\n上屏文字：来料卡\n分镜 2\n上屏文字：抓取卡\n", encoding="utf-8")
        self.assertTrue(scf.is_table_script(table))
        self.assertFalse(scf.is_table_script(prose))
        self.assertTrue(scf.is_table_script(self.workbook(REAL_TABLE)))
        self.assertFalse(scf.is_table_script(Path(directory.name) / "x.md"))


# ----------------------------------------------------------------------------
# 2026-09-23 用户拍板：标签不上屏，但按标签选卡片版式（`card_layout`）
# ----------------------------------------------------------------------------

LAYOUT_HEADER = ["拍", "时间码(入)", "时间码(出)", "时长s", "段落", "中文旁白", "英文旁白",
                 "屏字/大字", "画面(素材文件,相对资料包根目录)", "取段", "原创图层", "处理要求",
                 "事实编号", "备注"]
LAYOUT_CARDS = ["大字：抓起来、放进去？\n副行：决定成败的其实是三件事",
                "大字：路一\n大字：路二",
                "01 料的呈现\n料盘 / 旋转料仓 · 人工预放 · 位置固定",
                "大字：5 个误区",
                "决策树：节拍 · 工件重量\n→ 料盘式单元 ｜ → 整线"]
LAYOUT_VOICES = ["机器人给机床上下料，看起来就是抓起来、放进去。", "第二镜的旁白足够确认镜号。",
                 "第一件事，料怎么呈现。毛坯不能乱堆。", "第四镜的旁白足够确认镜号。",
                 "最后一镜的旁白足够确认镜号。"]
LAYOUT_EXPECTED = ["headline_sub", "equal_lines", None, None, "equal_lines"]


# ----------------------------------------------------------------------------
# 2026-09-23 第三次复审：阻断 B1（逐行占位）/ B2（首镜之前的内容行）与建议 2–6
# 每条都要求 plan 逐字节不变——这一轮的修复只允许往「少改 / 不改」走。
# ----------------------------------------------------------------------------

H4 = ["分镜号", "口播", "上屏文字", "卡片样式"]


class ThirdReviewTests(unittest.TestCase, TableWorkbookMixin, TempScriptMixin):
    def run_table(self, rows, plan, **kwargs):
        before = dumps(plan)
        report = scf.reconcile(plan, self.workbook(rows, **kwargs))
        return report, before

    def assert_untouched(self, report, plan, before, tier="certain"):
        self.assertEqual(report["tier"], tier)
        self.assertEqual(report["corrections"], [])
        self.assertEqual(dumps(plan), before)
        self.assertNotIn("card_layout", dumps(plan))

    # ---- 阻断 B1：上屏列里某一行是占位，而整格不是 ------------------------------

    B1_SHAPES = {
        # 原文                          模型合理输出（丢掉占位行）
        "大字：抓取卡\n副行：（不填）": "抓取卡",
        "大字：抓取卡\n副行：——": "抓取卡",
        "大字：——\n副行：抓取三要素": "抓取三要素",
        "抓取卡\n无": "抓取卡",
    }

    def test_b1_a_placeholder_line_inside_a_real_card_is_warn_only(self):
        """4775b9a 把这四种都「纠正」成带占位行的两行卡（前三种还带 headline_sub），且无告警。"""
        for cell, model in self.B1_SHAPES.items():
            with self.subTest(cell=cell):
                rows = [H4, ["1", V3[0], cell, ""], ["2", V3[1], "", ""], ["3", V3[2], "", ""]]
                plan = voice_plan([model, None, None])
                report, before = self.run_table(rows, plan)
                self.assert_untouched(report, plan, before)
                self.assertTrue(any(w.startswith("分镜 1 的 card_content") and "占位" in w
                                    for w in report["warnings"]), report["warnings"])
                blocks, _status, _info = self.blocks_of(rows)
                entry = blocks[0]["card_content"]
                self.assertFalse(entry["reliable"])
                self.assertIsNone(entry["layout"])
                self.assertIn("占位", entry["doubt"])

    def test_b1_a_copied_placeholder_line_is_flagged_not_changed(self):
        """模型照抄了占位行：两边一致，不改、不带版式，但要提醒（那一行会原样上屏）。"""
        for cell in self.B1_SHAPES:
            with self.subTest(cell=cell):
                rows = [H4, ["1", V3[0], cell, ""], ["2", V3[1], "", ""], ["3", V3[2], "", ""]]
                copied = scf.script_value(cell, "card_content", preserve_layout=True)
                plan = voice_plan([copied, None, None])
                report, before = self.run_table(rows, plan)
                self.assert_untouched(report, plan, before)
                self.assertTrue(any(w.startswith("分镜 1 的 card_content 与脚本原文一致") for w in report["warnings"]))

    def test_b1_a_placeholder_explanation_is_warn_only_for_rewrites_too(self):
        """说明文字不只拦 missing；模型改写或照抄时也只告警、绝不带版式。"""
        for cell, model in (("大字：抓取卡\n副行：不上屏（本镜）", "抓取卡"),
                            ("不上屏（本镜）", "安全第一"),
                            ("此镜不填写", "安全第一"),
                            ("本镜不上屏文字", "安全第一"),
                            ("此镜不填写内容", "X"),
                            ("留空即可", "X")):
            with self.subTest(cell=cell, model=model):
                rows = [H4, ["1", V3[0], cell, ""], ["2", V3[1], "", ""], ["3", V3[2], "", ""]]
                plan = voice_plan([model, None, None])
                report, before = self.run_table(rows, plan)
                self.assert_untouched(report, plan, before)
                self.assertTrue(any(w.startswith("分镜 1 的 card_content") and "说明" in w
                                    for w in report["warnings"]), report["warnings"])

    def test_b1_a_copied_placeholder_explanation_is_flagged_not_changed(self):
        cell = "大字：抓取卡\n副行：不上屏（本镜）"
        rows = [H4, ["1", V3[0], cell, ""], ["2", V3[1], "", ""], ["3", V3[2], "", ""]]
        plan = voice_plan(["抓取卡\n不上屏（本镜）", None, None])
        report, before = self.run_table(rows, plan)
        self.assert_untouched(report, plan, before)
        self.assertTrue(any(w.startswith("分镜 1 的 card_content 与脚本原文一致") and "说明" in w
                            for w in report["warnings"]), report["warnings"])

    def test_b1_placeholder_hint_substrings_cover_missing_rewritten_and_copied(self):
        for cell in ("本镜不上屏文字", "此镜不填写内容", "留空即可",
                     "大字：抓取卡\n副行：留空即可"):
            for model in (None, "X", scf.script_value(cell, "card_content", preserve_layout=True)):
                with self.subTest(cell=cell, model=model):
                    rows = [H4, ["1", V3[0], cell, ""], ["2", V3[1], "", ""], ["3", V3[2], "", ""]]
                    plan = voice_plan([model, None, None])
                    report, before = self.run_table(rows, plan)
                    self.assert_untouched(report, plan, before)
                    self.assertTrue(any(w.startswith("分镜 1 的 card_content") for w in report["warnings"]),
                                    report["warnings"])

    def test_b1_whole_placeholders_and_real_two_line_cards_are_unchanged(self):
        """对照：整格确定占位仍是「没写」；每行都是占位但整格不在确定写法里的，只告警；
        真两行卡、副行留空（`副行：`）照常确定并带版式。"""
        rows = [H4, ["1", V3[0], "大字：（不填）", ""], ["2", V3[1], "", ""], ["3", V3[2], "", ""]]
        blocks, _status, _info = self.blocks_of(rows)
        self.assertEqual(blocks[0]["card_content"]["value"], "")      # 剥完标签是确定占位 = 没写
        self.assertTrue(blocks[0]["card_content"]["reliable"])
        rows = [H4, ["1", V3[0], "大字：——\n副行：（不填）", ""], ["2", V3[1], "", ""], ["3", V3[2], "", ""]]
        blocks, _status, _info = self.blocks_of(rows)
        self.assertFalse(blocks[0]["card_content"]["reliable"])         # 像占位：不清、不补
        for model in (None, "抓取卡"):
            plan = voice_plan([model, None, None])
            report, before = self.run_table(rows, plan)
            self.assert_untouched(report, plan, before)
        rows = [H4, ["1", V3[0], "大字：抓起来\n副行：三件事", ""], ["2", V3[1], "", ""], ["3", V3[2], "", ""]]
        plan = voice_plan(["抓起来 三件事", None, None])
        report, _before = self.run_table(rows, plan)
        self.assertEqual([(c["shot"], c["kind"]) for c in report["corrections"]], [(1, "rewritten")])
        self.assertEqual(plan["shots"][0]["card_content"], "抓起来\n三件事")
        self.assertEqual(plan["shots"][0]["card_layout"], "headline_sub")
        blocks, _status, _info = self.blocks_of(
            [H4, ["1", V3[0], "大字：抓起来\n副行：", ""], ["2", V3[1], "", ""], ["3", V3[2], "", ""]])
        self.assertTrue(blocks[0]["card_content"]["reliable"])
        self.assertEqual(blocks[0]["card_content"]["value"], "抓起来")

    def test_b1_whole_explanation_placeholders_still_clear_invented_cards(self):
        """R1 只拦说明正文；整格确定占位仍表示作者没写，必须清掉模型臆造。"""
        for cell in ("不上屏", "不填写", "（不填）", "大字：不上屏"):
            with self.subTest(cell=cell):
                rows = [H4, ["1", V3[0], cell, ""], ["2", V3[1], "", ""], ["3", V3[2], "", ""]]
                plan = voice_plan(["模型臆造卡", None, None])
                report, _before = self.run_table(rows, plan)
                self.assertEqual([(c["shot"], c["kind"]) for c in report["corrections"]], [(1, "invented")])
                self.assertNotIn("card_content", plan["shots"][0])
                self.assertNotIn("card_layout", plan["shots"][0])

    # ---- 阻断 B2：第一个镜号之前的内容行 -----------------------------------------

    def test_b2_rows_before_the_first_shot_number_make_the_table_warn_only(self):
        """4775b9a 静默跳过这些行；模型把片头并进第 1 镜给卡，确定档再把卡当臆造删掉。"""
        shapes = {
            "片头行": ([H4, ["片头", "欢迎来到本期", "大字：欢迎", ""]], "欢迎", "欢迎来到本期" + V3[0]),
            "镜号空": ([H4, ["", "开场白一句", "大字：开场卡", ""]], "开场卡", V3[0]),
            "1a 后接 1": ([H4, ["1a", V3[0], "大字：A句\n副行：B句", ""]], "A句", V3[0]),
        }
        for label, (head, card, voice) in shapes.items():
            with self.subTest(shape=label):
                rows = head + [["1", V3[0], "", ""], ["2", V3[1], "", ""], ["3", V3[2], "", ""]]
                plan = voice_plan([card, None, None], voices=[voice, V3[1], V3[2]])
                report, before = self.run_table(rows, plan)
                self.assertEqual(report["status"], "skipped:uncertain")
                self.assert_untouched(report, plan, before, tier="warn_only")
                self.assertTrue(any("第一个分镜号之前" in w for w in report["warnings"]))

    def test_b2_blank_rows_or_a_time_only_row_before_the_first_shot_are_fine(self):
        """对照：表头和第 1 镜之间只有空行 / 只写了时长，不算片头，仍是确定档。"""
        header = ["分镜号", "时长", "口播", "上屏文字"]
        body = [["1", "3", V3[0], "来料卡"], ["2", "3", V3[1], ""], ["3", "3", V3[2], ""]]
        for label, extra in {"空行": [[]], "只有时长": [["", "12", "", ""]]}.items():
            with self.subTest(shape=label):
                plan = voice_plan(["来料卡", None, None])
                report, before = self.run_table([header] + extra + body, plan)
                self.assert_untouched(report, plan, before)

    # ---- 建议 2：超长格子截断 -----------------------------------------------------

    def test_a_truncated_cell_is_warn_only(self):
        big = "很" * (script_tabular.MAX_CELL_CHARS + 5) + "尾"
        for shared in (True, False):
            with self.subTest(shared=shared):
                rows = [H4, ["1", V3[0], big, ""], ["2", V3[1], "", ""], ["3", V3[2], "", ""]]
                plan = voice_plan(["x", None, None])
                report, before = self.run_table(rows, plan, shared=shared)
                self.assert_untouched(report, plan, before)
                self.assertTrue(any("截断" in w for w in report["warnings"]), report["warnings"])
        path = self.write_script("分镜,口播,上屏文字\n1,%s,%s\n2,%s,\n3,%s,\n" % (V3[0], big, V3[1], V3[2]),
                                 name="s.csv")
        grid = script_tabular.read_csv_grid(path)
        self.assertEqual(script_tabular.cell_kind(grid[1][2]), "truncated")
        plan = voice_plan(["x", None, None])
        before = dumps(plan)
        report = scf.reconcile(plan, path)
        self.assertEqual((report["tier"], report["corrections"], dumps(plan)), ("certain", [], before))
        # 普通长度的格子不打标记
        self.assertEqual(script_tabular.cell_kind(grid[1][1]), "")

    def test_a_truncated_docx_paragraph_gives_up_on_the_whole_file(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = write_docx(Path(directory.name) / "s.docx",
                          ["分镜 1", "上屏文字：" + "很" * script_tabular.MAX_CELL_CHARS, "分镜 2", "上屏文字：乙"])
        self.assertIsNone(script_tabular.read_docx_text(path))

    # ---- 建议 3：占位收窄 --------------------------------------------------------

    def test_placeholder_is_only_the_exact_set_and_bare_symbols(self):
        for value in ("（不填）", "「无」", "“无”", "N/A", "Ｎ／Ａ", " none ", "（ 空白 ）", "不上屏", "——", "— —"):
            with self.subTest(exact=value):
                self.assertTrue(scf.is_placeholder(value))
        for value in ("没有！", "None.", "空 空", "——（不填）", "无。"):
            with self.subTest(looks_like=value):
                self.assertFalse(scf.is_placeholder(value))
                self.assertTrue(scf.looks_like_placeholder(value))
        for value in ("—3%", "/分钟", "无人化", "无需人工", "不填充", "留空率", "不上屏幕", "不上屏（本镜）"):
            with self.subTest(real=value):
                self.assertFalse(scf.is_placeholder(value))
                self.assertFalse(scf.looks_like_placeholder(value))

    def test_a_placeholder_lookalike_is_never_cleared_nor_supplied(self):
        """「没有！」可能是作者正文：plan 有卡不删，plan 留空不补，一律只告警。"""
        for value in ("没有！", "None.", "空 空"):
            for model in (None, "抓取卡", value):
                with self.subTest(value=value, model=model):
                    rows = [H4, ["1", V3[0], value, ""], ["2", V3[1], "", ""], ["3", V3[2], "", ""]]
                    plan = voice_plan([model, None, None])
                    report, before = self.run_table(rows, plan)
                    self.assert_untouched(report, plan, before)
                    if model:
                        self.assertTrue(any(w.startswith("分镜 1 的 card_content") and "像占位" in w
                                            for w in report["warnings"]), report["warnings"])
        # 不含说明子串的真正文照常补。
        for value in ("—3%", "/分钟"):
            with self.subTest(real=value):
                rows = [H4, ["1", V3[0], value, ""], ["2", V3[1], "", ""], ["3", V3[2], "", ""]]
                plan = voice_plan(["别的卡", None, None])
                report, _before = self.run_table(rows, plan)
                self.assertEqual([(c["shot"], c["kind"]) for c in report["corrections"]], [(1, "rewritten")])
                self.assertEqual(plan["shots"][0]["card_content"], value)
        # 仍不算占位，但 51338403 起含说明子串就按疑点只告警：不清、不改、不带版式。
        for value in ("不填充", "留空率", "不上屏幕"):
            for model in ("别的卡", value):
                with self.subTest(explanation_substring=value, model=model):
                    self.assertFalse(scf.is_placeholder(value))
                    rows = [H4, ["1", V3[0], value, ""], ["2", V3[1], "", ""], ["3", V3[2], "", ""]]
                    plan = voice_plan([model, None, None])
                    report, before = self.run_table(rows, plan)
                    self.assert_untouched(report, plan, before)
                    self.assertTrue(any(w.startswith("分镜 1 的 card_content") and "说明" in w
                                        for w in report["warnings"]), report["warnings"])
        # 确定占位仍然清掉 plan 里凭空造的卡（既有口径不变）
        rows = [H4, ["1", V3[0], "「无」", ""], ["2", V3[1], "", ""], ["3", V3[2], "", ""]]
        plan = voice_plan(["凭空的卡", None, None])
        report, _before = self.run_table(rows, plan)
        self.assertEqual([(c["shot"], c["kind"]) for c in report["corrections"]], [(1, "invented")])
        self.assertNotIn("card_content", plan["shots"][0])

    # ---- 建议 4：不带冒号的标签 ----------------------------------------------------

    def test_a_label_without_a_colon_is_warn_only(self):
        for cell in ("大字 A句\n副行 B句", "大字　A句", "大字：A句\n副行 B句", "**大字** A句"):
            for model in ("A句\nB句", cell):
                with self.subTest(cell=cell, model=model):
                    rows = [H4, ["1", V3[0], cell, ""], ["2", V3[1], "", ""], ["3", V3[2], "", ""]]
                    plan = voice_plan([model, None, None])
                    report, before = self.run_table(rows, plan)
                    self.assert_untouched(report, plan, before)
                    self.assertTrue(any("没写冒号" in w for w in report["warnings"]), report["warnings"])
        # 「大字报」这种不带空白的不算标签
        self.assertEqual(scf.field_doubt("大字报的年代", "card_content", preserve_layout=True), "")

    # ---- 建议 5：只剥成对包住整行的星号 ---------------------------------------------

    def test_edge_marks_only_strip_a_pair_around_the_whole_line(self):
        cases = {
            "**安全第一**": "安全第一",
            "** 安全第一": "安全第一",              # `**上屏文字：** 安全第一` 留下的落单标记
            "**抓取**卡与**放置**": "**抓取**卡与**放置**",
            "抓取**卡与**放置": "抓取**卡与**放置",
            "__A__": "A",
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(scf._strip_edge_marks(raw), expected)
        self.assertEqual(scf.script_value("大字：**抓取**卡与**放置**", "card_content", preserve_layout=True),
                         "**抓取**卡与**放置**")
        self.assertEqual(scf.script_value("**大字：A句**", "card_content", preserve_layout=True), "A句")
        # 中间粗体：不拆，也不照它改 plan（只告警）
        rows = [H4, ["1", V3[0], "大字：**抓取**卡与**放置**", ""], ["2", V3[1], "", ""], ["3", V3[2], "", ""]]
        plan = voice_plan(["抓取卡与放置", None, None])
        report, before = self.run_table(rows, plan)
        self.assert_untouched(report, plan, before)
        self.assertTrue(any("粗体" in w for w in report["warnings"]))

    def test_paired_markdown_in_title_and_hint_is_warn_only(self):
        for field, value, model in (("title", "**来料**与**到位**", "来料与到位"),
                                    ("card_hint", "**参数**与**列表**", "参数与列表")):
            with self.subTest(field=field):
                header = ["分镜号", "口播", "上屏文字", "卡片样式", "分镜标题"]
                row = ["1", V3[0], "抓取卡", value if field == "card_hint" else "",
                       value if field == "title" else ""]
                rows = [header, row, ["2", V3[1], "", "", ""], ["3", V3[2], "", "", ""]]
                plan = voice_plan(["抓取卡", None, None])
                plan["shots"][0][field] = model
                report, before = self.run_table(rows, plan)
                self.assert_untouched(report, plan, before)
                self.assertTrue(any(w.startswith(f"分镜 1 的 {field}") and "粗体" in w
                                    for w in report["warnings"]), report["warnings"])

    def test_placeholder_hint_substrings_in_title_and_hint_are_warn_only(self):
        for field, value in (("title", "本镜不上屏文字"), ("card_hint", "此镜不填写内容"),
                             ("title", "留空即可"), ("card_hint", "不上屏幕")):
            for model in ("X", value):
                with self.subTest(field=field, value=value, model=model):
                    header = ["分镜号", "口播", "上屏文字", "卡片样式", "分镜标题"]
                    row = ["1", V3[0], "抓取卡", value if field == "card_hint" else "",
                           value if field == "title" else ""]
                    rows = [header, row, ["2", V3[1], "", "", ""], ["3", V3[2], "", "", ""]]
                    plan = voice_plan(["抓取卡", None, None])
                    plan["shots"][0][field] = model
                    report, before = self.run_table(rows, plan)
                    self.assert_untouched(report, plan, before)
                    self.assertTrue(any(w.startswith(f"分镜 1 的 {field}") and "说明" in w
                                        for w in report["warnings"]), report["warnings"])

    # ---- 建议 6：「不上屏 / 不填 / 留空」提醒按整词 -----------------------------------

    def test_the_explanation_reminder_matches_whole_words_only(self):
        for card, expect in (("不填充的区域", False), ("留空率 3%", False), ("不上屏幕", False),
                             ("此镜不填", True), ("此镜不填写", True),
                             ("不上屏（本镜）", True), ("这里留空", True)):
            with self.subTest(card=card):
                rows = [H4, ["1", V3[0], card, ""], ["2", V3[1], "", ""], ["3", V3[2], "", ""]]
                plan = voice_plan([card, None, None])
                report, before = self.run_table(rows, plan)
                self.assertEqual(report["corrections"], [])
                self.assertEqual(dumps(plan), before)
                reminded = any("里有「不上屏 / 不填 / 留空」字样" in w for w in report["warnings"])
                self.assertEqual(reminded, expect, report["warnings"])


def load_template_packaging_at(revision: str):
    """把某个提交的 template_packaging.py 以另一个模块名载进来；拿不到（无 git）返回 None。"""
    import importlib.util
    import subprocess

    try:
        source = subprocess.run(
            ["git", "-C", str(Path(__file__).resolve().parents[2]), "show",
             f"{revision}:VideoAutoCut/tools/template_packaging.py"],
            capture_output=True, text=True, encoding="utf-8", check=False)
    except OSError:
        return None
    if source.returncode != 0 or not source.stdout.strip():
        return None
    with tempfile.TemporaryDirectory() as root:
        path = Path(root) / f"template_packaging_{revision}.py"
        path.write_text(source.stdout, encoding="utf-8")
        spec = importlib.util.spec_from_file_location(f"template_packaging_{revision}", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module


class ScriptLayoutTests(unittest.TestCase, TableWorkbookMixin):
    def layout_workbook(self, cards=LAYOUT_CARDS, extra_rows=()):
        rows = [LAYOUT_HEADER] + [
            [str(i + 1), "0:00", "0:11", Number("11"), "段", LAYOUT_VOICES[i], "EN", cards[i],
             "a.mp4", "t1", f"图层{i + 1}", "", "—", ""] for i in range(len(cards))]
        return self.workbook(rows + list(extra_rows))

    def model_plan(self, cards=None, voices=LAYOUT_VOICES) -> dict:
        """模型照提示词剥掉标签后逐字照抄的 plan。"""
        cards = cards or [scf.script_value(c, "card_content", preserve_layout=True) for c in LAYOUT_CARDS]
        return plan_with(*[{"shot": i + 1, "title": f"分镜{i + 1}", "voice_text": voices[i],
                            "card_content": cards[i], "card_hint": f"图层{i + 1}"}
                           for i in range(len(cards))])

    def test_layout_is_derived_only_from_script_labels(self):
        cases = {
            "大字：A\n副行：B": "headline_sub", "大字：A\n小字：B\n小字：C": "headline_sub",
            "A\n副行：B": "headline_sub", "大字：A\n大字：B": "equal_lines",
            "参数卡：A\nB": "equal_lines", "决策树：A\n→ B": "equal_lines",
            "A\nB": None, "大字：A": None, "参数卡：A": None, "大字：A\nB": None,
            "副行：A\n大字：B": None, "大字：A\n副行：": None, "大字：A\n对接：B": None,
            "": None, "——": None,
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(scf.layout_from_labels(raw), expected)

    def test_a_certain_table_writes_card_layout_for_labelled_shots_only(self):
        plan = self.model_plan()
        report = scf.reconcile(plan, self.layout_workbook())
        self.assertEqual(report["tier"], "certain")
        self.assertEqual(report["corrections"], [])          # 文字一个没改
        self.assertEqual([shot.get("card_layout") for shot in plan["shots"]], LAYOUT_EXPECTED)
        self.assertEqual(report["layouts"], [{"shot": 1, "card_layout": "headline_sub"},
                                             {"shot": 2, "card_layout": "equal_lines"},
                                             {"shot": 5, "card_layout": "equal_lines"}])
        # 模型照抄了标签：文字按原文纠正，版式一样带上
        copied = self.model_plan(cards=list(LAYOUT_CARDS))
        report = scf.reconcile(copied, self.layout_workbook())
        self.assertEqual([c["shot"] for c in report["corrections"]], [1, 2, 4, 5])
        self.assertEqual([shot.get("card_layout") for shot in copied["shots"]], LAYOUT_EXPECTED)
        self.assertEqual(copied["shots"][0]["card_content"], "抓起来、放进去？\n决定成败的其实是三件事")

    def test_no_layout_when_anything_is_uncertain(self):
        cases = {
            "warn_only": (self.layout_workbook(extra_rows=[[], ["序号", "分镜标题", "上屏文字"]]), {}, None),
            "autofix_off": (self.layout_workbook(), {"autofix": False}, None),
            "shot_1_voice_mismatch": (self.layout_workbook(), {}, 0),
        }
        for label, (path, kwargs, mismatch) in cases.items():
            with self.subTest(case=label):
                voices = list(LAYOUT_VOICES)
                if mismatch is not None:
                    voices[mismatch] = "完全不相干的另一段旁白内容。"
                plan = self.model_plan(voices=voices)
                scf.reconcile(plan, path, **kwargs)
                layouts = [shot.get("card_layout") for shot in plan["shots"]]
                if mismatch is None:
                    self.assertEqual(layouts, [None] * 5)
                else:
                    self.assertEqual(layouts, [None] + LAYOUT_EXPECTED[1:])

    def test_the_model_cannot_supply_card_layout_and_the_schema_passes_it_through(self):
        import normalize_script
        import shot_plan_schema

        self.assertEqual(scf.CARD_LAYOUTS, shot_plan_schema.CARD_LAYOUTS)
        raw = {"shots": [{"title": "a", "voice_text": "口播。", "download_query": "q",
                          "card_content": "甲\n乙", "card_layout": "headline_sub"}]}
        compact = normalize_script.compact_plan(raw, "t", preserve_card_layout=True)
        self.assertNotIn("card_layout", compact["shots"][0])            # 模型给的一律不收
        kept = shot_plan_schema.normalize_shot_plan(
            {"shots": [{"title": "a", "card_content": "甲\n乙", "card_layout": "headline_sub"},
                       {"title": "b", "card_content": "甲\n乙", "card_layout": "banner"},
                       {"title": "c", "card_layout": "equal_lines"}]})
        self.assertEqual([shot.get("card_layout") for shot in kept["shots"]], ["headline_sub", None, None])
        # 校验层写进去的，再过一遍 schema（Rust 读回 / 续跑）也还在
        plan = self.model_plan()
        scf.reconcile(plan, self.layout_workbook())
        again = shot_plan_schema.normalize_shot_plan(plan)
        self.assertEqual([shot.get("card_layout") for shot in again["shots"]], LAYOUT_EXPECTED)


class ScriptLayoutRenderTests(unittest.TestCase):
    SHOT_1 = {"title": "分镜1", "card_content": "抓起来、放进去？\n决定成败的其实是三件事",
              "card_hint": "大字钩子（描边/halo，不压深色底带）"}
    SHOT_6 = {"title": "分镜6", "card_content": "缓存 → 上下料 → 在线检测\n对接：AGV · AMR · 皮带机 · 理料机",
              "card_hint": "流程条"}

    def setUp(self):
        import template_packaging

        self.tp = template_packaging
        patcher = mock.patch.dict(os.environ, {"VIDEOAUTO_PACKAGING_SCRIPT_ONLY": "1"})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_headline_sub_renders_the_big_plus_small_card(self):
        shot = dict(self.SHOT_1, card_layout="headline_sub")
        for width, height in ((1920, 1080), (1080, 1920)):
            with self.subTest(size=(width, height)):
                source, manifest = self.tp.build_composition(shot, width, height, 11.0)
                self.assertEqual(manifest["template"], "headline")
                self.assertEqual((manifest["font_size"], manifest["sub_font_size"]), (54, 36))
                self.assertEqual(manifest["headline_lines"], ["抓起来、放进去？"])
                self.assertEqual(manifest["sub_lines"], ["决定成败的其实是三件事"])
                self.assertEqual(manifest["template_source"], "script_label")
                self.assertIn('<div class="hl">抓起来、放进去？</div><div class="sub">决定成败的其实是三件事</div>',
                              source)
                self.assertIn("#5DE0CF", source)                   # 与 title 卡同一条青色边
                self.assertNotIn("大字", source)
                self.assertNotIn("副行", source)

    def test_equal_lines_keeps_the_existing_two_equal_lines_look(self):
        plain = self.tp.build_composition(dict(self.SHOT_6), 1920, 1080, 11.0)
        labelled = self.tp.build_composition(dict(self.SHOT_6, card_layout="equal_lines"), 1920, 1080, 11.0)
        self.assertEqual(labelled[0], plain[0])                    # html 逐字节相同
        self.assertEqual((labelled[1]["template"], labelled[1]["font_size"]), ("parameters", 42))
        self.assertEqual(labelled[1]["template_source"], "script_label")

    def test_a_headline_that_does_not_fit_falls_back_to_the_existing_layout(self):
        long_sub = "\n".join(["很长的一行副文字用来把卡片撑满" * 2] * 6)
        shot = {"title": "t", "card_content": "大字\n" + long_sub, "card_layout": "headline_sub"}
        source, manifest = self.tp.build_composition(shot, 1920, 1080, 30.0)
        self.assertEqual(manifest["template"], "parameters")
        self.assertGreater(len(manifest["pages"]), 1)
        # 用户后来把内容改成单行：不再是大字+小字，按原规则
        single = self.tp.build_composition({"title": "t", "card_content": "只剩一行",
                                            "card_layout": "headline_sub"}, 1920, 1080, 6.0)
        self.assertEqual(single[1]["template"], "title")

    def test_the_packaging_agent_cannot_override_a_script_layout(self):
        import packaging_agent

        calls = []

        def ask(system, user_text, images, *, timeout):  # noqa: ARG001
            calls.append(user_text)
            return {"show": True, "template": "cta", "reason": "模型想改成 CTA"}

        shot = dict(self.SHOT_1, card_layout="headline_sub")
        with tempfile.TemporaryDirectory() as root, contextlib.redirect_stdout(io.StringIO()):
            plan = packaging_agent.plan_for_shot(shot, directory=Path(root) / "shot1", shot_index=1,
                                                 duration=11, width=1920, height=1080, ask=ask)
            log = json.loads((Path(root) / "shot1" / packaging_agent.LOG_FILE_NAME).read_text("utf-8"))
        self.assertEqual(calls, [])                                # 模型根本没被问
        self.assertEqual((plan["source"], plan["overridden"], plan["show"]),
                         ("script_label", "script_layout", True))
        self.assertEqual(log["script_layout"], "headline_sub")
        # 即使拿到一份 agent 选的版式，脚本版式照样赢
        for layout, expected in (("headline_sub", "headline"), ("equal_lines", "parameters")):
            agent_plan = {"template": "cta", "show": True}
            source, manifest = self.tp.build_composition(dict(self.SHOT_1, card_layout=layout),
                                                         1920, 1080, 11.0, plan=agent_plan)
            self.assertEqual(manifest["template"], expected, layout)
        # 没有标签的镜：agent 照旧能改版式
        _source, manifest = self.tp.build_composition(dict(self.SHOT_1), 1920, 1080, 11.0,
                                                      plan={"template": "cta", "show": True})
        self.assertEqual(manifest["template"], "cta")

    def test_the_agent_is_still_asked_for_shots_without_a_script_layout(self):
        import packaging_agent

        calls = []

        def ask(system, user_text, images, *, timeout):  # noqa: ARG001
            calls.append(user_text)
            return {"show": True, "template": "title", "reason": "ok"}

        env = {"VIDEOAUTO_PYTHON_PROMPT_DIR": str(TOOLS / "prompts"), "PACKAGING_AGENT_CACHE": "0"}
        with tempfile.TemporaryDirectory() as root, contextlib.redirect_stdout(io.StringIO()), \
                mock.patch.dict(os.environ, env):
            plan = packaging_agent.plan_for_shot(dict(self.SHOT_6), directory=Path(root) / "shot6",
                                                 shot_index=6, duration=11, width=1920, height=1080,
                                                 ask=ask)
        self.assertEqual(len(calls), 1)
        self.assertEqual(plan["source"], "agent")

    def test_shots_without_labels_render_byte_identical_to_556210e(self):
        """回归保证：没写任何标签的脚本，画面与 556210e 完全一致（html 与 manifest 逐字节）。"""
        legacy = load_template_packaging_at("556210e")
        if legacy is None:
            # 第三次复审：逐字节回归是放行依据，缺 git 时不许静默跳过（跳过列表里只该有真 lint）
            self.fail("拿不到 556210e 的 template_packaging.py：本条逐字节回归必须在带 git 历史的仓库里跑"
                      "（git 不在 PATH / 浅克隆 / 非仓库布局）")
        samples = [self.SHOT_1, self.SHOT_6, {"title": "t", "card_content": "1 台供料专机 → 2 台 CNC"},
                   {"title": "t", "card_content": "立即咨询", "card_hint": "CTA"},
                   {"title": "t", "card_content": "\n".join(["参数行"] * 14), "card_hint": "参数"}]
        for shot in samples:
            for size in ((1920, 1080), (1080, 1920)):
                for plan in (None, {"template": "title", "show": True}):
                    with self.subTest(shot=shot["card_content"][:8], size=size, plan=plan):
                        self.assertEqual(self.tp.build_composition(dict(shot), *size, 11.0, plan=plan),
                                         legacy.build_composition(dict(shot), *size, 11.0, plan=plan))

    def test_real_hyperframes_lint_accepts_the_headline_card(self):
        """真 lint（大字+小字卡）。四件套齐才跑，否则 skip——与
        `test_packaging_agent.PagedCompositionTests.test_real_hyperframes_lint_accepts_the_paged_composition`
        同一套覆盖键（VIDEOAUTO_NODE_EXE / HYPERFRAMES_CLI / HYPERFRAMES_GSAP / HYPERFRAMES_BROWSER_PATH）。"""
        import shutil
        import subprocess

        try:
            node, cli, gsap, _browser = self.tp.renderer_dependencies(TOOLS.parent)
        except RuntimeError as error:
            self.skipTest(f"没有 HyperFrames 运行组件，跳过真 lint：{error}")
        font = self.tp.bundled_font_directory() / "NotoSansCJKsc-Bold.otf"
        if not font.is_file():
            self.skipTest("缺内置 Noto 字体，跳过真 lint")
        environment = {**os.environ, "HYPERFRAMES_NO_TELEMETRY": "1", "HYPERFRAMES_NO_UPDATE_CHECK": "1"}
        for size in ((1920, 1080), (1080, 1920)):
            source, manifest = self.tp.build_composition(dict(self.SHOT_1, card_layout="headline_sub"),
                                                         *size, 11.0)
            self.assertEqual(manifest["template"], "headline")
            with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as directory:
                work = Path(directory)
                (work / "index.html").write_text(source, encoding="utf-8")
                shutil.copy2(gsap, work / "gsap.min.js")
                shutil.copy2(font, work / font.name)
                completed = subprocess.run([str(node), str(cli), "lint", str(work)],
                                           cwd=work, env=environment, capture_output=True, text=True,
                                           encoding="utf-8", errors="replace", timeout=300)
            self.assertEqual(completed.returncode, 0,
                             f"大字+小字卡没过 lint：\n{completed.stdout}\n{completed.stderr}")
