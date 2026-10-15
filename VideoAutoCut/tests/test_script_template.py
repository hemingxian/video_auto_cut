#!/usr/bin/env python3
from __future__ import annotations

import contextlib
import copy
import hashlib
import html
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import types
import unittest
import uuid
import zipfile
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "VideoAutoCut" / "tools"
TESTS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))
if str(TESTS) not in sys.path:
    sys.path.insert(0, str(TESTS))

import common
import render_segment
import script_template
import template_packaging
from script_card_fields import reconcile
from script_tabular import MAX_CELL_CHARS, read_sheet_fills, read_workbook_detail
from shot_plan_schema import KNOWN_PLAN_KEYS, KNOWN_SHOT_KEYS, normalize_shot_plan
from xlsx_fixture import Formula, Number, write_xlsx

INFO = [["模板版本", "VAC-SB-1"], ["片名", "测试"]]
HEADERS = script_template.HEADERS
REAL_TEMPLATE_NAMES = [
    "分镜脚本模板_v1.xlsx",
    "分镜脚本示例_上下料_v1.xlsx",
    "转换演示_v1表格.xlsx",
    "转换演示_md文本.xlsx",
    "示例_食品码垛_v1.xlsx",
]
_capture_fixture = None


def template_row(**overrides: object) -> list[object]:
    values: list[object] = ["" for _ in HEADERS]
    defaults: dict[str, object] = {
        "镜号": "1",
        "段落": "段落",
        "分镜标题": "标题",
        "时长(秒)": "2",
        "景别": "全景",
        "运镜": "固定",
        "拍摄角度": "平视",
        "画面内容": "画面",
        "口播": "口播",
        "字幕": "",
        "上屏文字": "大字：主标题\n副行：副标题",
        "卡片提示": "标题卡",
        "推荐素材来源": "素材库",
        "素材要求": "横屏",
        "搜索关键词": "检索词",
        "转场": "硬切",
        "备注": "备注",
        "来源/核对": "已确认",
    }
    defaults.update(overrides)
    for header, value in defaults.items():
        values[HEADERS.index(header)] = value
    return values


def write_template(
    path: Path,
    rows: list[list[object]] | None = None,
    *,
    headers: list[str] | None = None,
    fills: dict[str, dict[str, str]] | None = None,
    merges: dict[str, list[str]] | None = None,
    hidden_rows: dict[str, list[int]] | None = None,
    hidden_columns: dict[str, list[int]] | None = None,
    info: list[list[object]] | None = None,
) -> Path:
    shot_rows = [template_row()] if rows is None else rows
    result = write_xlsx(
        path,
        [
            ("项目信息", INFO if info is None else info),
            ("分镜脚本", [(HEADERS if headers is None else headers), *shot_rows]),
        ],
        fills=fills,
        merges=merges,
        hidden_rows=hidden_rows,
        hidden_columns=hidden_columns,
    )
    if _capture_fixture is not None:
        _capture_fixture(result)
    return result


def rewrite_zip_member(path: Path, member: str, transform) -> None:
    with zipfile.ZipFile(path, "r") as archive:
        entries = [(item, archive.read(item.filename)) for item in archive.infolist()]
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for item, payload in entries:
            archive.writestr(item, transform(payload) if item.filename == member else payload)
    if _capture_fixture is not None:
        _capture_fixture(path)


def issue_codes(report: dict, key: str) -> list[str]:
    return [item["code"] for item in report[key]]


def vacut_events(stdout: str) -> list[dict]:
    prefix = "VACUT_EVENT:"
    return [json.loads(line[len(prefix):]) for line in stdout.splitlines() if line.startswith(prefix)]


class ScriptTemplateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.audited_fixture_states = 0
        cls.baseline_directory = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.baseline_directory.cleanup)
        archive = subprocess.run(
            ["git", "archive", "--format=tar", "a29d74f", "VideoAutoCut/tools", "VideoAutoCut/config"],
            cwd=ROOT, check=True, capture_output=True,
        ).stdout
        cls.baseline_root = Path(cls.baseline_directory.name)
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as bundle:
            bundle.extractall(cls.baseline_root)

    @classmethod
    def tearDownClass(cls) -> None:
        print(f"N1 audited generated fixture states against a29d74f: {cls.audited_fixture_states}")

    def setUp(self) -> None:
        global _capture_fixture
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary_directory.name)
        self.fixture_snapshots = self.directory / "fixture-snapshots"
        self.fixture_snapshots.mkdir()
        self.fixture_snapshot_count = 0

        def capture(path: Path) -> None:
            self.fixture_snapshot_count += 1
            target = self.fixture_snapshots / f"{self.fixture_snapshot_count:03d}{path.suffix.lower()}"
            shutil.copyfile(path, target)

        _capture_fixture = capture

    def _assert_cli_matches_a29d74f(self, input_path: Path, label: str) -> None:
        if self.directory in input_path.parents:
            type(self).audited_fixture_states += 1
        implementations = (
            self.baseline_root / "VideoAutoCut" / "tools" / "script_template.py",
            TOOLS / "script_template.py",
        )
        results = []
        for index, implementation in enumerate(implementations):
            output_dir = self.directory / f"baseline-{label}-{index}"
            output_dir.mkdir()
            report_path = output_dir / "report.json"
            plan_path = output_dir / "plan.json"
            completed = subprocess.run(
                [sys.executable, "-I", "-B", "-X", "utf8", str(implementation),
                 "--check", str(input_path), "--json", str(report_path),
                 "--plan", str(plan_path)],
                cwd=ROOT, capture_output=True,
            )
            results.append((
                completed.returncode, completed.stdout, completed.stderr,
                report_path.read_bytes() if report_path.exists() else None,
                plan_path.read_bytes() if plan_path.exists() else None,
            ))
        self.assertEqual(results[0], results[1], f"a29d74f CLI mismatch for {input_path}")

    def test_step1_script_spec_is_the_single_field_contract(self) -> None:
        import script_spec

        self.assertEqual(tuple(HEADERS), script_spec.FIELD_NAMES)
        self.assertEqual({
            "镜号": "shot", "段落": "module_label", "分镜标题": "title", "时长(秒)": "duration",
            "景别": "shot_size", "运镜": "camera_move", "拍摄角度": "camera_angle",
            "画面内容": "visual_description", "口播": "voice_text", "字幕": "subtitle",
            "上屏文字": "card_content", "卡片提示": "card_hint", "推荐素材来源": "material_source",
            "素材要求": "material_requirements", "搜索关键词": "search_keywords",
            "转场": "transition", "备注": "notes", "来源/核对": "review",
        }, script_spec.FIELD_KEY_BY_NAME)
        self.assertEqual({"分镜标题", "口播", "字幕", "上屏文字"},
                         script_spec.BODY_FIELD_NAMES)
        self.assertEqual({"title", "voice_text", "subtitle", "card_content"},
                         script_spec.BODY_FIELD_KEYS)
        self.assertIs(script_template.HEADERS, script_spec.HEADERS)
        self.assertIs(script_template.DICTIONARIES, script_spec.DICTIONARIES)
        self.assertTrue(script_spec.is_placeholder("—", "card_content"))
        self.assertFalse(script_spec.is_placeholder("无人化产线", "card_content"))

    def test_step1_xlsx_cli_outputs_match_a29d74f_byte_for_byte(self) -> None:
        inputs = [ROOT / "docs" / "script-template-v1" / name for name in REAL_TEMPLATE_NAMES]
        for index, input_path in enumerate(inputs):
            with self.subTest(input=input_path.name):
                self._assert_cli_matches_a29d74f(input_path, f"real-{index}")

    def test_food_subtitles_and_cards_preserve_text_under_s2_wrapping(self) -> None:
        """51487839 replaces N3 bytes with the S2 text-preservation contract."""
        plan, _ = script_template.import_template(
            ROOT / "docs" / "script-template-v1" / "示例_食品码垛_v1.xlsx", "模板任务")
        plan_path = self.directory / "food-render-plan.json"
        plan_path.write_text(json.dumps(plan, ensure_ascii=False), encoding="utf-8")
        layout = render_segment.subtitle_layout_options()
        terminal = "、，,。！？!?；;：:"

        def expected_ass_line(line: str) -> str:
            match = re.search(r"[^\S\r\n]*$", line)
            suffix = match.group(0) if match else ""
            body = line[:-len(suffix)] if suffix else line
            return body.rstrip(terminal) + suffix

        for index, shot in enumerate(plan["shots"], 1):
            with self.subTest(shot=index):
                source = render_segment.load_render_caption(
                    str(plan_path), index, shot.get("voice_text", ""))
                sentences = common.split_subtitle_sentences(source)
                self.assertEqual("".join(sentences), source, "句子入口不得吞空白或标点")

                wrapped_lines: list[str] = []
                for sentence in sentences:
                    self.assertEqual(sentence, sentence.strip(), "食品夹具不得靠两侧 strip 通过")
                    expected_display = sentence.rstrip(terminal)
                    self.assertEqual(common.subtitle_display_line(sentence), expected_display)
                    pages = common.subtitle_display_pages(
                        sentence,
                        max_chars=render_segment.subtitle_line_max_chars(),
                        max_width=layout["max_width"],
                        font=layout["font"],
                        font_size=layout["font_size"],
                    )
                    pre_display_lines = [line for page in pages for line in page]
                    self.assertEqual("".join(pre_display_lines), expected_display,
                                     "软换行重组必须逐codepoint相等（含U+0020）")
                    wrapped_lines.extend(pre_display_lines)

                events = common.subtitle_events_by_sentence(
                    source,
                    float(shot["duration"]),
                    y=render_segment.subtitle_picture_position(None, True)[0],
                    anchor="bottom",
                    max_chars=render_segment.subtitle_line_max_chars(),
                    line_gap=render_segment.subtitle_line_gap(),
                    **layout,
                )
                actual_lines = []
                for event in events.splitlines():
                    if not event.startswith("Dialogue:"):
                        continue
                    ass_text = event.split(",", 9)[9]
                    actual_lines.append(re.sub(r"\{[^}]*\}", "", ass_text).replace(r"\N", "\n"))
                expected_lines = [expected_ass_line(line) for line in wrapped_lines]
                self.assertEqual(actual_lines, expected_lines,
                                 "ASS只允许执行既有的逐行尾标点删除")

                content = str(shot.get("card_content") or "")
                with mock.patch.dict(os.environ, {"VIDEOAUTO_PACKAGING_SCRIPT_ONLY": "1"}):
                    card = template_packaging.build_composition(
                        shot, 1920, 1080, float(shot["duration"]))
                if content:
                    self.assertIsNotNone(card)
                    card_source, manifest = card
                    self.assertEqual(manifest["content"], content)
                    rendered = "".join(line for page in manifest["pages"] for line in page)
                    expected = content.replace("\r\n", "").replace("\r", "").replace("\n", "")
                    self.assertEqual(rendered, expected,
                                     "真实卡片生成文本除换行位置外必须逐codepoint相等")
                    if manifest["template"] == "headline":
                        head = "<br>".join(html.escape(line) for line in manifest["headline_lines"])
                        sub = "<br>".join(html.escape(line) for line in manifest["sub_lines"])
                        self.assertIn(
                            f'<div class="hl">{head}</div><div class="sub">{sub}</div>',
                            card_source,
                        )
                    else:
                        for page in manifest["pages"]:
                            body = "<br>".join(html.escape(line) for line in page)
                            self.assertIn(f">{body}</div>", card_source)
                else:
                    self.assertIsNone(card)

    def test_legacy_render_ass_still_matches_a29d74f_byte_for_byte(self) -> None:
        card_path = self.directory / "card.ass"
        card_path.write_text(
            "[Script Info]\nScriptType: v4.00+\n[V4+ Styles]\n"
            "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,"
            "Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,"
            "Alignment,MarginL,MarginR,MarginV,Encoding\n"
            "Style: Card,Arial,40,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,"
            "1,1,0,5,0,0,0,1\n[Events]\n"
            "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n"
            "Dialogue: 5,0:00:00.00,0:00:04.00,Card,,0,0,0,,CARD\n",
            encoding="utf-8",
        )
        legacy = {
            "schema_version": 2, "topic": "旧任务", "shots": [{
                "shot": 1, "title": "旧镜", "duration": 4, "voiceover": True,
                "voice_text": "旧口播", "subtitle": "旧字幕", "card_ass": str(card_path),
            }],
        }
        probe = (
            "import json,sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);"
            "import render_segment as r;p=Path(sys.argv[2]);o=Path(sys.argv[3]);"
            "d=json.loads(p.read_text(encoding='utf-8'));s=d['shots'][0];"
            "r.write_combined_ass(r.load_render_caption(str(p),1,s.get('voice_text','')),"
            "r.load_progress_labels(str(p),['fallback']),1,float(s.get('duration',4)),o,"
            "card_ass=r.load_card_ass(str(p),1))"
        )
        for plan_index, plan in enumerate((legacy,)):
            plan_path = self.directory / f"legacy-render-plan-{plan_index}.json"
            plan_path.write_text(json.dumps(plan, ensure_ascii=False), encoding="utf-8")
            outputs = []
            for implementation_index, tools_path in enumerate((
                self.baseline_root / "VideoAutoCut" / "tools", TOOLS,
            )):
                output = self.directory / f"render-{plan_index}-{implementation_index}.ass"
                completed = subprocess.run(
                    [sys.executable, "-I", "-B", "-X", "utf8", "-c", probe,
                     str(tools_path), str(plan_path), str(output)],
                    cwd=ROOT, capture_output=True,
                )
                self.assertEqual(0, completed.returncode, completed.stderr.decode("utf-8", "replace"))
                outputs.append((completed.stdout, completed.stderr, output.read_bytes()))
            self.assertEqual(outputs[0], outputs[1])

    def tearDown(self) -> None:
        global _capture_fixture
        try:
            fixtures = sorted((*self.directory.rglob("*.xlsx"), *self.directory.rglob("*.xlsm")))
            for index, fixture in enumerate(fixtures):
                self._assert_cli_matches_a29d74f(fixture, f"fixture-{index}")
        finally:
            _capture_fixture = None
            self.temporary_directory.cleanup()

    def test_t1_detects_all_real_templates(self) -> None:
        root = ROOT / "docs" / "script-template-v1"
        self.assertEqual(sorted(REAL_TEMPLATE_NAMES), sorted(path.name for path in root.glob("*.xlsx")))
        for name in REAL_TEMPLATE_NAMES:
            with self.subTest(name=name):
                match = script_template.detect(root / name)
                self.assertIsNotNone(match)
                self.assertEqual("VAC-SB-1", match.version)
                self.assertEqual([], match.blocked)

    def test_t1_cli_direct_execution_finds_sibling_modules_in_isolated_mode(self) -> None:
        candidate = write_template(self.directory / "isolated_cli.xlsx")
        report_path = self.directory / "isolated_cli_report.json"
        environment = os.environ.copy()
        environment.pop("PYTHONPATH", None)
        completed = subprocess.run(
            [sys.executable, "-I", "-B", "-X", "utf8", str(TOOLS / "script_template.py"),
             "--check", str(candidate), "--json", str(report_path)],
            cwd=self.directory,
            env=environment,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        self.assertEqual(0, completed.returncode, completed.stderr)
        self.assertTrue(report_path.is_file())
        report = json.loads(report_path.read_text(encoding="utf-8"))
        self.assertEqual("template", report["route"])
        self.assertEqual("VAC-SB-1", report["format"])
        self.assertEqual(1, report["shots"])
        self.assertEqual([], report["blocked"])

    def test_t2_rejects_every_non_template_silently(self) -> None:
        same_headers = self.directory / "same_headers.xlsx"
        write_xlsx(same_headers, [("分镜脚本", [HEADERS, template_row()])])
        marker_elsewhere = self.directory / "marker_elsewhere.xlsx"
        write_xlsx(
            marker_elsewhere,
            [
                ("项目信息", [["片名", "普通表格"]]),
                ("别的 sheet", [["模板版本", "VAC-SB-1"]]),
                ("分镜脚本", [HEADERS, template_row()]),
            ],
        )
        production_counterexample = next(
            (ROOT / "docs" / "packaging-test-scripts-2026-09-21").glob("07_表格版_*.xlsx")
        )
        candidates = [same_headers, marker_elsewhere, production_counterexample]
        for suffix in (".md", ".txt", ".csv", ".docx"):
            candidate = self.directory / f"plain{suffix}"
            candidate.write_bytes(b"not a template")
            candidates.append(candidate)
        bad_zip = self.directory / "bad.xlsx"
        bad_zip.write_bytes(b"not a zip")
        candidates.append(bad_zip)

        for candidate in candidates:
            with self.subTest(candidate=candidate.name):
                stdout = io.StringIO()
                with contextlib.redirect_stdout(stdout):
                    self.assertIsNone(script_template.detect(candidate))
                self.assertEqual("", stdout.getvalue())

        for version in ("V2.3", " OTHER-1 ", "VAC-SB-x"):
            candidate = write_template(
                self.directory / f"foreign_{len(version)}_{version[-1]}.xlsx",
                info=[["模板版本", version]],
            )
            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                self.assertIsNone(script_template.detect(candidate))
            self.assertEqual("", stdout.getvalue())
            completed = subprocess.run(
                [sys.executable, "-B", "-c",
                 "import runpy,sys;sys.path.insert(0,sys.argv.pop(1));runpy.run_path(sys.argv.pop(1),run_name='__main__')",
                 str(TOOLS), str(TOOLS / "script_template.py"), "--check", str(candidate)],
                cwd=TOOLS, check=False, capture_output=True, text=True, encoding="utf-8",
            )
            self.assertEqual((0, "not_template\n", ""),
                             (completed.returncode, completed.stdout, completed.stderr))

    def test_t2_detect_swallows_reader_exceptions(self) -> None:
        candidate = self.directory / "reader_error.xlsx"
        candidate.write_bytes(b"placeholder")
        stdout = io.StringIO()
        with mock.patch.object(script_template, "_sheets", side_effect=RuntimeError("boom")):
            with contextlib.redirect_stdout(stdout):
                self.assertIsNone(script_template.detect(candidate))
        self.assertEqual("", stdout.getvalue())

    def test_t3_recognized_invalid_templates_are_blocked_with_differences(self) -> None:
        unsupported = write_template(
            self.directory / "unsupported.xlsx",
            info=[["模板版本", "VAC-SB-2"]],
        )
        missing_sheet = self.directory / "missing_sheet.xlsx"
        write_xlsx(missing_sheet, [("项目信息", INFO)])
        renamed_headers = HEADERS.copy()
        renamed_headers[4] = "错误景别"
        renamed = write_template(self.directory / "renamed.xlsx", headers=renamed_headers)
        swapped_headers = HEADERS.copy()
        swapped_headers[0], swapped_headers[1] = swapped_headers[1], swapped_headers[0]
        swapped = write_template(self.directory / "swapped.xlsx", headers=swapped_headers)

        expected = {
            unsupported: [("unsupported_version", "", "")],
            missing_sheet: [("missing_sheet", "", "")],
            renamed: [("header_mismatch", "E1", "景别")],
            swapped: [("header_mismatch", "A1", "镜号"), ("header_mismatch", "B1", "段落")],
        }
        for path, expected_issues in expected.items():
            with self.subTest(path=path.name):
                match = script_template.detect(path)
                self.assertIsNotNone(match)
                self.assertEqual(
                    expected_issues,
                    [(item["code"], item["cell"], item["column"]) for item in match.blocked],
                )
                _, report = script_template.import_template(path, "topic", match)
                self.assertTrue(report["blocked"])
                self.assertNotIn("no_shots", issue_codes(report, "blocked"))

    def test_t4_extra_column_is_preserved_with_one_warning(self) -> None:
        path = write_template(
            self.directory / "extra.xlsx",
            headers=[*HEADERS, "音效"],
            rows=[[*template_row(), "咔"]],
        )
        plan, report = script_template.import_template(path, "topic")
        self.assertEqual([], report["blocked"])
        self.assertEqual(["extra_columns"], issue_codes(report, "warnings"))
        self.assertEqual({"音效": "咔"}, plan["shots"][0]["script_meta"]["extra_columns"])

    def test_t5_maps_all_eighteen_columns(self) -> None:
        path = write_template(
            self.directory / "all_columns.xlsx",
            info=[
                ["模板版本", "VAC-SB-1"],
                ["片名", "全列映射"],
                ["画幅", "16:9"],
                ["原始脚本文件名", "source.md"],
                ["原始脚本 SHA-256", "abc123"],
                ["转换方式", "作者手写"],
            ],
            rows=[template_row(**{
                "段落": "开场",
                "分镜标题": "哨兵标题",
                "时长(秒)": "9.5",
                "景别": "特写",
                "运镜": "推",
                "拍摄角度": "俯拍",
                "画面内容": "哨兵画面",
                "口播": "哨兵口播",
                "字幕": "哨兵字幕",
                "上屏文字": "大字：第一行\n副行：第二行",
                "卡片提示": "标题卡",
                "推荐素材来源": "指定素材 A",
                "素材要求": "必须横屏",
                "搜索关键词": "哨兵检索",
                "转场": "淡入",
                "备注": "音效：咔",
                "来源/核对": "已确认\n原文：哨兵",
            })],
        )
        plan, report = script_template.import_template(path, "topic")
        self.assertEqual([], report["blocked"])
        shot = plan["shots"][0]
        meta = shot["script_meta"]
        self.assertEqual("开场", shot["module_label"])
        self.assertEqual("哨兵标题", shot["title"])
        self.assertEqual((10, "9.5"), (shot["duration"], meta["duration_raw"]))
        self.assertEqual(("哨兵画面", "哨兵检索"), (shot["visual_query"], shot["download_query"]))
        self.assertEqual(("哨兵口播", "哨兵字幕", True), (shot["voice_text"], shot["subtitle"], shot["voiceover"]))
        self.assertEqual({"caption_source": "subtitle"}, shot["render_hints"])
        self.assertEqual(("第一行\n第二行", "headline_sub", "标题卡"),
                         (shot["card_content"], shot["card_layout"], shot["card_hint"]))
        self.assertEqual(["推荐素材来源：指定素材 A"], shot["production_notes"])
        self.assertEqual("必须横屏", shot["clip_requirements"])
        self.assertEqual(["音效：咔"], shot["extra_requirements"])
        expected_meta = {
            "segment": "开场",
            "visual_description": "哨兵画面",
            "shot_size": "特写",
            "camera_move": "推",
            "camera_angle": "俯拍",
            "material_source": "指定素材 A",
            "material_requirements": "必须横屏",
            "search_keywords": "哨兵检索",
            "transition": "淡入",
            "notes": "音效：咔",
        }
        self.assertEqual(expected_meta, {key: meta[key] for key in expected_meta})
        self.assertEqual(["已确认", "原文：哨兵"], meta["review"]["status_lines"])
        source = plan["script_source"]
        self.assertEqual("source.md", source["project_info"]["原始脚本文件名"])
        self.assertEqual("source.md", source["conversion"]["原始脚本文件名"])

    def test_t5_duration_raw_is_only_kept_for_non_integer_values(self) -> None:
        for raw, duration, has_raw in (("2", 2, False), ("2.0", 2, False), ("2.1", 3, True)):
            with self.subTest(raw=raw):
                path = write_template(self.directory / f"duration_{raw}.xlsx",
                                      rows=[template_row(**{"时长(秒)": raw})])
                plan, _ = script_template.import_template(path, "topic")
                self.assertEqual(duration, plan["shots"][0]["duration"])
                self.assertEqual(has_raw, "duration_raw" in plan["shots"][0]["script_meta"])

    def test_t6_real_card_text_and_layout_match_the_design(self) -> None:
        path = ROOT / "docs" / "script-template-v1" / "分镜脚本示例_上下料_v1.xlsx"
        plan, report = script_template.import_template(path, "topic")
        self.assertEqual([], report["blocked"])
        expected = {
            1: ("抓起来、放进去？\n决定成败的其实是三件事", "headline_sub"),
            2: ("01 料的呈现\n料盘 / 旋转料仓 · 人工预放 · 位置固定", "headline_sub"),
            3: (None, None),
            4: ("02 二次定位\n取出 → 转台 / 吸盘 / 夹爪 → 重新定位 → 装夹", None),
            5: ("03 取放 · 叠放\n毛坯盘 → 卡盘 → 成品盘", "equal_lines"),
            6: ("1 台供料专机 → 2 台 CNC", None),
            7: ("总功率 <3 kW\n电源 单相 220V 50Hz\n气源 0.4–0.6 MPa\n重复定位精度 ±0.03 mm", "equal_lines"),
            8: ("缓存 → 上下料 → 在线检测\n对接 AGV · AMR · 皮带机 · 理料机", "headline_sub"),
            9: ("核心不在手臂，在料\n下一期：什么样的机床适合上", "headline_sub"),
        }
        self.assertEqual(9, len(plan["shots"]))
        for shot in plan["shots"]:
            content, layout = expected[shot["shot"]]
            self.assertEqual(content, shot.get("card_content"), shot["shot"])
            self.assertEqual(layout, shot.get("card_layout"), shot["shot"])
        self.assertNotIn("card_hint", plan["shots"][2])

    def test_t7_placeholders_and_doubtful_values_are_conservative(self) -> None:
        cases = [
            ("—", None, False),
            ("（不填）", None, False),
            ("没有！", "没有！", True),
            ("大字 A句", "大字 A句", True),
            ("正文 **粗体**", "正文 **粗体**", True),
            ("大字：正文\n副行：—", "正文", False),
        ]
        for index, (raw, expected, doubtful) in enumerate(cases):
            with self.subTest(raw=raw):
                path = write_template(self.directory / f"doubt_{index}.xlsx",
                                      rows=[template_row(**{"上屏文字": raw})])
                plan, report = script_template.import_template(path, "topic")
                shot = plan["shots"][0]
                self.assertEqual(expected, shot.get("card_content"))
                self.assertNotIn("card_layout", shot)
                self.assertEqual(doubtful, "doubtful_value" in issue_codes(report, "warnings"))

    def test_t8_every_standard_column_red_and_failed_status_block(self) -> None:
        for index, header in enumerate(HEADERS):
            cell = f"{chr(ord('A') + index)}2"
            with self.subTest(header=header):
                path = write_template(self.directory / f"red_{index}.xlsx",
                                      fills={"分镜脚本": {cell: "FFC7CE"}})
                _, report = script_template.import_template(path, "topic")
                red = [item for item in report["blocked"] if item["code"] == "red_cell"]
                self.assertEqual([(cell, header)], [(item["cell"], item["column"]) for item in red])
        failed = write_template(self.directory / "failed.xlsx",
                                rows=[template_row(**{"来源/核对": "校验失败"})])
        _, report = script_template.import_template(failed, "topic")
        self.assertIn("status_failed", issue_codes(report, "blocked"))

    def test_t8_red_in_author_added_column_blocks(self) -> None:
        path = write_template(
            self.directory / "red_extra.xlsx",
            headers=[*HEADERS, "音效"],
            rows=[[*template_row(), "咔"]],
            fills={"分镜脚本": {"S2": "FFC7CE"}},
        )
        _, report = script_template.import_template(path, "topic")
        red = [item for item in report["blocked"] if item["code"] == "red_cell"]
        self.assertEqual([("S2", "音效")], [(item["cell"], item["column"]) for item in red])

    def test_t9_each_authored_text_column_and_duration_yellow_blocks(self) -> None:
        cases = (("C2", "分镜标题"), ("D2", "时长(秒)"), ("I2", "口播"),
                 ("J2", "字幕"), ("K2", "上屏文字"))
        for cell, header in cases:
            with self.subTest(header=header):
                path = write_template(self.directory / f"yellow_{cell}.xlsx",
                                      fills={"分镜脚本": {cell: "FFF2CC"}})
                _, report = script_template.import_template(path, "topic")
                pending = [item for item in report["blocked"] if item["code"] == "text_cell_pending"]
                self.assertEqual([(cell, header)], [(item["cell"], item["column"]) for item in pending])

    def test_t10_each_production_column_yellow_warns_without_blocking(self) -> None:
        cases = [
            ("B2", "module_label"), ("E2", "shot_size"),
            ("F2", "camera_move"), ("G2", "camera_angle"), ("H2", "visual_description"),
            ("L2", "card_hint"), ("M2", "material_source"),
            ("N2", "material_requirements"), ("O2", "search_keywords"),
            ("P2", "transition"), ("Q2", "notes"),
        ]
        for cell, field in cases:
            with self.subTest(field=field):
                path = write_template(self.directory / f"production_{cell}.xlsx",
                                      fills={"分镜脚本": {cell: "FFF2CC"}})
                plan, report = script_template.import_template(path, "topic")
                self.assertEqual([], report["blocked"])
                warnings = [item for item in report["warnings"] if item["code"] == "ai_suggested"]
                self.assertEqual([(cell, field)], [(item["cell"], item["field"]) for item in warnings])
                self.assertEqual(1, len(report["warnings"]))
                self.assertEqual([field], plan["shots"][0]["script_meta"]["review"]["ai_suggested"])

    def test_t11_each_structural_gate_and_all_errors_at_once(self) -> None:
        cases = [
            ("gap", [template_row(**{"镜号": "2"})], {}, "shot_no_invalid"),
            ("duplicate", [template_row(), template_row(**{"镜号": "1"})], {}, "shot_no_invalid"),
            ("noninteger", [template_row(**{"镜号": "1.5"})], {}, "shot_no_invalid"),
            ("missing_number", [template_row(**{"镜号": ""})], {}, "row_without_shot_no"),
            ("empty_duration", [template_row(**{"时长(秒)": ""})], {}, "duration_invalid"),
            ("zero_duration", [template_row(**{"时长(秒)": "0"})], {}, "duration_invalid"),
            ("text_duration", [template_row(**{"时长(秒)": "两秒"})], {}, "duration_invalid"),
            ("number_text", [template_row(**{"分镜标题": Number("7")})], {}, "text_cell_kind"),
            ("formula_text", [template_row(**{"口播": Formula("A1", "缓存")})], {}, "text_cell_kind"),
            ("formula_empty", [template_row(**{"字幕": Formula("A1")})], {}, "text_cell_kind"),
            ("truncated", [template_row(**{"上屏文字": "x" * (MAX_CELL_CHARS + 1)})], {}, "text_cell_kind"),
            ("merged", [template_row()], {"merges": {"分镜脚本": ["A2:A3"]}}, "merged_cells"),
            ("hidden_row", [template_row()], {"hidden_rows": {"分镜脚本": [1]}}, "hidden_content"),
            ("hidden_col", [template_row()], {"hidden_columns": {"分镜脚本": [8]}}, "hidden_content"),
        ]
        for name, rows, options, code in cases:
            with self.subTest(name=name):
                path = write_template(self.directory / f"{name}.xlsx", rows=rows, **options)
                _, report = script_template.import_template(path, "topic")
                self.assertIn(code, issue_codes(report, "blocked"))

        error_path = write_template(self.directory / "error.xlsx")
        rewrite_zip_member(
            error_path,
            "xl/worksheets/sheet2.xml",
            lambda payload: re.sub(
                rb'<c r="C2"[^>]*>.*?</c>',
                b'<c r="C2" t="e"><v>#VALUE!</v></c>',
                payload,
                count=1,
            ),
        )
        _, report = script_template.import_template(error_path, "topic")
        self.assertIn("text_cell_kind", issue_codes(report, "blocked"))

        empty = write_template(self.directory / "empty.xlsx", rows=[])
        _, report = script_template.import_template(empty, "topic")
        self.assertIn("no_shots", issue_codes(report, "blocked"))

        all_bad = write_template(
            self.directory / "all_bad.xlsx",
            rows=[template_row(**{"镜号": "2", "时长(秒)": "0", "分镜标题": Formula("A1")})],
            merges={"分镜脚本": ["A2:A3"]},
            hidden_rows={"分镜脚本": [1]},
        )
        _, report = script_template.import_template(all_bad, "topic")
        codes = issue_codes(report, "blocked")
        expected_codes = ["shot_no_invalid", "duration_invalid", "text_cell_kind", "merged_cells", "hidden_content"]
        for code in expected_codes:
            self.assertIn(code, codes)
        self.assertCountEqual(expected_codes, codes)
        self.assertEqual(5, len(codes))

    def test_t11_hidden_empty_and_header_content_do_not_block(self) -> None:
        path = write_template(
            self.directory / "hidden_nondata.xlsx",
            hidden_rows={"分镜脚本": [0]},
            hidden_columns={"分镜脚本": [30]},
        )
        rewrite_zip_member(
            path,
            "xl/worksheets/sheet2.xml",
            lambda payload: payload.replace(b"</sheetData>", b'<row r="10" hidden="1"></row></sheetData>'),
        )
        _, report = script_template.import_template(path, "topic")
        self.assertNotIn("hidden_content", issue_codes(report, "blocked"))

    def test_t11_hidden_reports_include_cell_and_column(self) -> None:
        row_path = write_template(self.directory / "hidden_row_detail.xlsx",
                                  hidden_rows={"分镜脚本": [1]})
        _, row_report = script_template.import_template(row_path, "topic")
        row_issue = next(item for item in row_report["blocked"] if item["code"] == "hidden_content")
        self.assertEqual("A2", row_issue["cell"])
        self.assertEqual("镜号", row_issue["column"])
        self.assertEqual(1, row_issue["shot"])

        column_path = write_template(self.directory / "hidden_col_detail.xlsx",
                                     hidden_columns={"分镜脚本": [8]})
        _, column_report = script_template.import_template(column_path, "topic")
        column_issue = next(item for item in column_report["blocked"] if item["code"] == "hidden_content")
        self.assertEqual("I2", column_issue["cell"])
        self.assertEqual("口播", column_issue["column"])

    def test_t12_status_contract(self) -> None:
        cases = [
            ("", "作者手写", [], []),
            ("已确认", "已确认", [], ["已确认"]),
            ("待确认", "待确认", ["status_pending"], ["待确认"]),
            ("未知状态", "待确认", ["unknown_status"], ["未知状态"]),
            ("已确认\n原文：甲\nAI建议：乙\n需要人工查看", "已确认", ["status_note"],
             ["已确认", "原文：甲", "AI建议：乙", "需要人工查看"]),
        ]
        for index, (raw, status, warning_codes, status_lines) in enumerate(cases):
            with self.subTest(raw=raw):
                path = write_template(self.directory / f"status_{index}.xlsx",
                                      rows=[template_row(**{"来源/核对": raw})])
                plan, report = script_template.import_template(path, "topic")
                review = plan["shots"][0]["script_meta"]["review"]
                self.assertEqual(status, review["status"])
                self.assertEqual(status_lines, review["status_lines"])
                self.assertEqual(warning_codes, issue_codes(report, "warnings"))
        self.assertEqual("需要人工查看", report["warnings"][0]["message"])

    def test_t13_reads_and_applies_rgb_theme_indexed_and_zebra_fills(self) -> None:
        path = write_template(
            self.directory / "fills.xlsx",
            fills={"分镜脚本": {
                "E2": "00FFF2CC", "F2": "FFFFF2CC", "I2": "F7F9FB",
                "C2": "theme:4", "J2": "indexed:7",
            }},
        )
        fills = read_sheet_fills(path, "分镜脚本")
        self.assertEqual(
            ("FFF2CC", "FFF2CC", "F7F9FB", "theme:4", "indexed:7"),
            (fills[(1, 4)], fills[(1, 5)], fills[(1, 8)], fills[(1, 2)], fills[(1, 9)]),
        )
        _, report = script_template.import_template(path, "topic")
        self.assertEqual(2, issue_codes(report, "warnings").count("ai_suggested"))
        unexpected = [item for item in report["blocked"] if item["code"] == "unexpected_fill"]
        self.assertEqual(["C2", "J2"], [item["cell"] for item in unexpected])
        self.assertNotIn("I2", [item["cell"] for item in report["blocked"]])

    def test_fix_y1_event_prefix_matches_electron_contract(self) -> None:
        source = (ROOT / "VideoAutoCutDesktop" / "electron" / "task-events.ts").read_text(encoding="utf-8")
        prefix = re.search(r"WORKFLOW_EVENT_PREFIX\s*=\s*'([^']+)'", source).group(1)
        report = {"blocked": [], "warnings": [], "shots": 1}
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            script_template._event(report, False)
        self.assertEqual("VACUT_EVENT:", prefix)
        self.assertTrue(stdout.getvalue().startswith(prefix))
        self.assertEqual(1, len(vacut_events(stdout.getvalue())))

    def test_fix_y2_fill_coordinates_follow_sparse_text_grid(self) -> None:
        cases = {
            "missing_row": (lambda data: data.replace(b'<row r="2">', b'<row>'), (1, 8)),
            "missing_cell": (lambda data: data.replace(b'<c r="I2"', b'<c '), (1, 8)),
            "missing_both": (lambda data: data.replace(b'<row r="2">', b'<row>').replace(
                b'<c r="I2"', b'<c '), (1, 8)),
            "after_explicit": (lambda data: data.replace(b'<c r="J2"', b'<c '), (1, 9)),
        }
        for name, (transform, expected) in cases.items():
            with self.subTest(name=name):
                path = write_template(
                    self.directory / f"sparse_{name}.xlsx",
                    fills={"分镜脚本": {"I2" if name != "after_explicit" else "J2": "FFC7CE"}},
                )
                rewrite_zip_member(path, "xl/worksheets/sheet2.xml", transform)
                fills = read_sheet_fills(path, "分镜脚本")
                self.assertEqual("FFC7CE", fills[expected])
                _, report = script_template.import_template(path, "topic")
                red = [item for item in report["blocked"] if item["code"] == "red_cell"]
                self.assertEqual(1, len(red))
                self.assertEqual((expected[0], expected[1]),
                                 (int(red[0]["cell"][1:]) - 1, ord(red[0]["cell"][0]) - ord("A")))

    def test_fix_y4_template_card_filters_only_exact_placeholder_lines(self) -> None:
        cases = [
            ("大字:A\n副行:（不填）", "A", None, False),
            ("大字:—\n副行:B", "B", None, False),
            ("大字:A\n副行:—\n小字:B", "A\nB", "headline_sub", False),
            ("大字:A\n大字:—\n大字:B", "A\nB", "equal_lines", False),
            ("大字:—\n副行:（不填）", None, None, False),
            ("大字:没有！", "没有！", None, True),
            ("大字:—3%\n副行:/分钟", "—3%\n/分钟", "headline_sub", False),
        ]
        for index, (raw, content, layout, doubtful) in enumerate(cases):
            with self.subTest(raw=raw):
                path = write_template(self.directory / f"card_filter_{index}.xlsx",
                                      rows=[template_row(**{"上屏文字": raw})])
                plan, report = script_template.import_template(path, "topic")
                shot = plan["shots"][0]
                meta = shot["script_meta"]
                self.assertEqual(content, shot.get("card_content"))
                self.assertEqual(layout, shot.get("card_layout"))
                self.assertEqual(raw, meta["authored"]["card_content"])
                self.assertEqual(content, meta["script_values"]["card_content"])
                self.assertEqual(layout, meta["script_values"]["card_layout"])
                self.assertEqual(doubtful, "doubtful_value" in issue_codes(report, "warnings"))

    def test_fix_s1_overflow_and_unexpected_template_failures_are_blocked(self) -> None:
        overflow = write_template(self.directory / "overflow.xlsx",
                                  rows=[template_row(**{"镜号": "1e400"})])
        _, report = script_template.import_template(overflow, "topic")
        self.assertIn("shot_no_invalid", issue_codes(report, "blocked"))
        for option in ({"hidden_rows": {"分镜脚本": [1]}},
                       {"hidden_columns": {"分镜脚本": [8]}}):
            path = write_template(self.directory / f"overflow_hidden_{len(option)}_{len(str(option))}.xlsx",
                                  rows=[template_row(**{"镜号": "1e400"})], **option)
            _, hidden_report = script_template.import_template(path, "topic")
            self.assertIn("hidden_content", issue_codes(hidden_report, "blocked"))

        import normalize_script
        source = write_template(self.directory / "recognized.xlsx")
        for stage in ("import", "labels"):
            for existing in (False, True):
                with self.subTest(stage=stage, existing=existing):
                    output = self.directory / f"unexpected_{stage}_{existing}.json"
                    if existing:
                        output.write_bytes(b"old bytes")
                    stdout = io.StringIO()
                    argv = ["normalize_script.py", "--input", str(source), "--output", str(output)]
                    patches = [mock.patch.object(sys, "argv", argv)]
                    upload = mock.patch.object(normalize_script, "upload_script_file")
                    patches.append(upload)
                    if stage == "import":
                        patches.append(mock.patch.object(script_template, "import_template",
                                                         side_effect=RuntimeError("boom")))
                    else:
                        patches.append(mock.patch.object(normalize_script, "ensure_progress_labels",
                                                         side_effect=OSError("boom")))
                    with contextlib.ExitStack() as stack:
                        for item in patches:
                            patched = stack.enter_context(item)
                            if item is upload:
                                upload_mock = patched
                        stack.enter_context(contextlib.redirect_stdout(stdout))
                        with self.assertRaises(SystemExit) as raised:
                            normalize_script.main()
                    self.assertEqual(2, raised.exception.code)
                    self.assertEqual(0, upload_mock.call_count)
                    if existing:
                        self.assertEqual(b"old bytes", output.read_bytes())
                    else:
                        self.assertFalse(output.exists())
                    events = vacut_events(stdout.getvalue())
                    self.assertEqual(1, len(events))
                    self.assertEqual("failed", events[0]["workflowStatus"])
                    self.assertEqual(["unexpected_error"], issue_codes(events[0]["scriptImport"], "blocked"))

    def test_fix_s3_s5_blank_title_and_status_note_variants(self) -> None:
        path = write_template(
            self.directory / "blank_title_notes.xlsx",
            rows=[template_row(**{
                "分镜标题": "",
                "来源/核对": "已确认\n  原文: 忽略  \n AI建议：忽略 \n  保留提醒  ",
            })],
        )
        plan, report = script_template.import_template(path, "topic")
        shot = plan["shots"][0]
        self.assertEqual("分镜1", shot["title"])
        self.assertIsNone(shot["script_meta"]["script_values"]["title"])
        notes = [item["message"] for item in report["warnings"] if item["code"] == "status_note"]
        self.assertEqual(["保留提醒"], notes)

    def test_unexpected_template_error_stderr_is_one_encoding_safe_private_line(self) -> None:
        import normalize_script

        source = write_template(self.directory / "unexpected_diagnostic.xlsx")
        output = self.directory / "protected-output.json"
        output.write_bytes(b"old bytes")
        stdout = io.StringIO()
        stderr_bytes = io.BytesIO()
        stderr = io.TextIOWrapper(stderr_bytes, encoding="cp936", errors="strict")
        argv = ["normalize_script.py", "--input", str(source), "--output", str(output)]
        secret = "第一行\nsecond line 😀"
        try:
            with mock.patch.object(sys, "argv", argv), \
                    mock.patch.object(normalize_script, "upload_script_file") as upload, \
                    mock.patch.object(script_template, "import_template", side_effect=RuntimeError(secret)), \
                    contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                with self.assertRaises(SystemExit) as raised:
                    normalize_script.main()
            stderr.flush()
            diagnostic = stderr_bytes.getvalue().decode("cp936")
        finally:
            stderr.detach()
        self.assertEqual(2, raised.exception.code)
        upload.assert_not_called()
        self.assertEqual(b"old bytes", output.read_bytes())
        self.assertEqual(1, len(diagnostic.splitlines()))
        self.assertIn("RuntimeError: 第一行\\nsecond line", diagnostic)
        self.assertIn(r"\U0001f600", diagnostic)
        self.assertNotIn("second line", stdout.getvalue())
        events = vacut_events(stdout.getvalue())
        self.assertEqual(1, len(events))
        self.assertNotIn("second line", json.dumps(events, ensure_ascii=False))
        self.assertEqual(["unexpected_error"], issue_codes(events[0]["scriptImport"], "blocked"))

    def test_unexpected_template_error_diagnostic_failure_keeps_stable_exit(self) -> None:
        import normalize_script

        class BrokenMessageError(RuntimeError):
            def __str__(self) -> str:
                raise UnicodeError("broken exception message")

        source = write_template(self.directory / "unexpected_broken_message.xlsx")
        output = self.directory / "protected-broken-message.json"
        output.write_bytes(b"old bytes")
        stdout, stderr = io.StringIO(), io.StringIO()
        argv = ["normalize_script.py", "--input", str(source), "--output", str(output)]
        with mock.patch.object(sys, "argv", argv), \
                mock.patch.object(normalize_script, "upload_script_file") as upload, \
                mock.patch.object(script_template, "import_template", side_effect=BrokenMessageError()), \
                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            with self.assertRaises(SystemExit) as raised:
                normalize_script.main()
        self.assertEqual(2, raised.exception.code)
        upload.assert_not_called()
        self.assertEqual(b"old bytes", output.read_bytes())
        self.assertEqual("", stderr.getvalue())
        events = vacut_events(stdout.getvalue())
        self.assertEqual(1, len(events))
        self.assertEqual(["unexpected_error"], issue_codes(events[0]["scriptImport"], "blocked"))

    def test_fix_s7_english_template_with_chinese_script_never_calls_reviewer(self) -> None:
        import normalize_script
        import optimize_queries
        import progress_labels
        import urllib.request

        path = write_template(
            self.directory / "english_segment_chinese_script.xlsx",
            info=[["模板版本", "VAC-SB-1"], ["语言", "English"]],
            rows=[template_row(**{"段落": "中文段落", "分镜标题": "",
                                 "口播": "This is the authored English narration."})],
        )
        raw_shot = {
            "shot": 1,
            "module_label": "中文段落",
            "title": "分镜1",
            "voice_text": "This is the authored English narration.",
        }
        choices = progress_labels.progress_label_choices([raw_shot])
        self.assertTrue(choices[0]["needs_review"])
        self.assertEqual("en", choices[0]["language"])

        output = self.directory / "english-plan.json"
        argv = ["normalize_script.py", "--input", str(path), "--output", str(output)]
        targets = [
            (normalize_script, "upload_script_file"),
            (normalize_script, "normalize_with_ai"),
            (normalize_script, "review_voice_and_subtitles_with_ai"),
            (normalize_script, "review_progress_labels_with_ai"),
            (normalize_script, "verify_card_fields"),
            (normalize_script, "urlopen_with_retry"),
            (optimize_queries, "call_qwen"),
            (urllib.request, "urlopen"),
        ]
        with contextlib.ExitStack() as stack:
            mocks = [stack.enter_context(mock.patch.object(owner, name)) for owner, name in targets]
            stack.enter_context(mock.patch.object(sys, "argv", argv))
            normalize_script.main()
        self.assertTrue(all(item.call_count == 0 for item in mocks))
        shot = json.loads(output.read_text(encoding="utf-8"))["shots"][0]
        self.assertEqual("This is the authored English narration.", shot["module_label"])
        replaced = [item for item in shot["script_meta"]["review"]["warnings"]
                    if item["code"] == "module_label_replaced"]
        self.assertEqual([("B2", 1)], [(item["cell"], item["shot"]) for item in replaced])

    def test_t14_subtitle_contract_and_authored_whitespace(self) -> None:
        cases = [
            ("", None, None, False),
            ("口播", "口播", None, False),
            ("不同字幕", "不同字幕", {"caption_source": "subtitle"}, False),
            ("—", None, None, True),
            ("口播  文本\n第二行", "口播  文本\n第二行", {"caption_source": "subtitle"}, False),
        ]
        for index, (raw, subtitle, hints, placeholder) in enumerate(cases):
            with self.subTest(raw=raw):
                path = write_template(self.directory / f"subtitle_{index}.xlsx",
                                      rows=[template_row(**{"字幕": raw})])
                plan, report = script_template.import_template(path, "topic")
                shot = plan["shots"][0]
                self.assertEqual(subtitle, shot.get("subtitle"))
                self.assertEqual(hints, shot.get("render_hints"))
                self.assertEqual(placeholder, "subtitle_placeholder" in issue_codes(report, "warnings"))

        equal_after_fold = write_template(
            self.directory / "subtitle_folded_equal.xlsx",
            rows=[template_row(**{"口播": "同一句 文本", "字幕": "同一句  文本"})],
        )
        plan, _ = script_template.import_template(equal_after_fold, "topic")
        self.assertEqual("同一句  文本", plan["shots"][0]["subtitle"])
        self.assertNotIn("render_hints", plan["shots"][0])

    def test_t15_template_main_makes_zero_model_and_network_calls(self) -> None:
        import normalize_script
        import optimize_queries
        import urllib.request

        source = ROOT / "docs" / "script-template-v1" / "分镜脚本示例_上下料_v1.xlsx"
        output = self.directory / "plan.json"
        argv = ["normalize_script.py", "--input", str(source), "--output", str(output), "--topic", "固定主题"]
        targets = [
            "upload_script_file", "normalize_with_ai", "review_voice_and_subtitles_with_ai",
            "review_progress_labels_with_ai", "verify_card_fields", "urlopen_with_retry",
        ]
        with contextlib.ExitStack() as stack:
            mocked = [stack.enter_context(mock.patch.object(
                normalize_script, name, side_effect=AssertionError(name))) for name in targets]
            mocked.append(stack.enter_context(mock.patch.object(
                optimize_queries, "call_qwen", side_effect=AssertionError("optimize_queries.call_qwen"))))
            mocked.append(stack.enter_context(mock.patch.object(
                urllib.request, "urlopen", side_effect=AssertionError("urllib.request.urlopen"))))
            stack.enter_context(mock.patch.object(sys, "argv", argv))
            normalize_script.main()
        self.assertTrue(output.exists())
        self.assertTrue(all(target.call_count == 0 for target in mocked))
        self.assertEqual(9, len(json.loads(output.read_text(encoding="utf-8"))["shots"]))

    def test_t16_blocked_main_preserves_or_avoids_output_and_emits_details(self) -> None:
        import normalize_script

        source = ROOT / "docs" / "script-template-v1" / "分镜脚本模板_v1.xlsx"
        for existing in (False, True):
            with self.subTest(existing=existing):
                output = self.directory / f"blocked_{existing}.json"
                if existing:
                    output.write_bytes(b"old bytes")
                stdout = io.StringIO()
                argv = ["normalize_script.py", "--input", str(source), "--output", str(output)]
                with mock.patch.object(sys, "argv", argv), contextlib.redirect_stdout(stdout):
                    with self.assertRaises(SystemExit) as raised:
                        normalize_script.main()
                self.assertNotEqual(0, raised.exception.code)
                self.assertEqual(b"old bytes", output.read_bytes()) if existing else self.assertFalse(output.exists())
                events = vacut_events(stdout.getvalue())
                self.assertEqual(1, len(events))
                event = events[0]
                self.assertEqual(("script", "failed", "template_import"), (
                    event["workflowStage"], event["workflowStatus"], event["workflowProgress"]["phase"]))
                self.assertEqual("template", event["scriptImport"]["route"])
                self.assertTrue(event["scriptImport"]["blocked"])
                self.assertIn("no_shots", [item["code"] for item in event["scriptImport"]["blocked"]])

    def test_t17_non_template_legacy_values_match_a29_except_generated_subtitle(self) -> None:
        import normalize_script
        import shot_plan_schema

        old_main_source = subprocess.run(
            ["git", "show", "a29d74f:VideoAutoCut/tools/normalize_script.py"], cwd=ROOT,
            check=True, capture_output=True, text=True, encoding="utf-8").stdout
        old_schema_source = subprocess.run(
            ["git", "show", "a29d74f:VideoAutoCut/tools/shot_plan_schema.py"], cwd=ROOT,
            check=True, capture_output=True, text=True, encoding="utf-8").stdout
        old_schema = types.ModuleType("shot_plan_schema_a29d74f")
        exec(compile(old_schema_source, "shot_plan_schema_a29d74f.py", "exec"), old_schema.__dict__)
        old_main = types.ModuleType("normalize_script_a29d74f")
        old_main.__file__ = "normalize_script_a29d74f.py"
        exec(compile(old_main_source, old_main.__file__, "exec"), old_main.__dict__)
        old_main.normalize_shot_plan = old_schema.normalize_shot_plan

        input_path = self.directory / "plain.txt"
        input_path.write_text("原文", encoding="utf-8")
        raw_plan = {
            "schema_version": 2, "task_revision": 0, "topic": "固定",
            "shots": [{
                "shot_id": "fixed", "shot": 1, "title": "标题", "duration": 2,
                "visual_query": "画面", "download_query": "检索", "voice_text": "口播",
                "subtitle": "口播", "voiceover": True,
            }],
        }
        results = []
        for module, schema in ((old_main, old_schema), (normalize_script, shot_plan_schema)):
            output = self.directory / "same.json"
            stdout = io.StringIO()
            argv = ["normalize_script.py", "--input", str(input_path), "--output", str(output), "--topic", "固定"]
            with contextlib.ExitStack() as stack:
                stack.enter_context(mock.patch.object(sys, "argv", argv))
                stack.enter_context(mock.patch.object(schema.uuid, "uuid4", return_value=uuid.UUID(int=1)))
                stack.enter_context(mock.patch.object(module, "upload_script_file", return_value="fixed-file"))
                stack.enter_context(mock.patch.object(module, "normalize_with_ai", return_value=copy.deepcopy(raw_plan)))
                stack.enter_context(mock.patch.object(
                    module, "review_voice_and_subtitles_with_ai", return_value=copy.deepcopy(raw_plan)))
                stack.enter_context(mock.patch.object(
                    module, "review_progress_labels_with_ai", return_value={"labels": []}))
                stack.enter_context(mock.patch.object(module, "verify_card_fields", return_value={}))
                stack.enter_context(contextlib.redirect_stdout(stdout))
                module.main()
            results.append((output.read_bytes(), stdout.getvalue().splitlines()))
        baseline = json.loads(results[0][0])
        candidate = json.loads(results[1][0])
        self.assertEqual("口播", baseline["shots"][0]["subtitle"])
        self.assertNotIn("subtitle", candidate["shots"][0])
        self.assertEqual("organized", candidate["script_source"]["route"])
        candidate_shot = copy.deepcopy(candidate["shots"][0])
        candidate_shot.pop("script_meta")
        candidate_shot.pop("subtitle", None)
        baseline_shot = copy.deepcopy(baseline["shots"][0])
        baseline_shot.pop("subtitle", None)
        self.assertEqual(baseline_shot, candidate_shot)
        candidate_without_metadata = copy.deepcopy(candidate)
        candidate_without_metadata.pop("script_source")
        candidate_without_metadata["shots"] = [candidate_shot]
        baseline_without_subtitle = copy.deepcopy(baseline)
        baseline_without_subtitle["shots"] = [baseline_shot]
        self.assertEqual(baseline_without_subtitle, candidate_without_metadata)
        self.assertEqual(results[0][1], results[1][1])

    def test_t18_real_template_plans_need_no_card_reconciliation(self) -> None:
        names = ("分镜脚本示例_上下料_v1.xlsx", "转换演示_md文本.xlsx", "转换演示_v1表格.xlsx")
        for name in names:
            with self.subTest(name=name):
                path = ROOT / "docs" / "script-template-v1" / name
                plan, _ = script_template.import_template(path, path.stem)
                self.assertEqual([], reconcile(copy.deepcopy(plan), path)["corrections"])

    def test_t19_dictionary_constants_match_every_real_dictionary_sheet(self) -> None:
        expected_headers = [
            "景别", "运镜", "拍摄角度", "转场", "卡片提示建议", "视频类型", "画幅", "语言", "转换方式",
        ]
        candidates = {"景别": "shot_size", "运镜": "camera_move", "拍摄角度": "camera_angle", "转场": "transition"}
        root = ROOT / "docs" / "script-template-v1"
        for name in REAL_TEMPLATE_NAMES:
            with self.subTest(name=name):
                sheet = next(item for item in read_workbook_detail(root / name) if item.name == "字典")
                headers = [str(value).strip() for value in sheet.grid[0]]
                self.assertEqual(expected_headers, headers)
                for header, key in candidates.items():
                    column = headers.index(header)
                    values = [str(row[column]).strip() for row in sheet.grid[1:]
                              if column < len(row) and str(row[column]).strip()]
                    self.assertEqual(script_template.DICTIONARIES[key], values)

    def test_section_4_2_data_contract_and_determinism(self) -> None:
        path = write_template(
            self.directory / "contract.xlsx",
            info=[
                ["模板版本", "VAC-SB-1"], ["片名", "合同测试"], ["画幅", "16:9"],
                ["原始脚本文件名", "source.md"], ["原始脚本 SHA-256", "012345"], ["转换方式", "作者手写"],
            ],
            rows=[template_row(**{
                "分镜标题": "", "时长(秒)": "9.5", "画面内容": "", "口播": "保留  内部   语义",
                "字幕": "", "上屏文字": "", "卡片提示": "", "搜索关键词": "", "转场": "",
                "备注": "", "来源/核对": "",
            })],
        )
        first_plan, first_report = script_template.import_template(path, "固定主题")
        second_plan, second_report = script_template.import_template(path, "固定主题")
        self.assertEqual((first_plan, first_report), (second_plan, second_report))
        shot = first_plan["shots"][0]
        meta = shot["script_meta"]
        self.assertEqual({"format": "VAC-SB-1", "sheet": "分镜脚本", "row": 2}, meta["source"])
        self.assertEqual("分镜1", shot["title"])
        self.assertEqual("分镜1", shot["visual_query"])
        self.assertEqual("", shot["download_query"])
        self.assertEqual("保留 内部 语义", shot["voice_text"])
        for key in ("subtitle", "card_content", "card_hint", "card_layout", "render_hints"):
            self.assertNotIn(key, shot)
        for key in ("visual_description", "transition", "notes", "authored"):
            self.assertNotIn(key, meta)
        self.assertEqual("9.5", meta["duration_raw"])
        self.assertEqual({
            "title": None, "voice_text": "保留 内部 语义", "subtitle": None,
            "card_content": None, "card_layout": None, "card_hint": None,
            "visual_description": None, "shot_size": "全景", "camera_move": "固定",
            "camera_angle": "平视", "transition": None,
        }, meta["script_values"])
        review = meta["review"]
        self.assertEqual(("作者手写", [], [], []), (
            review["status"], review["status_lines"], review["confirmed"], review["acknowledged"]))
        self.assertEqual(["visual_missing"], [item["code"] for item in review["warnings"]])

        source = first_plan["script_source"]
        self.assertEqual((1, "template", "VAC-SB-1", path.name),
                         (source["v"], source["route"], source["format"], source["file_name"]))
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), source["file_sha256"])
        self.assertEqual("source.md", source["project_info"]["原始脚本文件名"])
        self.assertEqual("source.md", source["conversion"]["原始脚本文件名"])
        self.assertEqual(script_template.DICTIONARIES, source["dictionaries"])
        self.assertEqual({"shots": 1, "warnings": 1, "shots_with_ai_suggested": 0}, source["import_summary"])
        serialized = json.dumps(first_plan, ensure_ascii=False, separators=(",", ":"))
        self.assertNotIn("imported_at", serialized)
        self.assertNotIn("created_at", serialized)

    def test_known_key_sets_are_exact_and_independent(self) -> None:
        expected_plan = frozenset({
            "schema_version", "task_revision", "topic", "shots", "background_music",
            "content_blocks", "extra_requirements",
        })
        expected_shot = frozenset({
            "shot_id", "shot", "title", "download_query", "visual_query", "download_material",
            "material_bindings", "module_label", "visual_mode", "voice_text", "subtitle",
            "clip_requirements", "progress_text", "highlight_rule", "subtitle_effect",
            "voice_requirements", "time_range", "card_content", "card_hint", "raw_download_query",
            "raw_visual_query", "voice_audio", "subtitle_cues_file", "card_plan", "card_ass",
            "card_layout", "duration", "voiceover", "query_optimized", "subtitle_cues",
            "extra_requirements", "production_notes", "content_blocks",
        })
        self.assertEqual(expected_plan, KNOWN_PLAN_KEYS)
        self.assertEqual(expected_shot, KNOWN_SHOT_KEYS)

        unknown = {"未知镜级": {"a": [1, None]}, "中文未知": 7}
        raw = {
            "schema_version": 2, "task_revision": 3, "topic": "t", "background_music": {"path": "bgm.mp3"},
            "content_blocks": [{"kind": "intro"}], "extra_requirements": ["plan"],
            "script_source": {"v": 1}, "未知顶层": None,
            "shots": [{
                "shot_id": "s", "shot": 99, "title": "title", "download_query": "download",
                "visual_query": "visual", "download_material": False, "material_bindings": [],
                "module_label": "module", "visual_mode": "stock_video", "voice_text": "voice",
                "subtitle": "subtitle", "clip_requirements": "clip", "progress_text": "progress",
                "highlight_rule": "highlight", "subtitle_effect": "effect", "voice_requirements": "requirements",
                "time_range": "0-2", "card_content": "card", "card_hint": "hint",
                "raw_download_query": "raw download", "raw_visual_query": "raw visual",
                "voice_audio": "voice.wav", "subtitle_cues_file": "subtitle.json", "card_plan": "card.json",
                "card_ass": "card.ass", "card_layout": "invalid", "duration": 2, "voiceover": True,
                "query_optimized": True, "subtitle_cues": [{"text": "subtitle"}],
                "extra_requirements": ["shot"], "production_notes": ["note"],
                "content_blocks": [{"kind": "shot"}], "script_meta": {"v": 1},
                "render_hints": {"caption_source": "subtitle"},
                "material_resolution": {"status": "resolved"}, "material_source_mode": "auto", **unknown,
            }],
        }
        normalized = normalize_shot_plan(raw, topic="fallback")
        shot = normalized["shots"][0]
        for key, value in unknown.items():
            self.assertEqual(value, shot[key])
        self.assertEqual({"v": 1}, shot["script_meta"])
        self.assertEqual({"caption_source": "subtitle"}, shot["render_hints"])
        self.assertEqual({"status": "resolved"}, shot["material_resolution"])
        self.assertEqual("auto", shot["material_source_mode"])
        self.assertEqual({"v": 1}, normalized["script_source"])
        self.assertIn("未知顶层", normalized)
        self.assertIsNone(normalized["未知顶层"])
        self.assertNotIn("card_layout", shot)

    def test_xlsx_fixture_default_output_is_byte_identical_to_c6f3382(self) -> None:
        old_source = subprocess.run(
            ["git", "show", "c6f3382:VideoAutoCut/tests/xlsx_fixture.py"], cwd=ROOT,
            check=True, capture_output=True, text=True, encoding="utf-8").stdout
        old_fixture = types.ModuleType("xlsx_fixture_c6f3382")
        old_fixture.__file__ = "xlsx_fixture_c6f3382.py"
        exec(compile(old_source, old_fixture.__file__, "exec"), old_fixture.__dict__)
        old_path, new_path = self.directory / "old.xlsx", self.directory / "new.xlsx"
        sheets = [("项目信息", INFO), ("分镜脚本", [HEADERS, template_row()])]
        fixed_time = time.struct_time((2026, 1, 1, 0, 0, 0, 3, 1, -1))
        with mock.patch.object(zipfile.time, "localtime", return_value=fixed_time):
            old_fixture.write_xlsx(old_path, sheets)
            write_xlsx(new_path, sheets)
        self.assertEqual(old_path.read_bytes(), new_path.read_bytes())


if __name__ == "__main__":
    unittest.main()
