# -*- coding: utf-8 -*-
"""自检：示例_食品码垛_v1.md 与 示例_食品码垛_v1.xlsx 逐字段一致（0.5.16 步骤 0）。

两边用**不同的读取代码**，避免生成器自己的错误被自己放过：
- xlsx 侧：仓库导入器同款读取（`script_tabular.read_selected_sheet_details` + `authored_field_value`，
  即 0.5.15 模板导入器实际看到的值），不用 openpyxl；
- md 侧：本文件里一个按 docs/script-input-0.5.16-2026-10-08.md §4.1 写的最小解析器（与生成器无共享代码）。
比较：17 个分镜字段 × 每镜逐字相等（含换行），镜数、镜号顺序相等；项目信息键值逐字相等
（xlsx 侧剔除表头行「项目」和公式格，理由见需求单 §4.2）。

用法：VAC_TOOLS=<仓库>/VideoAutoCut/tools python3 check_md_vs_xlsx.py [md 路径]
     --selftest 额外跑 3 个改坏的副本，确认检查器会报错。
退出码：0 = 一致；1 = 不一致。
"""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
TOOLS = Path(os.environ.get("VAC_TOOLS") or ROOT.parent.parent / "VideoAutoCut" / "tools")
sys.path.insert(0, str(TOOLS))
from script_card_fields import authored_field_value  # noqa: E402
from script_tabular import read_selected_sheet_details  # noqa: E402

HEADERS = ["镜号", "段落", "分镜标题", "时长(秒)", "景别", "运镜", "拍摄角度", "画面内容",
           "口播", "字幕", "上屏文字", "卡片提示", "推荐素材来源", "素材要求", "搜索关键词",
           "转场", "备注", "来源/核对"]
SECTION = re.compile(r"^##[ \t]+(.+?)[ \t]*$")
SHOT = re.compile(r"^分镜[ \t]*(\d+)(?:[ \t]*[｜|].*)?$")
FIELD = re.compile(r"^-[ \t]+(?:\*\*)?([^:：*]+?)(?:\*\*)?[ \t]*[:：][ \t]*(.*)$")


def parse_md(text: str) -> tuple[dict[str, str], list[tuple[int, dict[str, str]]]]:
    info: dict[str, str] = {}
    shots: list[tuple[int, dict[str, str]]] = []
    target: dict[str, str] | None = None
    key = None
    buffer: list[str] = []

    def flush() -> None:
        nonlocal key, buffer
        if target is not None and key is not None:
            if key in target:
                raise ValueError(f"字段重复：{key}")
            target[key] = "\n".join(buffer).strip()
        key, buffer = None, []

    for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        section = SECTION.match(line)
        if section:
            flush()
            name = section.group(1)
            shot = SHOT.match(name)
            if name == "项目信息":
                target = info
            elif shot:
                target = {}
                shots.append((int(shot.group(1)), target))
            else:
                raise ValueError(f"不认识的小节：{line}")
            continue
        if target is None:
            continue                      # 第一个 ## 之前：标题和说明，忽略
        field = FIELD.match(line)
        if field and not line.startswith((" ", "\t")):
            flush()
            key, buffer = field.group(1).strip(), ([field.group(2)] if field.group(2) else [])
        elif line.startswith(("  ", "\t")) and key is not None:
            buffer.append(line[2:] if line.startswith("  ") else line[1:])
        elif not line.strip():
            flush()
        else:
            raise ValueError(f"无法解析的行：{line!r}")
    flush()
    return info, shots


def read_xlsx(path: Path) -> tuple[dict[str, str], list[dict[str, str]]]:
    sheets = {s.name: s for s in read_selected_sheet_details(path, {"项目信息", "分镜脚本"})}
    info = {}
    for row in sheets["项目信息"].grid[1:]:
        key = str(row[0]).strip() if row else ""
        value = authored_field_value(row[1]) if len(row) > 1 else ""
        if key and value:
            info[key] = value
    grid = sheets["分镜脚本"].grid
    assert [str(x).strip() for x in grid[0][:18]] == HEADERS, "xlsx 表头不是 VAC-SB-1"
    shots = []
    for row in grid[1:]:
        values = {HEADERS[i]: authored_field_value(row[i]) if i < len(row) else "" for i in range(18)}
        if any(values.values()):
            shots.append(values)
    return info, shots


def compare(md_text: str, xlsx: Path) -> list[str]:
    problems = []
    md_info, md_shots = parse_md(md_text)
    x_info, x_shots = read_xlsx(xlsx)
    if md_info != x_info:
        for k in sorted(set(md_info) | set(x_info)):
            if md_info.get(k) != x_info.get(k):
                problems.append(f"项目信息 {k}: md={md_info.get(k)!r} xlsx={x_info.get(k)!r}")
    if [n for n, _ in md_shots] != list(range(1, len(x_shots) + 1)):
        problems.append(f"镜号: md={[n for n, _ in md_shots]} xlsx=1..{len(x_shots)}")
    for (number, md_shot), x_shot in zip(md_shots, x_shots):
        if str(number) != x_shot["镜号"]:
            problems.append(f"第{number}镜 镜号: xlsx={x_shot['镜号']!r}")
        for key in HEADERS[1:]:
            if md_shot.get(key, "") != x_shot[key]:
                problems.append(f"第{number}镜 {key}: md={md_shot.get(key, '')!r} xlsx={x_shot[key]!r}")
        for key in set(md_shot) - set(HEADERS):
            problems.append(f"第{number}镜 多出字段 {key}")
    return problems


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    md = Path(args[0]) if args else ROOT / "示例_食品码垛_v1.md"
    xlsx = ROOT / "示例_食品码垛_v1.xlsx"
    text = md.read_text(encoding="utf-8")
    problems = compare(text, xlsx)
    _, shots = parse_md(text)
    cells = sum(len(s) for _, s in shots)
    print(f"{md.name} vs {xlsx.name}: {len(shots)} 镜, md 非空字段 {cells} 个, 不一致 {len(problems)} 处")
    for p in problems:
        print("  " + p)
    if "--selftest" in sys.argv:
        bad = {
            "口播少一个字": text.replace("就是码垛。", "就是码。", 1),
            "上屏两行换序": text.replace("  大字：一层码满\n  大字：再码下一层", "  大字：再码下一层\n  大字：一层码满", 1),
            "字幕全角改半角": text.replace("先备好四样：箱体", "先备好四样:箱体", 1),
        }
        for name, mutated in bad.items():
            assert mutated != text, name
            found = compare(mutated, xlsx)
            print(f"  selftest {name}: {'能抓到' if found else '没抓到!'}（{len(found)} 处）")
            if not found:
                problems.append(f"selftest 失败：{name}")
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
