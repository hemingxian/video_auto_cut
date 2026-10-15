#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""表格 / docx 脚本的**只读**取文本层——只用标准库，一个第三方包都不引。

**为什么必须只用标准库。** 生产脚本主要是表格（xlsx）或 txt，也会有 docx/pdf/csv。
但 `normalize_script.py` 根本**没有**本地读取这些格式的代码：它把整个文件原样
multipart 上传到 DashScope 的 `/v1/files`（`purpose=file-extract`），由 qwen-long
在**服务端**抽文字（`normalize_script.upload_script_file` / `normalize_with_ai`）。
所以「复用同一套读取结果」这条路不存在——服务端抽出来的文本压根没有回到本地。

剩下的唯一一条不引入新依赖的路：自己用标准库读。运行包里的 Python 是
`python-3.11.9-embed-amd64`（`VideoAutoCutApp/src/paths.rs:133`），嵌入式发行版
**没有 pip、没有 site-packages**，整个 `VideoAutoCut/tools/` 也是零第三方依赖。
好在 `.xlsx` / `.xlsm` / `.docx` 本身就是 zip + XML，`zipfile` + `xml.etree` 够用；
`.csv` 有 `csv`。`.xls` / `.doc`（旧二进制 BIFF/CFB）和 `.pdf` 标准库读不了，
**一律返回 None = 上层零动作**，绝不猜。

**这一层只读、不判断语义**：给上层一份「行 × 列」的字符串网格或一段纯文本，
列名认不认得、哪行是分镜，都是 `script_card_fields.py` 的事。

**所有失败都返回 None，不抛异常**：上层的承诺是「校验绝不带倒脚本解析」。
"""
from __future__ import annotations

import csv
import io
import re
import unicodedata
import zipfile
from pathlib import Path
from typing import NamedTuple
from xml.etree import ElementTree

# OOXML 命名空间。
NS_SHEET = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
NS_REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
NS_WORD = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"

XLSX_SUFFIXES = {".xlsx", ".xlsm"}
CSV_SUFFIXES = {".csv"}
DOCX_SUFFIXES = {".docx"}

# 防炸闸门：脚本表格再大也就几十镜。超了直接放弃（零动作），不去啃一个几百兆的 zip。
MAX_ENTRY_BYTES = 64 * 1024 * 1024   # 单个 zip 成员解压后的上限
MAX_ROWS = 5000
MAX_COLUMNS = 256
MAX_CELL_CHARS = 20000
MAX_SHEETS = 64

# `xml.etree` 会展开内部 DTD 实体（billion laughs / 二次膨胀），而上面那些上限管的是
# **压缩成员解压后的字节数**，管不住展开后的内存。脚本文件里根本不该有 DTD，
# 见到就整份放弃（零动作）比想办法防住便宜得多。
DOCTYPE_MARKERS = (b"<!DOCTYPE", b"<!ENTITY", b"<!doctype", b"<!entity")


# ----------------------------------------------------------------------------
# 通用
# ----------------------------------------------------------------------------

def _read_member(archive: zipfile.ZipFile, name: str) -> bytes | None:
    """读一个 zip 成员；不存在、太大、坏了都返回 None。"""
    try:
        info = archive.getinfo(name)
    except KeyError:
        return None
    if info.file_size > MAX_ENTRY_BYTES:
        return None
    try:
        with archive.open(info) as handle:
            return handle.read(MAX_ENTRY_BYTES + 1)[:MAX_ENTRY_BYTES]
    except (OSError, zipfile.BadZipFile, RuntimeError, ValueError):
        return None


def _children(parent: ElementTree.Element | None) -> list[ElementTree.Element]:
    """`elem or []` 会触发 ElementTree 的 DeprecationWarning（空元素为假），显式判 None。"""
    return [] if parent is None else list(parent)


def _parse_xml(payload: bytes | None) -> ElementTree.Element | None:
    if not payload:
        return None
    if any(marker in payload for marker in DOCTYPE_MARKERS):
        return None
    try:
        return ElementTree.fromstring(payload)
    except ElementTree.ParseError:
        return None


def _clip(text: str) -> str:
    """超长格子截到 `MAX_CELL_CHARS`，**截了就打 `truncated` 标记**（第三次复审建议 2）。

    截断后的文字不是作者写的全文，上层拿它当「原文」去补 / 改 plan 会把半截话上屏，
    所以待校验字段落在这种格子上时只告警（与数值 / 公式格同一条路，见 `CellText`）。
    """
    if len(text) <= MAX_CELL_CHARS:
        return text
    return CellText(text[:MAX_CELL_CHARS], "truncated")


# OOXML 的 ST_Xstring 转义：XML 里放不下的字符（最常见是回车 `\r`）存成 `_xHHHH_`。
# Excel 自己写的文件里，单元格内换行常见 `_x000D_\n`（= `\r\n`）。不解码的话
# 卡片上会直接显示 `_x000D_` 这串字（2026-09-23 复盘应修 3）。
# `_x005F_` 是「下划线本身」的转义：`_x005F_x000D_` 解出来是字面量 `_x000D_`，
# 所以必须**从左到右一遍**替换，不能先后替换两次（re.sub 天然就是一遍）。
XSTRING_ESCAPE = re.compile(r"_x([0-9A-Fa-f]{4})_")
# 解出来是控制字符时只放行这三个（制表、换行、回车）；其余（`_x0000_`、`_x0007_`、C1 控制符……）
# 不是作者能在单元格里敲出来的可见文字，解出来会把不可见字符塞进卡片，原样留着又会把
# `_x0000_` 这串字渲上屏——**直接丢掉**（第二次对抗复审建议）。
XSTRING_KEPT_CONTROLS = frozenset("\t\n\r")


def decode_xstring(text: str) -> str:
    def replace(match: re.Match[str]) -> str:
        code = int(match.group(1), 16)
        if 0xD800 <= code <= 0xDFFF:
            return match.group(0)                    # 半个代理对：原样留着，不造非法字符
        char = chr(code)
        if unicodedata.category(char) == "Cc" and char not in XSTRING_KEPT_CONTROLS:
            return ""
        return char
    return XSTRING_ESCAPE.sub(replace, text) if "_x" in text else text


class CellText(str):
    """带「这格不是普通文字」标记的单元格文本。行为与 `str` 完全一样。

    `kind` 取值：`number`（数值 / 日期，读到的是原始值，`95%` 会变成 `0.95`）、
    `formula`（公式；没有缓存值时文本为空）、`boolean`、`error`、
    `truncated`（超过 `MAX_CELL_CHARS` 被截断，读到的只是前半截）。
    上层（`script_card_fields`）见到待校验字段落在这种格子上就只告警不纠正：
    我们读到的不是作者在 Excel 里看到的样子，拿它当「原文」去改 plan 会改错。
    """

    kind: str

    def __new__(cls, text: str, kind: str) -> "CellText":
        value = super().__new__(cls, text)
        value.kind = kind
        return value


def cell_kind(value: object) -> str:
    """普通文字返回 `""`；带标记的返回 `number` / `formula` / `boolean` / `error` / `truncated`。"""
    return getattr(value, "kind", "") or ""


class SheetDetail(NamedTuple):
    """一个 sheet 的完整读取结果。`merges` 是原始合并区域（行列 0 起，含首尾）。

    `hidden` 是这张 sheet 里被隐藏的列 / 行（人读的描述，如 `第 C 列`、`第 5 行`）。
    网格里照样有它们的值——隐藏的格子解析器可能读、也可能不读，上层见到就整份只告警
    （第二次对抗复审建议：隐藏的旧上屏列 / 示例行会让我们和解析器读到的不是同一份东西）。
    """
    name: str
    grid: list[list[str]]
    merges: list[tuple[int, int, int, int]]
    hidden: tuple[str, ...] = ()


# ----------------------------------------------------------------------------
# xlsx / xlsm
# ----------------------------------------------------------------------------

def column_index(reference: str) -> int | None:
    """`"AB12"` -> 27（0 起）。列字母部分非法返回 None。"""
    letters = ""
    for char in reference:
        if char.isalpha():
            letters += char.upper()
        else:
            break
    if not letters or len(letters) > 3:
        return None
    index = 0
    for char in letters:
        index = index * 26 + (ord(char) - ord("A") + 1)
    return index - 1


def _shared_strings(archive: zipfile.ZipFile) -> list[str]:
    root = _parse_xml(_read_member(archive, "xl/sharedStrings.xml"))
    if root is None:
        return []
    strings: list[str] = []
    for item in root.findall(f"{NS_SHEET}si"):
        strings.append(_clip(_si_text(item)))
    return strings


def _si_text(item: ElementTree.Element) -> str:
    """`<si>` 的文字。跳过 `<rPh>`（日文注音）——那不是单元格内容。"""
    parts: list[str] = []
    for child in item:
        tag = child.tag
        if tag == f"{NS_SHEET}rPh":
            continue
        if tag == f"{NS_SHEET}t":
            parts.append(child.text or "")
        elif tag == f"{NS_SHEET}r":
            for run_child in child:
                if run_child.tag == f"{NS_SHEET}t":
                    parts.append(run_child.text or "")
    # 共享字符串与行内字符串（inlineStr）都走这里，所以两种存法一起解码。
    return decode_xstring("".join(parts))


def _sheet_paths(archive: zipfile.ZipFile) -> list[tuple[str, str]]:
    """按 workbook 里声明的顺序给出 `(sheet 名, zip 成员路径)`。

    **名字和路径必须一起返回**：`r:id` 指向的成员不在包里时这里会跳过那张 sheet，
    而名字列表不会跳，分开取就会整体错位、把别的 sheet 的名字写进告警里
    （对抗复审建议 1）。
    """
    workbook = _parse_xml(_read_member(archive, "xl/workbook.xml"))
    relations = _parse_xml(_read_member(archive, "xl/_rels/workbook.xml.rels"))
    targets: dict[str, str] = {}
    if relations is not None:
        for relation in relations:
            identifier = relation.get("Id")
            target = relation.get("Target") or ""
            if not identifier or not target:
                continue
            target = target.lstrip("/")
            if target.startswith("xl/"):
                targets[identifier] = target
            else:
                targets[identifier] = f"xl/{target}"
    paths: list[tuple[str, str]] = []
    if workbook is not None:
        sheets = workbook.find(f"{NS_SHEET}sheets")
        for sheet in _children(sheets):
            target = targets.get(sheet.get(f"{NS_REL}id") or "")
            if target and target in archive.namelist():
                paths.append((sheet.get("name") or target, target))
    # **超限整份放弃，不截断**：截断会把上层「恰好一个 sheet 像分镜表才动手」这道闸门
    # 绕过去——被砍掉的那张也可能是分镜表（第二次对抗复审应修 2）。
    if paths:
        return [] if len(paths) > MAX_SHEETS else paths
    # workbook.xml / rels 读不出来时的兜底：按名字排 worksheets/。
    members = sorted(name for name in archive.namelist()
                     if name.startswith("xl/worksheets/") and name.endswith(".xml"))
    return [] if len(members) > MAX_SHEETS else [(name, name) for name in members]


def sheet_count(path: Path) -> int | None:
    """工作簿里声明了几张 sheet。只用来给「太多了」那条日志一个说得通的原因。

    `read_workbook` 对「读不了」和「sheet 太多主动放弃」都返回 None，上层要能分得开——
    笼统报「脚本读不出来」与实情不符（第三轮复审建议 3）。
    """
    try:
        with zipfile.ZipFile(path) as archive:
            workbook = _parse_xml(_read_member(archive, "xl/workbook.xml"))
            if workbook is not None:
                declared = len(_children(workbook.find(f"{NS_SHEET}sheets")))
                if declared:
                    return declared
            return sum(1 for name in archive.namelist()
                       if name.startswith("xl/worksheets/") and name.endswith(".xml"))
    except (OSError, zipfile.BadZipFile, ValueError):
        return None


def _cell_text(cell: ElementTree.Element, strings: list[str]) -> str:
    """单元格文本。不是「作者直接敲进去的文字」的格子返回 `CellText`（带 `kind`）。

    - 公式（有 `<f>`）：不管有没有缓存值、缓存的是什么类型，一律标 `formula`；
      没缓存值时文本为空，但**标记还在**，上层据此只告警（复盘建议：公式无缓存被判臆造）。
    - 数值 / 日期（`t` 缺省、`n`、`d`）：`<v>` 里是原始值，`95%` 读出来是 `0.95`、
      `0.3` 可能是 `0.30000000000000004`，与作者看到的不同，标 `number`。
    - 布尔 / 错误：标 `boolean` / `error`。
    """
    kind = cell.get("t") or "n"
    formula = cell.find(f"{NS_SHEET}f") is not None
    if kind == "inlineStr":
        inline = cell.find(f"{NS_SHEET}is")
        text = _clip(_si_text(inline)) if inline is not None else ""
        return CellText(text, "formula") if formula else text
    value = cell.find(f"{NS_SHEET}v")
    raw = (value.text or "") if value is not None else ""
    if kind == "s":
        try:
            text = strings[int(raw)]
        except (ValueError, IndexError):
            text = ""
        return CellText(text, "formula") if formula else text
    if kind == "str":
        text = _clip(decode_xstring(raw))
        return CellText(text, "formula") if formula else text
    if kind == "b":
        text = "TRUE" if raw.strip() == "1" else "FALSE"
        return CellText(text, "formula" if formula else "boolean")
    if kind == "e":
        return CellText("", "formula" if formula else "error")   # 公式错误当空
    return CellText(_clip(raw), "formula" if formula else "number")


def _merge_ranges(root: ElementTree.Element) -> list[tuple[int, int, int, int]]:
    """`<mergeCells>` -> [(起行, 起列, 止行, 止列)]（行列都 0 起）。"""
    ranges: list[tuple[int, int, int, int]] = []
    container = root.find(f"{NS_SHEET}mergeCells")
    for merge in _children(container):
        reference = merge.get("ref") or ""
        if ":" not in reference:
            continue
        left, right = reference.split(":", 1)
        top_column, bottom_column = column_index(left), column_index(right)
        if top_column is None or bottom_column is None:
            continue
        try:
            top_row = int("".join(c for c in left if c.isdigit())) - 1
            bottom_row = int("".join(c for c in right if c.isdigit())) - 1
        except ValueError:
            continue
        if top_row < 0 or bottom_row < top_row or bottom_column < top_column:
            continue
        ranges.append((top_row, top_column, bottom_row, bottom_column))
    return ranges


def _is_true(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true"}


def _hidden_columns(root: ElementTree.Element) -> list[str]:
    """`<cols><col min max hidden="1"/>` -> [`第 C 列`, …]（min/max 是 1 起的列号）。"""
    found: list[str] = []
    for container in root.findall(f"{NS_SHEET}cols"):
        for column in container.findall(f"{NS_SHEET}col"):
            if not _is_true(column.get("hidden")):
                continue
            try:
                first, last = int(column.get("min") or ""), int(column.get("max") or "")
            except ValueError:
                found.append("某些列")
                continue
            if last - first > 16:          # 整片隐藏（常见于把右边没用的列全藏掉）
                found.append(f"第 {first}–{last} 列")
                continue
            for number in range(first, last + 1):
                found.append(f"第 {_column_name(number - 1)} 列")
    return found


def _column_name(index: int) -> str:
    letters = ""
    index += 1
    while index:
        index, remainder = divmod(index - 1, 26)
        letters = chr(ord("A") + remainder) + letters
    return letters


def _sheet_grid(payload: bytes | None, strings: list[str]
                ) -> tuple[list[list[str]], list[tuple[int, int, int, int]], tuple[str, ...]] | None:
    root = _parse_xml(payload)
    if root is None:
        return None
    cells: dict[tuple[int, int], str] = {}
    max_row = -1
    max_column = -1
    hidden: list[str] = _hidden_columns(root)
    data = root.find(f"{NS_SHEET}sheetData")
    fallback_row = -1
    for row in _children(data):
        if row.tag != f"{NS_SHEET}row":
            continue
        try:
            row_index = int(row.get("r") or "") - 1
        except ValueError:
            row_index = fallback_row + 1
        if row_index < 0:
            row_index = fallback_row + 1
        fallback_row = row_index
        if row_index >= MAX_ROWS:
            break
        if _is_true(row.get("hidden")):
            hidden.append(f"第 {row_index + 1} 行")
        fallback_column = -1
        for cell in row:
            if cell.tag != f"{NS_SHEET}c":
                continue
            reference = cell.get("r") or ""
            column = column_index(reference)
            if column is None:
                column = fallback_column + 1
            fallback_column = column
            if column >= MAX_COLUMNS:
                continue
            text = _cell_text(cell, strings)
            if not text and not cell_kind(text):
                continue                  # 空的普通格；带标记的空格（公式无缓存）要留下标记
            cells[(row_index, column)] = text
            max_row = max(max_row, row_index)
            max_column = max(max_column, column)
    if max_row < 0:
        return [], [], tuple(hidden)

    # 合并单元格：Excel 只在左上角存值，其余格是空的。把值**只沿左上角那一列往下**摊——
    # 「一镜占多行、分镜号那列合并」是生产表格里最常见的写法。
    # **不往右摊**（2026-09-23 复盘应修 1）：口播格横向合并盖住右边的上屏列时，往右摊会
    # 凭空在上屏列里造出一段口播，校验层再拿它当「作者写的上屏文字」写进 plan。
    # 横向合并的右侧格留空；上层看到关键列被横向合并覆盖时整份只告警（见 `SheetDetail.merges`）。
    merges = _merge_ranges(root)
    for top_row, top_column, bottom_row, _bottom_column in merges:
        text = cells.get((top_row, top_column))
        if not text and not cell_kind(text):
            continue
        for row_index in range(top_row, min(bottom_row, max_row) + 1):
            cells.setdefault((row_index, top_column), text)

    width = max_column + 1
    grid = [[cells.get((row_index, column), "") for column in range(width)]
            for row_index in range(max_row + 1)]
    return grid, merges, tuple(hidden)


def read_workbook_detail(path: Path) -> list[SheetDetail] | None:
    """xlsx/xlsm 的每个 sheet -> `SheetDetail`（名字、网格、合并区域）。读不了返回 None。"""
    try:
        with zipfile.ZipFile(path) as archive:
            strings = _shared_strings(archive)
            sheets: list[SheetDetail] = []
            for name, member in _sheet_paths(archive):
                parsed = _sheet_grid(_read_member(archive, member), strings)
                if parsed is None:
                    continue
                grid, merges, hidden = parsed
                sheets.append(SheetDetail(name, grid, merges, hidden))
            return sheets or None
    except (OSError, zipfile.BadZipFile, ValueError):
        return None


def read_selected_sheet_details(path: Path, sheet_names: set[str]) -> list[SheetDetail] | None:
    """Read only the named worksheet payloads; unreadable workbooks return ``None``."""
    try:
        with zipfile.ZipFile(path) as archive:
            strings = _shared_strings(archive)
            sheets: list[SheetDetail] = []
            for name, member in _sheet_paths(archive):
                if name not in sheet_names:
                    continue
                parsed = _sheet_grid(_read_member(archive, member), strings)
                if parsed is None:
                    continue
                grid, merges, hidden = parsed
                sheets.append(SheetDetail(name, grid, merges, hidden))
            return sheets or None
    except (OSError, zipfile.BadZipFile, ValueError):
        return None


def read_workbook(path: Path) -> list[tuple[str, list[list[str]]]] | None:
    """xlsx/xlsm 的每个 sheet -> (sheet 名, 行 × 列字符串网格)。读不了返回 None。

    名字只用来写日志（比如「工作簿里有不止一个 sheet 像分镜表」那条告警）。
    需要合并区域时用 `read_workbook_detail`。
    """
    sheets = read_workbook_detail(path)
    return [(sheet.name, sheet.grid) for sheet in sheets] if sheets else None


def read_sheet_fills(path: Path, sheet_name: str) -> dict[tuple[int, int], str] | None:
    """Read solid OOXML cell fills for one sheet without changing the text reader."""
    try:
        with zipfile.ZipFile(path) as archive:
            member = next((member for name, member in _sheet_paths(archive)
                           if name == sheet_name), None)
            if member is None:
                return None
            if "xl/styles.xml" not in archive.namelist():
                return {}
            styles = _parse_xml(_read_member(archive, "xl/styles.xml"))
            sheet = _parse_xml(_read_member(archive, member))
            if styles is None or sheet is None:
                return None
            fill_values: list[str] = []
            fills = styles.find(f"{NS_SHEET}fills")
            cell_xfs = styles.find(f"{NS_SHEET}cellXfs")
            if fills is None or cell_xfs is None:
                return None
            for fill in _children(fills):
                pattern = fill.find(f"{NS_SHEET}patternFill")
                value = ""
                pattern_type = pattern.get("patternType") if pattern is not None else ""
                if pattern is not None and pattern_type == "solid":
                    color = pattern.find(f"{NS_SHEET}fgColor")
                    if color is not None:
                        rgb = (color.get("rgb") or "").upper()
                        if len(rgb) in (6, 8) and all(c in "0123456789ABCDEF" for c in rgb):
                            value = rgb[-6:]
                        elif color.get("theme") is not None:
                            value = f"theme:{color.get('theme')}"
                        elif color.get("indexed") is not None:
                            value = f"indexed:{color.get('indexed')}"
                        tint = color.get("tint")
                        if value and tint is not None:
                            try:
                                if float(tint) != 0:
                                    value += f";tint:{tint}"
                            except ValueError:
                                value += f";tint:{tint}"
                    if not value:
                        value = "solid:unknown"
                elif pattern is not None and pattern_type in {None, "", "none"}:
                    value = ""
                elif pattern is not None:
                    value = f"pattern:{pattern_type}"
                else:
                    gradient = fill.find(f"{NS_SHEET}gradientFill")
                    value = "gradient" if gradient is not None else "fill:unknown"
                fill_values.append(value)
            style_fills: list[int] = []
            for xf in _children(cell_xfs):
                try:
                    style_fills.append(int(xf.get("fillId") or "0"))
                except ValueError:
                    return None
            result: dict[tuple[int, int], str] = {}
            data = sheet.find(f"{NS_SHEET}sheetData")
            fallback_row = -1
            for row in _children(data):
                if row.tag != f"{NS_SHEET}row":
                    continue
                try:
                    row_index = int(row.get("r") or "") - 1
                except ValueError:
                    row_index = fallback_row + 1
                if row_index < 0:
                    row_index = fallback_row + 1
                fallback_row = row_index
                if row_index >= MAX_ROWS:
                    break
                if row_index < 0:
                    continue
                fallback_column = -1
                for cell in row:
                    if cell.tag != f"{NS_SHEET}c":
                        continue
                    column = column_index(cell.get("r") or "")
                    if column is None:
                        column = fallback_column + 1
                    fallback_column = column
                    if not 0 <= column < MAX_COLUMNS:
                        continue
                    try:
                        style = int(cell.get("s") or "0")
                        if not 0 <= style < len(style_fills):
                            return None
                        fill_id = style_fills[style]
                        if not 0 <= fill_id < len(fill_values):
                            return None
                        fill = fill_values[fill_id]
                    except (ValueError, IndexError):
                        return None
                    if fill:
                        result[(row_index, column)] = fill
            return result
    except Exception:
        return None


# ----------------------------------------------------------------------------
# csv
# ----------------------------------------------------------------------------

def read_csv_grid(path: Path) -> list[list[str]] | None:
    """csv -> 行 × 列。分隔符交给 `csv.Sniffer` 猜，猜不出按逗号。"""
    try:
        raw = path.read_bytes()
    except OSError:
        return None
    text = None
    for encoding in ("utf-8-sig", "gb18030"):
        try:
            text = raw.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        return None
    dialect: type[csv.Dialect] | csv.Dialect = csv.excel
    try:
        dialect = csv.Sniffer().sniff(text[:8192], delimiters=",;\t|")
    except csv.Error:
        pass
    try:
        rows = list(csv.reader(io.StringIO(text, newline=""), dialect))
    except csv.Error:
        return None
    return [[_clip(cell) for cell in row[:MAX_COLUMNS]] for row in rows[:MAX_ROWS]]


# ----------------------------------------------------------------------------
# docx
# ----------------------------------------------------------------------------

def _paragraph_text(paragraph: ElementTree.Element) -> str:
    parts: list[str] = []
    for node in paragraph.iter():
        tag = node.tag
        if tag == f"{NS_WORD}t":
            parts.append(node.text or "")
        elif tag == f"{NS_WORD}tab":
            parts.append("\t")
        elif tag in (f"{NS_WORD}br", f"{NS_WORD}cr"):
            parts.append(" ")
    return "".join(parts)


def read_docx_text(path: Path) -> str | None:
    """docx -> 纯文本，一段一行。表格里每个单元格也各占一行。

    只是把文字拿出来，`键：值` 认不认得由上层的纯文本那条路决定；认不出就零动作。
    """
    try:
        with zipfile.ZipFile(path) as archive:
            root = _parse_xml(_read_member(archive, "word/document.xml"))
    except (OSError, zipfile.BadZipFile, ValueError):
        return None
    if root is None:
        return None
    lines: list[str] = []
    for paragraph in root.iter(f"{NS_WORD}p"):
        text = _paragraph_text(paragraph).strip()
        if text:
            clipped = _clip(text)
            if cell_kind(clipped) == "truncated":
                # 文本路拼成一整串后标记就丢了；段落被截断说明读到的不是全文，整份放弃（零动作）
                return None
            lines.append(clipped)
        if len(lines) >= MAX_ROWS:
            break
    return "\n".join(lines) if lines else None


__all__ = [
    "CellText",
    "SheetDetail",
    "cell_kind",
    "decode_xstring",
    "read_workbook_detail",
    "CSV_SUFFIXES",
    "DOCX_SUFFIXES",
    "XLSX_SUFFIXES",
    "column_index",
    "MAX_SHEETS",
    "read_csv_grid",
    "read_docx_text",
    "read_workbook",
    "read_sheet_fills",
    "read_selected_sheet_details",
    "sheet_count",
]
