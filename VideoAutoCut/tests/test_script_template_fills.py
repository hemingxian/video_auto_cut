#!/usr/bin/env python3
from __future__ import annotations

import re
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "VideoAutoCut" / "tools"
TESTS = Path(__file__).resolve().parent
for search_path in (TOOLS, TESTS):
    if str(search_path) not in sys.path:
        sys.path.insert(0, str(search_path))

import script_template
from test_script_template import rewrite_zip_member, template_row, write_template


CRITICAL_CELLS = {
    "D2": "时长(秒)",
    "C2": "分镜标题",
    "I2": "口播",
    "J2": "字幕",
    "K2": "上屏文字",
}

UNEXPECTED_ACTION = "请清除底色后再导入"


def issue_codes(report: dict, key: str) -> list[str]:
    return [item["code"] for item in report[key]]


class ScriptTemplateFillContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary_directory.name)

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def _book_with_fill(self, name: str, cell: str, fill: str) -> Path:
        return write_template(
            self.directory / f"{name}.xlsx",
            fills={"分镜脚本": {cell: fill}},
        )

    def _book_with_custom_style(self, name: str, cell: str, fill_xml: str) -> Path:
        path = self._book_with_fill(name, cell, "112233")
        replacement = fill_xml.encode("utf-8")

        def replace_style(payload: bytes) -> bytes:
            pattern = (
                rb'<fill><patternFill patternType="solid"><fgColor rgb="112233"/>'
                rb'<bgColor indexed="64"/></patternFill></fill>'
            )
            updated, count = re.subn(pattern, replacement, payload, count=1)
            if count != 1:
                raise AssertionError("test fixture could not replace the sentinel fill")
            return updated

        rewrite_zip_member(path, "xl/styles.xml", replace_style)
        return path

    def _unexpected_style_cases(self) -> list[tuple[str, str, str]]:
        return [
            ("rgb_red", "rgb", "FF0000"),
            ("near_standard_red", "rgb", "FFC7CF"),
            ("bright_yellow", "rgb", "FFFF00"),
            ("excel_neutral", "rgb", "FFEB9C"),
            ("indexed_13", "direct", "indexed:13"),
            (
                "theme_with_tint",
                "xml",
                '<fill><patternFill patternType="solid"><fgColor theme="4" tint="-0.249977111"/>'
                '<bgColor indexed="64"/></patternFill></fill>',
            ),
            (
                "white_with_nonzero_tint",
                "xml",
                '<fill><patternFill patternType="solid"><fgColor rgb="FFFFFFFF" tint="-0.25"/>'
                '<bgColor indexed="64"/></patternFill></fill>',
            ),
            (
                "solid_missing_fg",
                "xml",
                '<fill><patternFill patternType="solid"><bgColor indexed="64"/></patternFill></fill>',
            ),
            (
                "solid_auto",
                "xml",
                '<fill><patternFill patternType="solid"><fgColor auto="1"/>'
                '<bgColor indexed="64"/></patternFill></fill>',
            ),
            (
                "solid_invalid_rgb",
                "xml",
                '<fill><patternFill patternType="solid"><fgColor rgb="NOT-A-COLOR"/>'
                '<bgColor indexed="64"/></patternFill></fill>',
            ),
            (
                "gradient",
                "xml",
                '<fill><gradientFill degree="45"><stop position="0"><color rgb="FFFFFFFF"/></stop>'
                '<stop position="1"><color rgb="FF000000"/></stop></gradientFill></fill>',
            ),
            (
                "pattern_light_grid",
                "xml",
                '<fill><patternFill patternType="lightGrid"><fgColor rgb="FFFFFFFF"/>'
                '<bgColor rgb="FF000000"/></patternFill></fill>',
            ),
            (
                "pattern_gray_125",
                "xml",
                '<fill><patternFill patternType="gray125"/></fill>',
            ),
        ]

    def _make_style_case(self, name: str, cell: str, kind: str, payload: str) -> Path:
        if kind in {"rgb", "direct"}:
            return self._book_with_fill(f"{name}_{cell}", cell, payload)
        return self._book_with_custom_style(f"{name}_{cell}", cell, payload)

    def _assert_single_unexpected_fill(self, report: dict, cell: str, column: str) -> None:
        issues = [item for item in report["blocked"] if item["code"] == "unexpected_fill"]
        self.assertEqual(1, len(issues), report)
        issue = issues[0]
        self.assertEqual(cell, issue["cell"])
        self.assertEqual(column, issue["column"])
        self.assertEqual("请清除底色后再导入", issue["message"])
        self.assertEqual(UNEXPECTED_ACTION, issue["action"])

    def test_y3_nonstandard_fills_block_every_critical_column(self) -> None:
        for style_name, kind, payload in self._unexpected_style_cases():
            for cell, column in CRITICAL_CELLS.items():
                with self.subTest(style=style_name, cell=cell):
                    path = self._make_style_case(style_name, cell, kind, payload)
                    _, report = script_template.import_template(path, "topic")
                    self._assert_single_unexpected_fill(report, cell, column)

    def test_y3_header_colors_on_data_cells_are_not_normal(self) -> None:
        for color in ("1F3A5F", "5B6770"):
            for cell, column in CRITICAL_CELLS.items():
                with self.subTest(color=color, cell=cell):
                    path = self._book_with_fill(f"header_color_{color}_{cell}", cell, color)
                    _, report = script_template.import_template(path, "topic")
                    self._assert_single_unexpected_fill(report, cell, column)

    def test_y3_standard_red_keeps_red_cell_for_every_column(self) -> None:
        headers = [*script_template.HEADERS, "音效"]
        row = [*template_row(), "咔"]
        for index, column in enumerate(headers):
            cell = f"{self._column_name(index)}2"
            with self.subTest(cell=cell, column=column):
                path = write_template(
                    self.directory / f"red_{index}.xlsx",
                    headers=headers,
                    rows=[row],
                    fills={"分镜脚本": {cell: "FFC7CE"}},
                )
                _, report = script_template.import_template(path, "topic")
                red = [item for item in report["blocked"] if item["code"] == "red_cell"]
                self.assertEqual([(cell, column)], [(item["cell"], item["column"]) for item in red])

    def test_y3_standard_yellow_blocks_all_critical_columns(self) -> None:
        for cell, column in CRITICAL_CELLS.items():
            with self.subTest(cell=cell):
                path = self._book_with_fill(f"yellow_{cell}", cell, "FFF2CC")
                _, report = script_template.import_template(path, "topic")
                issues = [item for item in report["blocked"] if item["code"] == "text_cell_pending"]
                self.assertEqual([(cell, column)], [(item["cell"], item["column"]) for item in issues])
                self.assertNotIn("unexpected_fill", issue_codes(report, "blocked"))

    def test_y3_normal_data_fills_are_accepted(self) -> None:
        normal_cases = [
            ("no_fill", "none", ""),
            ("white_rgb6", "rgb", "FFFFFF"),
            ("white_argb00", "rgb", "00FFFFFF"),
            ("white_argbff", "rgb", "FFFFFFFF"),
            ("zebra_rgb6", "rgb", "F7F9FB"),
            ("zebra_argb00", "rgb", "00F7F9FB"),
            ("zebra_argbff", "rgb", "FFF7F9FB"),
            (
                "white_tint_zero",
                "xml",
                '<fill><patternFill patternType="solid"><fgColor rgb="FFFFFFFF" tint="0"/>'
                '<bgColor indexed="64"/></patternFill></fill>',
            ),
            (
                "zebra_tint_zero",
                "xml",
                '<fill><patternFill patternType="solid"><fgColor rgb="00F7F9FB" tint="0.0"/>'
                '<bgColor indexed="64"/></patternFill></fill>',
            ),
        ]
        for name, kind, payload in normal_cases:
            for cell in CRITICAL_CELLS:
                with self.subTest(fill=name, cell=cell):
                    if kind == "none":
                        path = write_template(self.directory / f"{name}_{cell}.xlsx")
                    elif kind == "rgb":
                        path = self._book_with_fill(f"{name}_{cell}", cell, payload)
                    else:
                        path = self._book_with_custom_style(f"{name}_{cell}", cell, payload)
                    _, report = script_template.import_template(path, "topic")
                    self.assertEqual([], report["blocked"], report)
                    self.assertNotIn("unexpected_fill", issue_codes(report, "warnings"))
                    self.assertNotIn("unknown_fill", issue_codes(report, "warnings"))

    def test_y3_real_header_colors_on_header_row_do_not_affect_import(self) -> None:
        path = write_template(
            self.directory / "real_header_colors.xlsx",
            fills={"分镜脚本": {
                "A1": "1F3A5F",
                "B1": "5B6770",
                "C1": "1F3A5F",
                "D1": "1F3A5F",
                "E1": "5B6770",
                "I1": "1F3A5F",
                "R1": "5B6770",
            }},
        )
        _, report = script_template.import_template(path, "topic")
        self.assertEqual([], report["blocked"])
        self.assertEqual([], report["warnings"])

    def test_y3_nonstandard_fills_warn_on_production_and_status_columns(self) -> None:
        for style_name, kind, payload in self._unexpected_style_cases():
            for cell, column, field in (("E2", "景别", "shot_size"), ("R2", "来源/核对", "review")):
                with self.subTest(style=style_name, cell=cell):
                    path = self._make_style_case(f"warn_{style_name}", cell, kind, payload)
                    _, report = script_template.import_template(path, "topic")
                    self.assertEqual([], report["blocked"], report)
                    warnings = [item for item in report["warnings"] if item["code"] == "unknown_fill"]
                    self.assertEqual(1, len(warnings), report)
                    self.assertEqual((cell, column, field, "warn"), (
                        warnings[0]["cell"], warnings[0]["column"], warnings[0]["field"], warnings[0]["level"],
                    ))

    @staticmethod
    def _column_name(index: int) -> str:
        result = ""
        index += 1
        while index:
            index, remainder = divmod(index - 1, 26)
            result = chr(ord("A") + remainder) + result
        return result


if __name__ == "__main__":
    unittest.main()
