# -*- coding: utf-8 -*-
"""生成 示例_食品码垛_v1.xlsx（样式与 分镜脚本示例_上下料_v1.xlsx 一致，同一生成器）。"""
from pathlib import Path
import vac_template as vt
import example_data_food as ex

OUT = Path(__file__).resolve().parent.parent / "示例_食品码垛_v1.xlsx"
vt.build_workbook(OUT, shots=ex.SHOTS, project=ex.PROJECT)
print(OUT)
