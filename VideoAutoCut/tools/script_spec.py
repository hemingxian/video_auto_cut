"""Shared VAC-SB-1 field contract.

Keep carrier-specific parsing out of this module.  Excel and Markdown importers
consume these names, mappings, dictionaries, and placeholder semantics.
"""
from __future__ import annotations

from script_card_fields import is_placeholder

FORMAT = "VAC-SB-1"
SHEET_INFO = "项目信息"
SHEET_SHOTS = "分镜脚本"

FIELD_NAMES = (
    "镜号", "段落", "分镜标题", "时长(秒)", "景别", "运镜", "拍摄角度", "画面内容",
    "口播", "字幕", "上屏文字", "卡片提示", "推荐素材来源", "素材要求", "搜索关键词",
    "转场", "备注", "来源/核对",
)
# Retain the list-shaped public constant used by the existing Excel importer.
HEADERS = list(FIELD_NAMES)

FIELD_KEY_BY_NAME = {
    "镜号": "shot",
    "段落": "module_label",
    "分镜标题": "title",
    "时长(秒)": "duration",
    "景别": "shot_size",
    "运镜": "camera_move",
    "拍摄角度": "camera_angle",
    "画面内容": "visual_description",
    "口播": "voice_text",
    "字幕": "subtitle",
    "上屏文字": "card_content",
    "卡片提示": "card_hint",
    "推荐素材来源": "material_source",
    "素材要求": "material_requirements",
    "搜索关键词": "search_keywords",
    "转场": "transition",
    "备注": "notes",
    "来源/核对": "review",
}
FIELD_KEYS = {index: FIELD_KEY_BY_NAME[name] for index, name in enumerate(FIELD_NAMES)
              if index in {1, 3, 4, 5, 6, 7, 11, 12, 13, 14, 15, 16}}

BODY_FIELD_NAMES = {"分镜标题", "口播", "字幕", "上屏文字"}
BODY_FIELD_KEYS = {FIELD_KEY_BY_NAME[name] for name in BODY_FIELD_NAMES}
TEXT_COLUMNS = {FIELD_NAMES.index(name) for name in BODY_FIELD_NAMES}
CRITICAL_FILL_COLUMNS = TEXT_COLUMNS | {FIELD_NAMES.index("时长(秒)")}
PRODUCTION_COLUMNS = {1, 3, 4, 5, 6, 7, 11, 12, 13, 14, 15, 16}

YELLOW, RED = "FFF2CC", "FFC7CE"
NORMAL_FILLS = {"", "FFFFFF", "F7F9FB"}
ISSUE_ACTIONS = {
    "red_cell": "请在 Excel 中核对后清除红色底色",
    "text_cell_pending": "请在 Excel 中核对正文并清除黄色底色",
    "text_cell_kind": "请把正文改为普通文本单元格",
    "status_failed": "请在 Excel 中完成核对并更新状态",
    "header_mismatch": "请恢复标准表头；若不是模板请删除项目信息中的模板版本标记",
    "unsupported_version": "请使用受支持的 VAC-SB-1 模板",
    "unexpected_error": "请检查模板文件是否完整且可读取",
    "unexpected_fill": "请清除底色后再导入",
}
CONVERSION_KEYS = {"原始脚本文件名", "原始脚本 SHA-256", "转换时间", "转换方式", "映射档案", "转换器版本"}
DICTIONARIES = {
    "shot_size": ["大远景", "远景", "全景", "中景", "中近景", "近景", "特写", "大特写", "不限"],
    "camera_move": ["固定", "推", "拉", "左摇", "右摇", "上摇", "下摇", "左移", "右移", "跟", "升", "降", "环绕", "甩", "手持", "不限"],
    "camera_angle": ["平视", "俯拍", "仰拍", "顶拍", "侧拍", "背拍", "主观视角", "倾斜", "不限"],
    "transition": ["硬切", "叠化", "淡入", "淡出", "闪白", "闪黑", "划像", "甩切", "匹配剪辑"],
}
