from __future__ import annotations

import contextlib
import copy
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "VideoAutoCut" / "tools"
sys.path.insert(0, str(TOOLS))

import normalize_script
import optimize_queries
import script_markdown
import script_template


def standard_text(*, version="VAC-SB-1", review="已确认", extra="", number=1) -> str:
    return f"""# 展示标题

说明文字忽略。
## 项目信息
- 模板版本：{version}
- 片名：测试片
- 语言：中文

## 分镜 {number} ｜展示标题
- 段落：开场
- 分镜标题：第一镜
- 时长(秒)：3.2
- 画面内容：机械臂抓箱
- 口播：逐字口播
- 来源/核对：
  {review}
{extra}"""


class ScriptMarkdownTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)

    def write(self, text: str, name="script.md", encoding="utf-8") -> Path:
        path = self.directory / name
        path.write_bytes(text.encode(encoding))
        return path

    def test_m1_detects_only_marked_md_or_txt_and_cli_is_silent_for_unmarked(self):
        for name in ("script.md", "script.txt"):
            self.assertIsNotNone(script_markdown.detect(self.write(standard_text(), name)))
        unmarked = self.write("# 普通稿\n\n这不是标准载体。", "plain.md")
        self.assertIsNone(script_markdown.detect(unmarked))
        fenced = self.write("```md\n## 项目信息\n- 模板版本：VAC-SB-1\n## 分镜 1\n```", "fenced.md")
        self.assertIsNone(script_markdown.detect(fenced))
        completed = subprocess.run(
            [sys.executable, str(TOOLS / "script_markdown.py"), "--check", str(unmarked)],
            capture_output=True,
        )
        self.assertEqual(completed.returncode, 0)
        self.assertEqual(completed.stdout, b"")
        self.assertEqual(completed.stderr, b"")

    def test_m2_wrong_versions_and_all_structural_errors_are_blocked_with_lines(self):
        for version in ("VAC-SB-2", "wrong", ""):
            with self.subTest(version=version):
                match = script_markdown.detect(self.write(standard_text(version=version), f"v-{len(version)}.md"))
                self.assertIsNotNone(match)
                self.assertIn("unsupported_version", {item["code"] for item in match.blocked})
        broken = standard_text(number=2).replace(
            "## 分镜 2 ｜展示标题", "## 分镜 X\n- 分镜标题：被忽略\n\n## 分镜 2 ｜展示标题").replace(
            "- 分镜标题：第一镜", "- 分镜标题：第一镜\n- 分镜标题：重复")
        path = self.write(broken, "broken.md")
        plan, report = script_markdown.import_markdown(path, "测试", script_markdown.detect(path))
        self.assertEqual({"shot_heading_invalid", "shot_no_invalid", "duplicate_field"},
                         {item["code"] for item in report["blocked"]})
        self.assertTrue(all(item["cell"].startswith("第 ") for item in report["blocked"]))
        self.assertEqual(len(plan["shots"]), 1)
        for heading in ("## 分镜", "## 分镜 X", "## 分镜 1 多余字"):
            with self.subTest(heading=heading):
                malformed = standard_text().replace("## 分镜 1 ｜展示标题", heading)
                path = self.write(malformed, f"heading-{len(heading)}.md")
                match = script_markdown.detect(path)
                self.assertIsNotNone(match)
                item = next(item for item in match.blocked if item["code"] == "shot_heading_invalid")
                self.assertRegex(item["cell"], r"^第 \d+ 行$")

    def test_m2_blocked_cli_writes_report_but_never_creates_or_overwrites_plan(self):
        source = self.write(standard_text(version="VAC-SB-2"), "blocked.md")
        report = self.directory / "report.json"
        plan = self.directory / "plan.json"
        plan.write_bytes(b"keep-existing")
        completed = subprocess.run(
            [sys.executable, str(TOOLS / "script_markdown.py"), "--check", str(source),
             "--json", str(report), "--plan", str(plan)], capture_output=True,
        )
        self.assertEqual(completed.returncode, 2)
        self.assertIn("unsupported_version", {item["code"] for item in json.loads(report.read_text(encoding="utf-8"))["blocked"]})
        self.assertEqual(plan.read_bytes(), b"keep-existing")

    def test_m3_multiline_bold_colons_crlf_bom_and_gb18030(self):
        text = standard_text().replace(
            "- 画面内容：机械臂抓箱",
            "- **画面内容**:\n  第一行：保留冒号\n\t第二行 空格  保留\n\n  游离行不拼接",
        ).replace("时长(秒)", "时长（秒）")
        text = "```md\n## 项目信息\n- 模板版本：VAC-SB-9\n## 分镜 99\n```\n" + text
        text = text.replace("\n", "\r\n")
        for encoding, prefix in (("utf-8", b"\xef\xbb\xbf"), ("gb18030", b"")):
            with self.subTest(encoding=encoding):
                path = self.directory / f"encoded-{encoding}.txt"
                path.write_bytes(prefix + text.encode(encoding))
                plan, report = script_markdown.import_markdown(path, "测试")
                self.assertFalse(report["blocked"])
                self.assertEqual(plan["shots"][0]["visual_query"],
                                 "第一行：保留冒号\n第二行 空格  保留")
                self.assertEqual(plan["shots"][0]["duration"], 4)
        for case_index, (version_line, title_line) in enumerate((
            ("- **模板版本：** VAC-SB-1", "- **分镜标题：** 正文**强调**"),
            ("- **模板版本：**VAC-SB-1", "- **分镜标题：**正文**强调**"),
            ("- **模板版本:** VAC-SB-1", "- **分镜标题:** 正文**强调**"),
            ("- **模板版本:**VAC-SB-1", "- **分镜标题:**正文**强调**"),
            ("- **模板版本**：VAC-SB-1", "- **分镜标题**：正文**强调**"),
            ("- **模板版本**:VAC-SB-1", "- **分镜标题**:正文**强调**"),
        )):
            with self.subTest(version_line=version_line, title_line=title_line):
                bold = standard_text().replace("- 模板版本：VAC-SB-1", version_line).replace(
                    "- 分镜标题：第一镜", title_line)
                path = self.write(bold, f"bold-{case_index}.md")
                match = script_markdown.detect(path)
                self.assertIsNotNone(match)
                plan, report = script_markdown.import_markdown(path, "测试", match)
                self.assertFalse(report["blocked"])
                self.assertEqual(plan["shots"][0]["title"], "正文**强调**")
                self.assertEqual(plan["script_source"]["project_info"]["模板版本"], "VAC-SB-1")
                self.assertTrue(all("**" not in key for key in plan["script_source"]["project_info"]))
        for case_index, (voice_line, subtitle_line) in enumerate((
            ("- **口播：** 这是**口播**", "- **字幕：** 这是**字幕**"),
            ("- **口播：**这是**口播**", "- **字幕:**这是**字幕**"),
            ("- **口播:** 这是**口播**", "- **字幕:** 这是**字幕**"),
            ("- **口播** ：这是**口播**", "- **字幕** :这是**字幕**"),
            ("- **口播**:这是**口播**", "- **字幕**：这是**字幕**"),
            ("- 口播：**开头**正文", "- 字幕:**开头**字幕"),
        )):
            with self.subTest(voice_line=voice_line, subtitle_line=subtitle_line):
                text_fields = standard_text().replace("- 口播：逐字口播", voice_line + "\n" + subtitle_line)
                path = self.write(text_fields, f"text-fields-{case_index}.md")
                plan, report = script_markdown.import_markdown(path, "测试")
                self.assertFalse(report["blocked"])
                expected_voice = "**开头**正文" if case_index == 5 else "这是**口播**"
                expected_subtitle = "**开头**字幕" if case_index == 5 else "这是**字幕**"
                self.assertEqual(plan["shots"][0]["voice_text"], expected_voice)
                self.assertEqual(plan["shots"][0]["subtitle"], expected_subtitle)

    def test_m4_ai_suggestions_warn_for_production_and_block_body_or_duration(self):
        production = self.write(standard_text(review="待确认\n  AI建议：景别、运镜、画面内容"), "production.md")
        plan, report = script_markdown.import_markdown(production, "测试")
        self.assertFalse(report["blocked"])
        self.assertEqual(plan["shots"][0]["script_meta"]["review"]["ai_suggested"],
                         ["shot_size", "camera_move", "visual_description"])
        self.assertEqual(3, sum(item["code"] == "ai_suggested" for item in report["warnings"]))
        body = self.write(standard_text(review="AI建议：分镜标题、口播、字幕、上屏文字、时长(秒)"), "body.md")
        _, report = script_markdown.import_markdown(body, "测试")
        pending = [item for item in report["blocked"] if item["code"] == "text_cell_pending"]
        self.assertEqual(5, len(pending))
        self.assertEqual({item["cell"] for item in pending}, {"第 16 行"})

    def test_m5_unknown_keys_are_preserved_as_extra_columns(self):
        path = self.write(standard_text(extra="- 客户自定义：值：仍保留\n"), "extra.md")
        plan, report = script_markdown.import_markdown(path, "测试")
        self.assertEqual(plan["shots"][0]["script_meta"]["extra_columns"], {"客户自定义": "值：仍保留"})
        self.assertIn("extra_columns", {item["code"] for item in report["warnings"]})

    def test_m6_repository_markdown_and_xlsx_are_deep_equal_except_listed_carrier_fields(self):
        base = ROOT / "docs" / "script-template-v1" / "示例_食品码垛_v1"
        xlsx, _ = script_template.import_template(base.with_suffix(".xlsx"), "食品码垛")
        markdown, _ = script_markdown.import_markdown(base.with_suffix(".md"), "食品码垛")

        def comparable(plan):
            result = copy.deepcopy(plan)
            source = result["script_source"]
            for key in ("file_name", "file_sha256", "carrier"):
                source.pop(key, None)
            source["project_info"].pop("项目", None)
            for shot in result["shots"]:
                shot["script_meta"].pop("source", None)
                for warning in shot["script_meta"]["review"]["warnings"]:
                    warning.pop("cell", None)
            return result

        self.assertEqual(comparable(xlsx), comparable(markdown))

        outputs = []
        guarded = [
            mock.patch.object(normalize_script, name, side_effect=AssertionError(name))
            for name in ("upload_script_file", "normalize_with_ai", "review_voice_and_subtitles_with_ai",
                         "review_progress_labels_with_ai", "verify_card_fields", "urlopen_with_retry", "call_qwen")
        ]
        guarded += [mock.patch.object(optimize_queries, "call_qwen", side_effect=AssertionError("optimize qwen")),
                    mock.patch("urllib.request.urlopen", side_effect=AssertionError("urlopen"))]
        calls = [patcher.start() for patcher in guarded]
        self.addCleanup(lambda: [patcher.stop() for patcher in reversed(guarded)])
        for suffix in (".xlsx", ".md"):
            output = self.directory / f"production-{suffix[1:]}.json"
            with mock.patch.object(sys, "argv", ["normalize_script.py", "--input", str(base.with_suffix(suffix)),
                                                  "--output", str(output), "--topic", "食品码垛"]), \
                 contextlib.redirect_stdout(io.StringIO()):
                normalize_script.main()
            outputs.append(json.loads(output.read_text(encoding="utf-8")))
        self.assertTrue(all(item.call_count == 0 for item in calls))
        self.assertEqual(comparable(outputs[0]), comparable(outputs[1]))

    def test_m7_standard_markdown_normalization_never_uploads_or_calls_models_or_urlopen(self):
        source = self.write(standard_text(), "zero-model.md")
        output = self.directory / "shots.json"
        guarded = [
            mock.patch.object(normalize_script, name, side_effect=AssertionError(name))
            for name in ("upload_script_file", "normalize_with_ai", "review_voice_and_subtitles_with_ai",
                         "review_progress_labels_with_ai", "verify_card_fields", "urlopen_with_retry", "call_qwen")
        ]
        guarded += [mock.patch.object(optimize_queries, "call_qwen", side_effect=AssertionError("optimize qwen")),
                    mock.patch("urllib.request.urlopen", side_effect=AssertionError("urlopen"))]
        mocks = [patcher.start() for patcher in guarded]
        self.addCleanup(lambda: [patcher.stop() for patcher in reversed(guarded)])
        with mock.patch.object(sys, "argv", ["normalize_script.py", "--input", str(source),
                                              "--output", str(output), "--topic", "测试"]), \
             contextlib.redirect_stdout(io.StringIO()):
            normalize_script.main()
        self.assertTrue(all(item.call_count == 0 for item in mocks))
        self.assertEqual(json.loads(output.read_text(encoding="utf-8"))["shots"][0]["title"], "第一镜")

        blocked = self.write(standard_text(version="VAC-SB-bad"), "blocked-normalize.md")
        output.write_bytes(b"keep")
        with mock.patch.object(sys, "argv", ["normalize_script.py", "--input", str(blocked),
                                              "--output", str(output)]), \
             contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(SystemExit, "2"):
            normalize_script.main()
        self.assertEqual(output.read_bytes(), b"keep")
        output.unlink()
        with mock.patch.object(sys, "argv", ["normalize_script.py", "--input", str(blocked),
                                              "--output", str(output)]), \
             contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(SystemExit, "2"):
            normalize_script.main()
        self.assertFalse(output.exists())
        self.assertTrue(all(item.call_count == 0 for item in mocks))


if __name__ == "__main__":
    unittest.main()
