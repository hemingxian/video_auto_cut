#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 B7 用的**表格版 / 纯文本版**测试脚本，内容与 `03_混合_show判定_食品码垛_CN.md` 等价。

跑法（在 `VideoAutoCut/` 下）：
    python tests/make_table_test_scripts.py

写出到 `docs/packaging-test-scripts-2026-09-21/`：
    07_表格版_混合_show判定_食品码垛_CN.xlsx
    07_纯文本版_混合_show判定_食品码垛_CN.txt

xlsx 用 `tests/xlsx_fixture.py` 拼（标准库 zip+XML，与 `tools/script_tabular.py` 读的是
同一套 OOXML）——运行包里没有 openpyxl，这条链上任何一环都不许引第三方库。

**表格刻意做成真实生产脚本的形状**：上面是一块纵向的「模块一」封面文案，中间一行分节
标题，**表头在第 5 行而不是第 1 行**。03 的第 4/6 镜标题（长句 / 「开场」）原样保留，
它们是 B8 的 title 探针。
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from xlsx_fixture import write_xlsx  # noqa: E402

OUTPUT = Path(__file__).resolve().parents[2] / "docs" / "packaging-test-scripts-2026-09-21"

COLUMNS = ["分镜", "分镜标题", "时长", "章节标签", "画面", "口播", "字幕", "上屏文字", "卡片样式"]

SHOTS = [
    ("1", "来料到位是第一道关", "7 秒", "来料到位",
     "白色包装袋在输送带上排队进入抓取位，中景，看得到输送带和挡边",
     "袋装物料码垛，先看来料怎样到位，再看机械臂如何抓取和落放。",
     "先看来料到位，再看抓取落放", "来料到位是码垛稳定的第一道关", "（不填）"),
    ("2", "袋料和箱体要分开核对", "8 秒", "来料核对项",
     "包装袋与整箱瓶装饮品分别在两条输送带上前进，对比镜头",
     "袋料和箱体的外形不同，来料朝向、抓取位置和支撑方式要分别核对。",
     "袋料与箱体分别核对", "（不填）", "（不填）"),
    ("3", "镜头B", "7 秒", "抬升与转向",
     "机械臂带料抬起并转向，画面能看到包装与抓具的完整外廓",
     "抓具带料抬起、转向时，要检查包装与工具有没有碰到输送带护栏。",
     "抬升转向不碰护栏", "（不填）", "（不填）"),
    ("4", "包装落到托盘以后还要核对排列方向垛层边缘和抓具退出的路径", "7 秒", "落盘确认",
     "整箱瓶装饮品被放到塑料托盘上，托盘上已有码好的下层",
     "包装落到托盘以后，还要核对排列方向、垛层边缘和抓具退出的路径。",
     "核对方向与退出路径", "（不填）", "（不填）"),
    ("5", "换型准备", "8 秒", "换型准备",
     "工人在码垛工位旁查看新包装样件，背景是成品托盘区",
     "换包装之前，先备好新包装样件、目标垛型和现场布局，再逐项确认要调整的抓具与路径。",
     "换型前先备齐三样", "占位卡 05", "（不填）"),
    ("6", "开场", "8 秒", "工位衔接",
     "车间内取料端、输送线和托盘位置同框，能看到多台码垛机器人同时作业",
     "把取料端、输送线和托盘位置放在一起看，更容易看清工位之间的衔接。",
     "整合视图看工位衔接", "（不填）", "（不填）"),
    ("7", "欢迎带着包装形态来试", "8 秒", "现场复核",
     "机械臂将整箱瓶装饮品码到托盘上，镜头拉远露出成品托盘区",
     "动态画面只能帮着理解工位配置，破包、滑移和满垛稳定性还是要在现场试。",
     "稳定性要在现场试", "带上你的包装形态和目标垛型，一起把这条线试一遍", "CTA 行动号召"),
]

# 表头上面那块「模块一」：真实生产脚本就长这样，用来钉住「表头不在第 1 行」。
PREAMBLE = [
    ["模块一：封面文案部分"],
    ["视频标题", "食品码垛工位观察（混合上屏）"],
    ["全片副标题", "袋装与箱装同线码垛的现场核对要点"],
    ["模块二：视频分镜脚本（7 段）"],
]

TEXT_HEADER = "食品码垛工位观察（混合上屏）"
TEXT_FIELDS = ("分镜标题", "时长", "章节标签", "画面", "口播", "字幕", "上屏文字", "卡片样式")


def build_rows() -> list[list[str | None]]:
    rows: list[list[str | None]] = [list(row) for row in PREAMBLE]
    rows.append(list(COLUMNS))
    rows.extend(list(shot) for shot in SHOTS)
    return rows


def build_text() -> str:
    lines = [TEXT_HEADER, ""]
    for shot in SHOTS:
        lines.append(f"分镜 {shot[0]}")
        for label, value in zip(TEXT_FIELDS, shot[1:]):
            lines.append(f"- {label}：{value}")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    workbook = OUTPUT / "07_表格版_混合_show判定_食品码垛_CN.xlsx"
    write_xlsx(workbook, [("视频脚本", build_rows())])
    plain = OUTPUT / "07_纯文本版_混合_show判定_食品码垛_CN.txt"
    plain.write_text(build_text(), encoding="utf-8")
    print(f"写出: {workbook}")
    print(f"写出: {plain}")


if __name__ == "__main__":
    main()
