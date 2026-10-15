# -*- coding: utf-8 -*-
"""逐字出处校验：模板里的口播 / 字幕 / 上屏文字 / 分镜标题必须能在客户原文里逐字找到。

允许的差异只有：空白与换行（比较时全部去掉）、行首版式标签（大字：副行：小字：参数卡：决策树：，
两边都去掉——它们是模板语法，不是正文）。占位（- — 无 …）与空格子不校验。
整格必须是同一段原文里连续的一段（逐字子串）；只取了一部分的，标「部分摘取」待人确认。
"""
from __future__ import annotations

import re

CHECK_FIELDS = ("口播", "字幕", "上屏文字", "分镜标题")
LABEL = re.compile(r"(?:大字|副行|小字|参数卡|决策树)[ \t　]*[:：][ \t　]*")
WS = re.compile(r"\s+")
PLACEHOLDER = {"", "-", "—", "——", "–", "/", "／", "无", "没有", "暂无", "空", "留空", "空白",
               "不填", "不上屏", "n/a", "（不填）", "（无）"}


def norm(text: str) -> str:
    return WS.sub("", LABEL.sub("", str(text or "")))


def is_placeholder(text: str) -> bool:
    return WS.sub("", str(text or "")).lower() in PLACEHOLDER


def locate(cell: str, segments: list[tuple[str, str]]) -> tuple[bool, str, bool]:
    """返回 (通过?, 命中位置或失败原因, 是否只取了那段原文的一部分)。

    规则：整格（去掉版式标签、去掉全部空白换行后拼成一串）必须是**某一段原文**里连续的一段。
    所以中间删字、把分隔符（／ ｜）换成换行、调换行序、改标点，都会失败。
    """
    target = norm(cell)
    if not target:
        return True, "（空/占位，不校验）", False
    first_partial = None
    for where, text in segments:
        hay = norm(text)
        if target == hay:
            return True, where, False          # 与某一格原文完全相同，优先
        if target in hay and first_partial is None:
            first_partial = where
    if first_partial is not None:
        return True, first_partial, True
    lines = [norm(line) for line in str(cell).split("\n") if norm(line)]
    missing = next((line for line in lines
                    if not any(line in norm(t) for _w, t in segments)), None)
    if missing:
        return False, f"原文里找不到「{missing[:24]}」", False
    return False, "每一行都在原文里，但拼起来不连续（中间删了字、换了分隔符或调换了顺序）", False


def check_shots(shots: list[dict], segments: list[tuple[str, str]], prefer=None) -> list[dict]:
    """prefer(i) -> 这一镜在原文里的「本镜位置」片段列表，优先在那里找（找不到再全文找）。"""
    results = []
    for i, shot in enumerate(shots):
        own = prefer(i) if prefer else []
        for field in CHECK_FIELDS:
            value = shot.get(field)
            if value in (None, "") or is_placeholder(value):
                continue
            ok, where, partial = locate(value, own + segments)
            results.append({"row": i, "shot": shot.get("镜号"), "field": field,
                            "ok": ok, "where": where, "partial": partial})
    return results
