#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""**测试专用**的最小 xlsx 写出器——只用标准库，跟 `tools/script_tabular.py` 读的是同一套
OOXML（zip + XML）。运行包里没有 openpyxl，测试里也不许装，所以夹具自己拼。

只支持测试需要的那点东西：多 sheet、共享字符串 / 行内字符串两种存法、合并单元格、
稀疏行（`None` = 这一格根本不存在，不是空串）、数值格（`Number`）、公式格（`Formula`，
可带或不带缓存值）。**不是通用 Excel 写库**，别拿去干别的。
字符串里的 `_x000D_` 这类 OOXML 转义会原样写进 XML（`escape` 不动下划线），用来测读取层解码。

用法：
    write_xlsx(path, [("视频脚本", rows)], merges={"视频脚本": ["A2:A4"]})
"""
from __future__ import annotations

import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

CONTENT_TYPES_HEAD = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.'
    'spreadsheetml.sheet.main+xml"/>'
)
ROOT_RELS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
    'relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
)
STYLES_XML = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>'
    '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>'
    '<borders count="1"><border/></borders>'
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>'
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
    "</styleSheet>"
)
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
SHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"


class Number:
    """数值格：`<c><v>0.95</v></c>`（没有 `t`，Excel 就是这么存百分比 / 小数的）。"""

    def __init__(self, raw: str):
        self.raw = raw


class Formula:
    """公式格：`<c t="str"><f>…</f>[<v>缓存值</v>]</c>`；`cached=None` = 没有缓存值。"""

    def __init__(self, expression: str, cached: str | None = None):
        self.expression = expression
        self.cached = cached


def column_letter(index: int) -> str:
    letters = ""
    index += 1
    while index:
        index, remainder = divmod(index - 1, 26)
        letters = chr(ord("A") + remainder) + letters
    return letters


def _cell_xml(reference: str, value, shared: dict[str, int] | None, style: int | None = None) -> str:
    style_attr = "" if style is None else f' s="{style}"'
    if isinstance(value, Number):
        return f'<c r="{reference}"{style_attr}><v>{escape(value.raw)}</v></c>'
    if isinstance(value, Formula):
        cached = "" if value.cached is None else f"<v>{escape(value.cached)}</v>"
        return f'<c r="{reference}"{style_attr} t="str"><f>{escape(value.expression)}</f>{cached}</c>'
    if shared is not None and value in shared:
        return f'<c r="{reference}"{style_attr} t="s"><v>{shared[value]}</v></c>'
    return (f'<c r="{reference}"{style_attr} t="inlineStr"><is><t xml:space="preserve">'
            f"{escape(value)}</t></is></c>")


def _sheet_xml(rows: list[list[str | None]], merges: list[str],
               shared: dict[str, int] | None, hidden_columns: list[int] = (),
               hidden_rows: list[int] = (), fills: dict[str, int] | None = None) -> str:
    fills = fills or {}
    parts = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
             f'<worksheet xmlns="{SHEET_NS}">']
    if hidden_columns:
        # `<col>` 的 min/max 是 1 起的列号；隐藏列 Excel 写 hidden="1"（宽度随意）
        parts.append("<cols>" + "".join(f'<col min="{c + 1}" max="{c + 1}" width="0" hidden="1"/>'
                                        for c in hidden_columns) + "</cols>")
    parts.append("<sheetData>")
    for row_index, row in enumerate(rows, 1):
        cells = []
        for column, value in enumerate(row):
            reference = f"{column_letter(column)}{row_index}"
            if (value is None or value == "") and reference not in fills:
                continue                      # 稀疏：这一格干脆不写，跟 Excel 一样
            if not isinstance(value, (Number, Formula)):
                value = str(value)
            cells.append(_cell_xml(reference, value or "", shared, fills.get(reference)))
        hidden = ' hidden="1"' if row_index - 1 in hidden_rows else ""
        if cells:
            parts.append(f'<row r="{row_index}"{hidden}>' + "".join(cells) + "</row>")
    parts.append("</sheetData>")
    if merges:
        parts.append(f'<mergeCells count="{len(merges)}">'
                     + "".join(f'<mergeCell ref="{ref}"/>' for ref in merges)
                     + "</mergeCells>")
    parts.append("</worksheet>")
    return "".join(parts)


def write_xlsx(path: Path, sheets: list[tuple[str, list[list[str | None]]]], *,
               merges: dict[str, list[str]] | None = None, shared: bool = True,
               hidden_columns: dict[str, list[int]] | None = None,
               hidden_rows: dict[str, list[int]] | None = None,
               fills: dict[str, dict[str, str]] | None = None) -> Path:
    """`sheets` 里每个元素是 `(sheet 名, 行 × 列)`。`shared=False` 改用行内字符串。

    `hidden_columns` / `hidden_rows`：`{sheet 名: [0 起的列号 / 行号]}`，写成 Excel 的隐藏列 / 行。
    """
    merges = merges or {}
    hidden_columns = hidden_columns or {}
    hidden_rows = hidden_rows or {}
    fills = fills or {}
    fill_colors = list(dict.fromkeys(color.upper() for cells in fills.values() for color in cells.values()))
    fill_styles = {color: index + 1 for index, color in enumerate(fill_colors)}
    styles_xml = STYLES_XML
    if fill_colors:
        def color_xml(color: str) -> str:
            if color.lower().startswith("theme:"):
                return f'<fgColor theme="{escape(color.split(":", 1)[1])}"/>'
            if color.lower().startswith("indexed:"):
                return f'<fgColor indexed="{escape(color.split(":", 1)[1])}"/>'
            return f'<fgColor rgb="{color}"/>'
        fill_xml = '<fill><patternFill patternType="none"/></fill>' + "".join(
            f'<fill><patternFill patternType="solid">{color_xml(color)}'
            '<bgColor indexed="64"/></patternFill></fill>' for color in fill_colors)
        xf_xml = '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' + "".join(
            f'<xf numFmtId="0" fontId="0" fillId="{index}" borderId="0" xfId="0" applyFill="1"/>'
            for index in range(1, len(fill_colors) + 1))
        styles_xml = (STYLES_XML.replace('<fills count="1"><fill><patternFill patternType="none"/></fill></fills>',
                                         f'<fills count="{len(fill_colors) + 1}">{fill_xml}</fills>')
                                .replace('<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>',
                                         f'<cellXfs count="{len(fill_colors) + 1}">{xf_xml}</cellXfs>'))
    table: dict[str, int] | None = None
    if shared:
        table = {}
        for _name, rows in sheets:
            for row in rows:
                for value in row:
                    if isinstance(value, (Number, Formula)):
                        continue
                    if value not in (None, "") and str(value) not in table:
                        table[str(value)] = len(table)

    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        overrides = "".join(
            f'<Override PartName="/xl/worksheets/sheet{index}.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            for index in range(1, len(sheets) + 1))
        if table is not None:
            overrides += ('<Override PartName="/xl/sharedStrings.xml" ContentType="application/'
                          'vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>')
        overrides += ('<Override PartName="/xl/styles.xml" ContentType="application/vnd.'
                      'openxmlformats-officedocument.spreadsheetml.styles+xml"/>')
        archive.writestr("[Content_Types].xml", CONTENT_TYPES_HEAD + overrides + "</Types>")
        archive.writestr("_rels/.rels", ROOT_RELS)

        sheet_tags = "".join(
            f'<sheet name="{escape(name)}" sheetId="{index}" r:id="rId{index}"/>'
            for index, (name, _rows) in enumerate(sheets, 1))
        archive.writestr(
            "xl/workbook.xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            f'<workbook xmlns="{SHEET_NS}" xmlns:r="{REL_NS}">'
            f"<sheets>{sheet_tags}</sheets></workbook>")

        relations = "".join(
            f'<Relationship Id="rId{index}" Type="{REL_NS}/worksheet" '
            f'Target="worksheets/sheet{index}.xml"/>' for index in range(1, len(sheets) + 1))
        if table is not None:
            relations += (f'<Relationship Id="rId{len(sheets) + 1}" Type="{REL_NS}/sharedStrings" '
                          'Target="sharedStrings.xml"/>')
        relations += (f'<Relationship Id="rIdStyles" Type="{REL_NS}/styles" Target="styles.xml"/>')
        archive.writestr(
            "xl/_rels/workbook.xml.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            f"{relations}</Relationships>")

        if table is not None:
            entries = "".join(f'<si><t xml:space="preserve">{escape(text)}</t></si>'
                              for text, _index in sorted(table.items(), key=lambda item: item[1]))
            archive.writestr(
                "xl/sharedStrings.xml",
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                f'<sst xmlns="{SHEET_NS}" count="{len(table)}" uniqueCount="{len(table)}">'
                f"{entries}</sst>")

        # Excel 对缺 styles.xml 的工作簿会弹「发现部分内容有问题」，加一份最小的省事
        archive.writestr("xl/styles.xml", styles_xml)

        for index, (name, rows) in enumerate(sheets, 1):
            archive.writestr(f"xl/worksheets/sheet{index}.xml",
                             _sheet_xml(rows, merges.get(name, []), table,
                                        hidden_columns.get(name, []), hidden_rows.get(name, []),
                                        {cell: fill_styles[color.upper()]
                                         for cell, color in fills.get(name, {}).items()}))
    return path


__all__ = ["Formula", "Number", "column_letter", "write_xlsx"]
