# -*- coding: utf-8 -*-
"""转换演示：客户脚本 -> 标准模板 VAC-SB-1。

- 表格型（上下料B端视频脚本_v1.xlsx）：确定性列映射，原文逐字搬运；制作字段由「AI」建议（此处为人工代拟，标黄）。
- 文本型（v2C .md）：抽取（此处用小脚本 + 人工判断代替大模型，不调外部 API），制作字段建议标黄。
两份都跑逐字出处校验，失败格标红、该镜状态=校验失败。
原文含国内/海外两个版本的镜：口播/字幕/上屏文字/分镜标题里含版本标记的格标黄、状态=待确认并写明原因
（2026-09-23 用户拍板：正文黄格禁止导入，这份文件因此是一个「被拦下」的真实负例）。

用法（客户原始脚本不入库，路径由命令行给出）：
    python3 convert_demo.py --orig-dir <客户原文目录> --out <输出目录> [--only v1|md|all]

    --orig-dir  放着「上下料B端视频脚本_v1.xlsx」和「上下料科普脚本_v2C_…_5个最常见的误区.md」的目录
                （Mac 当时的位置是 ~/Desktop/临时/上下料资料总结-20260831/05_视频脚本）
    --out       输出目录，写 转换演示_v1表格.xlsx / 转换演示_md文本.xlsx / _map_上下料B端_v1格式.json
    --only      只重生成其中一份（默认 all）；另一份不动，避免「转换时间」无谓变化
    --v1-name / --md-name  原文文件名不同时覆盖
标准输出打印逐字出处校验结果（JSON）。
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
from pathlib import Path

import openpyxl

import provenance as pv
import vac_template as vt

HERE = Path(__file__).resolve().parent
SCR = HERE.parent
V1_NAME = "上下料B端视频脚本_v1.xlsx"
MD_NAME = "上下料科普脚本_v2C_机床上下料自动化_5个最常见的误区.md"
NOW = dt.datetime.now().strftime("%Y-%m-%d %H:%M")
CONVERTER = "转换演示 demo-0.1（本地脚本，未调外部 API）"
AI_FIELDS = ("段落", "景别", "运镜", "拍摄角度", "画面内容", "搜索关键词", "转场")
VERSION_MARK = re.compile(r"国内版|海外版|（国内|（海外|国内：|海外：|中文版|英文版")
TEXT_FIELDS = ("分镜标题", "口播", "字幕", "上屏文字")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# ============================================================ 表格型：列映射
V1_MAPPING = {
    "profile": "上下料B端_v1格式",
    "sheet": "分镜脚本",
    "header_row": 1,
    "columns": {
        "拍": {"to": "镜号"},
        "段落": {"to": "段落"},
        "时长s": {"to": "时长(秒)"},
        "中文旁白": {"to": "口播"},
        "屏字/大字": {"to": "上屏文字"},
        "原创图层": {"to": "卡片提示"},
        "画面(素材文件,相对本文件夹)": {"to": "推荐素材来源", "prefix": "指定："},
        "取段": {"to": "推荐素材来源", "prefix": "取段："},
        "处理要求": {"to": "素材要求"},
        "备注": {"to": "备注"},
        "事实编号": {"to": "备注", "prefix": "事实编号："},
    },
    "ignored_columns": ["时间码(入)", "时间码(出)", "英文旁白"],
    "ignored_sheets": ["旁白纯文本", "红线自查", "素材对照", "图层与待确认"],
    "note": "英文旁白另转一份英文模板；时间码由时长推算，不搬。",
}

# 「AI」对制作字段的建议（按原文的画面/取段/图层推断）；逐镜：段落以外的 AI 字段
V1_AI = {
    1: dict(景别="全景", 运镜="推", 拍摄角度="平视",
            画面内容="机床全景起幅，机器人从机床里取出工件，切到取件近景",
            搜索关键词="机床 机器人 取件, CNC machine tending robot", 转场="淡入"),
    2: dict(景别="全景", 运镜="固定", 拍摄角度="俯拍",
            画面内容="俯拍一台供料专机：机器人、毛坯盘、成品盘和机床操作面同框",
            搜索关键词="供料专机 料盘 俯拍, tray type tending cell"),
    3: dict(景别="近景", 运镜="固定", 拍摄角度="顶拍",
            画面内容="双料盘对比，转台和吸盘供料、定位抓取",
            搜索关键词="料仓 转台 吸盘 定位, rotary magazine suction cup locating"),
    4: dict(景别="远景", 运镜="右移", 拍摄角度="平视",
            画面内容="多台机床成线，输送线与料盘上料",
            搜索关键词="机床 产线 输送线 检测, machining line conveyor inspection"),
    5: dict(景别="全景", 运镜="固定", 拍摄角度="平视",
            画面内容="供料专机正面全景定格，参数卡叠在右侧",
            搜索关键词="供料专机 正面, feeder unit front view"),
    6: dict(景别="全景", 运镜="固定", 拍摄角度="平视",
            画面内容="左：成品盘特写；右：一台机器人服务三台机床、重载刹车盘守机",
            搜索关键词="一拖三 机床 上下料 重载, one robot multiple machines"),
    7: dict(景别="中景", 运镜="不限", 拍摄角度="不限",
            画面内容="不同行业工件机加工上下料快切：汽车零件、散热片、刹车盘",
            搜索关键词="机加工 上下料 汽车零件 散热片, machining loading auto parts", 转场="甩切"),
    8: dict(景别="全景", 运镜="拉", 拍摄角度="平视",
            画面内容="机床全景拉回，机器人继续循环",
            搜索关键词="机器人 机床 全景, robot CNC wide shot", 转场="淡出"),
}


def convert_v1(src: Path):
    wb = openpyxl.load_workbook(src, data_only=True)
    segments = []
    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for c in row:
                if isinstance(c.value, str) and c.value.strip():
                    segments.append((f"{ws.title}!{c.coordinate}", c.value))
    ws = wb[V1_MAPPING["sheet"]]
    head = [c.value for c in ws[V1_MAPPING["header_row"]]]
    shots, marks, provenance_rows = [], {}, []
    for r in range(V1_MAPPING["header_row"] + 1, ws.max_row + 1):
        row = {h: ws.cell(row=r, column=i + 1).value for i, h in enumerate(head)}
        if row.get("拍") in (None, ""):
            continue
        shot: dict = {}
        for src_col, rule in V1_MAPPING["columns"].items():
            v = row.get(src_col)
            if v in (None, ""):
                continue
            v = str(v).strip() if not isinstance(v, (int, float)) else v
            to = rule["to"]
            if isinstance(v, str) and pv.is_placeholder(v) and to in ("备注", "素材要求", "推荐素材来源"):
                continue
            if isinstance(v, str) and rule.get("prefix"):
                v = rule["prefix"] + v
            if to in shot and isinstance(v, str):
                shot[to] = f"{shot[to]}\n{v}"
            else:
                shot[to] = v
        n = int(shot["镜号"])
        idx = len(shots)
        for k, v in V1_AI.get(n, {}).items():
            shot[k] = v
            marks[(idx, k)] = "ai"
        notes = []
        versioned = [f for f in TEXT_FIELDS if VERSION_MARK.search(str(shot.get(f) or ""))]
        if versioned:
            for f in versioned:
                marks[(idx, f)] = "ai"     # 标黄 = 待确认；正文黄格导入闸门会拦下
            notes.append("原文含国内/海外两个版本，请删掉本片不用的版本（只能删，不能改字）")
            notes.append(f"待确认原因：{'、'.join(versioned)} 已标黄——原文同时写了国内版和海外版，"
                         "直接导入会两版一起上屏；删掉不用的版本、清掉黄色、状态改为「已确认」后才能导入")
        shot["_notes"] = notes
        shot["_where"] = f"原文：{src.name} › {ws.title} › 第 {r} 行"
        shot["_own"] = [(f"{ws.title}!{ws.cell(row=r, column=i + 1).coordinate}", str(v))
                        for i, v in enumerate(row.values()) if isinstance(v, str) and v.strip()]
        shots.append(shot)
    return shots, marks, segments


# ============================================================ 文本型：抽取
MD_AI = {
    1: dict(段落="钩子", 景别="全景", 运镜="推", 拍摄角度="平视",
            画面内容="机床与机器人全景，大字「5 个误区」弹出",
            搜索关键词="机床 机器人 全景, CNC robot cell wide", 转场="淡入"),
    2: dict(段落="误区", 景别="近景", 运镜="固定", 拍摄角度="顶拍",
            画面内容="俯看双料盘，随后是 3D 视觉定位抓取",
            搜索关键词="料盘 定位 抓取, tray part locating"),
    3: dict(段落="误区", 景别="全景", 运镜="右摇", 拍摄角度="平视",
            画面内容="一台机器人在多台机床之间转身服务",
            搜索关键词="一拖多 机床 上下料, one robot multiple CNC"),
    4: dict(段落="误区", 景别="近景", 运镜="固定", 拍摄角度="侧拍",
            画面内容="快节拍取放特写，接重载刹车盘守机",
            搜索关键词="快节拍 取放 刹车盘, fast cycle pick place"),
    5: dict(段落="误区", 景别="全景", 运镜="固定", 拍摄角度="平视",
            画面内容="单工位立式加工中心，对照外圆磨床",
            搜索关键词="立式加工中心 外圆磨, vertical machining centre"),
    6: dict(段落="误区", 景别="远景", 运镜="左移", 拍摄角度="俯拍",
            画面内容="刹车盘产线输送段，复合机器人 AGV 对接机床",
            搜索关键词="产线 AGV 复合机器人, AGV mobile manipulator CNC"),
    7: dict(段落="收束", 景别="全景", 运镜="拉", 拍摄角度="平视",
            画面内容="镜头拉回机床全景，机器人继续循环",
            搜索关键词="机器人 机床 全景, robot CNC wide shot", 转场="淡出"),
}
HEAD = re.compile(r"^###\s*拍\s*(\d+)\s*｜\s*(.+?)（[^）]*?(\d+)s）\s*$")
ROW = re.compile(r"^\|\s*([^|]+?)\s*\|\s*(.*?)\s*\|\s*$")


def convert_md(src: Path):
    lines = src.read_text(encoding="utf-8").splitlines()
    segments = [(f"{src.name} 第 {i} 行", t) for i, t in enumerate(lines, 1) if t.strip()]
    shots, marks = [], {}
    cur = None
    for i, line in enumerate(lines, 1):
        m = HEAD.match(line)
        if m:
            cur = {"镜号": int(m.group(1)), "分镜标题": m.group(2).strip(),
                   "时长(秒)": int(m.group(3)), "_start": i, "_end": i,
                   "_cells": [(f"{src.name} 第 {i} 行 标题", m.group(2).strip())]}
            shots.append(cur)
            continue
        if line.startswith("## "):
            cur = None
        if cur is None:
            continue
        rm = ROW.match(line)
        if not rm or rm.group(1) in ("项", "---"):
            continue
        key, val = rm.group(1), rm.group(2)
        cur["_end"] = i
        cur["_cells"].append((f"{src.name} 第 {i} 行「{key}」格", val))
        target = {"旁白": "口播", "屏字": "上屏文字", "图层": "卡片提示", "处理": "素材要求"}.get(key)
        if target:
            cur[target] = val
        elif key == "画面":
            cur["推荐素材来源"] = "指定：" + val + cur.get("推荐素材来源", "")
        elif key == "取段":
            cur["推荐素材来源"] = cur.get("推荐素材来源", "") + "\n取段：" + val
        elif key in ("事实", "备注"):
            if val and not pv.is_placeholder(val):
                prefix = "事实编号：" if key == "事实" else ""
                cur["备注"] = (cur.get("备注", "") + "\n" + prefix + val).strip()
    for idx, shot in enumerate(shots):
        for k, v in MD_AI.get(shot["镜号"], {}).items():
            shot[k] = v
            marks[(idx, k)] = "ai"
        shot["_notes"] = []
        a, b = shot.pop("_start"), shot.pop("_end")
        shot["_own"] = shot.pop("_cells")
        shot["_where"] = f"原文：{src.name} › 拍 {shot['镜号']}（第 {a}–{b} 行）"
    return shots, marks, segments


# ============================================================ 收尾：校验 + 状态列 + 写文件
def finish(shots, marks, segments, out: Path, project: dict, project_ai: set):
    owns = [shot.pop("_own", []) for shot in shots]
    checks = pv.check_shots(shots, segments, prefer=lambda i: owns[i])
    bad_rows = set()
    for c in checks:
        if not c["ok"]:
            marks[(c["row"], c["field"])] = "bad"
            bad_rows.add(c["row"])
    for idx, shot in enumerate(shots):
        ai = [k for k in AI_FIELDS if marks.get((idx, k)) == "ai"]
        bad = [c for c in checks if c["row"] == idx and not c["ok"]]
        status = "校验失败" if bad else "待确认"
        lines = [status, shot.pop("_where")]
        if ai:
            lines.append("AI建议：" + "、".join(ai))
        for c in bad:
            lines.append(f"出处不符：{c['field']} {c['where']}")
        for c in checks:
            if c["row"] == idx and c["ok"] and c.get("partial"):
                lines.append(f"部分摘取：{c['field']} 只取了原文 {c['where']} 的一部分，请确认没漏掉要说的内容")
        lines.extend(shot.pop("_notes"))
        shot["来源/核对"] = "\n".join(lines)
    vt.build_workbook(out, shots=shots, project=project, marks=marks, project_ai=project_ai)
    return checks


def main(outdir: Path, orig_dir: Path, only: str = "all",
         v1_name: str = V1_NAME, md_name: str = MD_NAME):
    outdir.mkdir(parents=True, exist_ok=True)
    report = {}
    if only in ("all", "v1"):
        _main_v1(outdir, orig_dir / v1_name, report)
    if only in ("all", "md"):
        _main_md(outdir, orig_dir / md_name, report)
    return report


def _main_v1(outdir: Path, src: Path, report: dict):
    shots, marks, segs = convert_v1(src)
    project = {
        "片名": "CNC 机床上下料 · B 端口播讲解版", "客户/品牌": "EVST",
        "视频类型": "产品宣传", "画幅": "16:9", "语言": "中文", "目标时长(秒)": "90–120",
        "配音音色": "zh-CN-YunjianNeural（原文待确认：真人口播还是 TTS）", "配音语速": "4.2 字/秒（rate=+18%）",
        "品牌主色": "#17191C", "品牌强调色": "#FF7A33",
        "字幕样式": "描边 + 关键词高亮，不压深色底带", "角标/Logo": "EVST 右上角标常驻（见原文第 8 拍图层）",
        "禁止出现": "供应商名称/拼音/Logo；第三方机床铭牌；素材文件名里的客户名",
        "原始脚本文件名": src.name, "原始脚本 SHA-256": sha256(src), "转换时间": NOW,
        "转换方式": "列映射", "映射档案": "map_上下料B端_v1格式.json（见本演示脚本 V1_MAPPING）",
        "转换器版本": CONVERTER,
    }
    ai_keys = {"片名", "视频类型", "目标时长(秒)", "配音音色", "配音语速", "品牌主色", "品牌强调色",
               "字幕样式", "角标/Logo", "禁止出现", "画幅"}
    report["v1"] = finish(shots, marks, segs, outdir / "转换演示_v1表格.xlsx", project, ai_keys)
    report["v1_shots"] = shots
    (outdir / "_map_上下料B端_v1格式.json").write_text(
        json.dumps(V1_MAPPING, ensure_ascii=False, indent=1), encoding="utf-8")


def _main_md(outdir: Path, src: Path, report: dict):
    shots, marks, segs = convert_md(src)
    project = {
        "片名": "机床上下料自动化，5 个最常见的误区", "客户/品牌": "无品牌（不提 EVST、不提任何供应商/品牌）",
        "视频类型": "科普讲解", "画幅": "16:9", "语言": "中文", "目标时长(秒)": "约 82",
        "配音音色": "zh-CN-YunjianNeural 或真人", "配音语速": "4.2 字/秒（rate=+18%）",
        "品牌主色": "#17191C", "品牌强调色": "#FF7A33",
        "字幕样式": "旁白 lower-third：描边 + 关键词高亮，不压深色底带", "角标/Logo": "不放任何角标/logo",
        "禁止出现": "公司名、品牌名、拼音、Logo；机床铭牌、控制柜大字、角落台标",
        "原始脚本文件名": src.name, "原始脚本 SHA-256": sha256(src), "转换时间": NOW,
        "转换方式": "大模型抽取", "映射档案": "—（文本型不用映射）",
        "转换器版本": CONVERTER + "；抽取由本地脚本+人工判断代替大模型",
    }
    ai_keys = {"视频类型", "目标时长(秒)", "配音音色", "字幕样式", "禁止出现"}
    report["md"] = finish(shots, marks, segs, outdir / "转换演示_md文本.xlsx", project, ai_keys)
    report["md_shots"] = shots


def cli(argv=None):
    ap = argparse.ArgumentParser(description="转换演示：客户脚本 -> 标准模板 VAC-SB-1（本地、确定性、不调外部 API）")
    ap.add_argument("--orig-dir", required=True, type=Path, help="客户原始脚本所在目录（原文不入库）")
    ap.add_argument("--out", required=True, type=Path, help="输出目录")
    ap.add_argument("--only", choices=("all", "v1", "md"), default="all", help="只重生成一份（默认 all）")
    ap.add_argument("--v1-name", default=V1_NAME, help=f"表格型原文文件名（默认 {V1_NAME}）")
    ap.add_argument("--md-name", default=MD_NAME, help=f"文本型原文文件名（默认 {MD_NAME}）")
    a = ap.parse_args(argv)
    for name in ((a.v1_name,) if a.only == "v1" else (a.md_name,) if a.only == "md" else (a.v1_name, a.md_name)):
        if not (a.orig_dir / name).is_file():
            ap.error(f"找不到原文：{a.orig_dir / name}")
    rep = main(a.out, a.orig_dir, a.only, a.v1_name, a.md_name)
    print(json.dumps({k: rep[k] for k in ("v1", "md") if k in rep}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    cli()
