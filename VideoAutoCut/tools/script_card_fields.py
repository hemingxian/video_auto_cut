#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""上屏字段（`card_content` / `card_hint`）与分镜标题（`title`）的确定性校验——不依赖模型。

**为什么要有这一层。** 脚本文档是交给 qwen-long 读的（`normalize_script.py`），
2026-09-21 Windows 回帖 51296044 记了实测：5 份测试脚本被解析器改了 14 处——
03 第 1 镜的 `card_content` 整条丢失、中文 `card_hint` 被翻成英文、作者写「（不填）」
的地方凭空造出 6 条 hint，03 第 4/6 镜的 `title` 被改写。在「只按脚本上屏」口径下
（`VIDEOAUTO_PACKAGING_SCRIPT_ONLY` 默认开），`card_content` 写没写直接决定这一镜上不
上卡片，解析器丢一条就等于作者写的上屏文字整条不见——**这是单点失效**，所以在 plan
出来之后拿脚本原文再对一遍。`title` 会上进度条、老路径下还会当卡片文字，2026-09-21
用户拍板一并纳入同一套逐字校验。

**口径（与 `template_packaging` 一致）**：上屏内容一律以脚本原文为准，模型既不产出
也不改写。所以这里发现不一致时**以脚本原文为准自动纠正 plan**，并打告警 + 一条
`VACUT_EVENT`。

**覆盖哪些格式**（2026-09-21 扩）。`normalize_script.py` 本身**没有**本地读脚本的代码：
它把文件原样传给 DashScope 由 qwen-long 在服务端抽文字，抽出来的文本不回本地，
所以「复用同一套读取结果」这条路不存在。运行包里是嵌入式 Python（无 pip、无
site-packages），`tools/` 全仓零第三方依赖，于是这一层只用标准库自己读（`script_tabular`）：

| 格式 | 怎么读 | 走哪条路 |
|---|---|---|
| `.md` `.txt` `.json` `.srt` | 直接按文本读 | 「分镜 N」块 + `键：值` 行 |
| `.xlsx` `.xlsm` | `zipfile` + `xml.etree`（OOXML 就是 zip+XML） | 表头识别列名，每个数据行 = 一镜 |
| `.csv` | `csv` | 先按表格；表头认不出来再退回文本路 |
| `.docx` | `zipfile` + `xml.etree`（`word/document.xml`） | 取出纯文本后走文本路 |
| `.pdf` `.doc` `.xls` | 标准库读不了 | **零动作**（只打一行说明） |

**设计原则：宁可漏报，绝不误改。** 自动纠正是会真的改 plan 的，把对的改坏比不查还糟，
所以每一道判断拿不准就退回「只告警不改」，任何情况下都不中断任务。

**三档（2026-09-23 用户拍板，报告里的 `tier`）**：`certain` 确定 / `warn_only` 只告警 /
`skipped` 跳过。表格路**只有百分之百认准表头才进确定档**，判据见
`table_certainty_problems`（白名单原名命中、有待校验字段列、全工作簿没有第二行带上屏/标题列
的表头——逐字重复的表头也算、关键列不涉及横向合并 / 跨镜纵向合并、选中 sheet 没有隐藏列/行）；
任一条不满足整份只告警、一个字不改。
表里没有上屏文字 / 卡片样式列时这两个字段**绝不清空**（只告警）。
数值 / 公式格上的待校验字段只告警。隔着整行空白 / 重复表头又冒出来的同号行、无号行
（示例块、表尾说明）让它并进的那一镜只告警。上屏列行首的版式标签（`LAYOUT_LABELS`）剥掉不上屏，
但按标签组合给这一镜写 `card_layout`（见 `CARD_LAYOUTS`；只在这一镜能自动纠正的前提下写）。
纯符号 / 「空白」「不上屏」等**确定**占位一律当没写；原文带「不上屏 / 不填 / 留空」字样的「丢失」只告警不补。
2026-09-23 第三次复审再收紧（都只往「少改」走）：只**像**占位的（`没有！` `——（不填）`）、上屏列里
**某一行**是占位而整格不是的（`大字：抓取卡↵副行：（不填）`）、行首标签没写冒号的（`大字 A句`）、
正文中间留着 `**` 的、超长被截断的格子 -> 该镜该字段只告警、不带版式；表头与第一个镜号之间
有内容 / 镜号的行（片头）-> 整份只告警。
具体闸门：

- 读不到原文（pdf / doc / xls，或文件坏了）→ **零动作**；
- 文本路：找不到「分镜 N」这类分镜标记，或标记编号不是严格 1..N → **零动作**；
- 表格路：认不出表头（识别到的列名太少）、分镜号列不是严格 1..N、
  同一个校验字段对应到两列（中英双语表）→ **零动作或该字段只告警**；
- 分镜块数与 plan 的分镜数对不上 → **只告警不改**（镜号会错位）；
- **这一镜的身份没被内容锚点（口播 / 字幕 / 分镜标题）确认** → 该镜**只告警不改**。
  qwen 允许合并/拆分分镜，块数相等不代表镜号对得上，光数数会静默错位；
- 同一镜里同一个字段写了多行（表格里是一镜多行给了两个不同值），或值疑似跨行续写
  → 该镜该字段**只告警不改**；
- 要清空一个字段（判「臆造」）或换掉一个字段（判「改写」）时，**先看本镜块里有没有
  一条「本表不认识的字段名」的行 / 列写着 plan 里那个值**——有就说明作者其实写了、
  只是用了别的叫法，解析器抽对了，**只告警不改**（最危险的一条路径，见回帖复审 B1）。
  2026-09-21 收窄：只看**认不出来的**那些键。原来把所有字段行的值都算进去，于是
  「解析器把字幕原样抄进 title / card_content」这种**恰恰要纠正**的情况也被一起挡住了
  （03 第 6 镜的 title 就是它自己的字幕原文）。收窄后那条闸门本来要挡的场景
  （作者用了表外字段名）一字不差地仍然挡得住。

**`title` 的额外规则（与上屏字段不同的那一条）**：`title` 有 schema 兜底——
脚本没写标题时 `normalize_script.compact_plan` / `shot_plan_schema` 会填「分镜N」
（`shot_plan_schema.py:184`）。所以**脚本原文没写标题时，plan 里那个自拟/兜底的标题
不算「臆造」，不清空**；只有「原文写了而 plan 不同或为空」才纠正。
`module_label`（进度条章节名）是解析器按规则生成的，不是作者原文，**不纳入**。

`VIDEOAUTO_SCRIPT_CARD_AUTOFIX=0` 可以只告警不纠正（默认开）。

**日志一律只用 ASCII 符号 + 中日韩汉字**：中文 Windows 的 stdout 重定向到文件时按 gbk 编码，
`⚠`/`✓`（U+26A0 / U+2713）编不出来会当场抛 `UnicodeEncodeError`——这一层的兜底日志自己
要是崩了，「绝不带倒脚本解析」的承诺就失效了（shots.json 会写不出来）。
"""
from __future__ import annotations

import copy
import json
import re
import sys
import unicodedata
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import env_bool  # noqa: E402
import script_tabular  # noqa: E402

AUTOFIX_ENV = "VIDEOAUTO_SCRIPT_CARD_AUTOFIX"
# 校验哪些字段。顺序 = 日志与 `cardFieldCorrections` 里的先后顺序。
# `title` 2026-09-21 加入，但它有 schema 兜底，见 `NO_INVENT_FIELDS`。
FIELDS = ("card_content", "card_hint", "title")
# 这些字段「脚本没写、plan 有值」**不算臆造**，不清空：
# 脚本没写标题时 `compact_plan` / `shot_plan_schema` 会兜底填「分镜N」，
# 解析器也可能自拟一个，两者都是合法产物，不是模型凭空造上屏内容。
NO_INVENT_FIELDS = frozenset({"title"})
LOG_PREFIX = "[script] 脚本字段校验"  # 2026-09-21 起也管 title，原名「上屏字段校验」
WARN = "[!]"  # 不用 U+26A0：gbk 编不出来，重定向到文件会崩

# 能按纯文本直接读出原文的脚本格式。
TEXT_SUFFIXES = {".md", ".txt", ".csv", ".json", ".srt"}
# 标准库读不了的（旧二进制 Office 与 pdf）——零动作，不猜内容，也不引第三方解析库。
OPAQUE_SUFFIXES = {".pdf", ".doc", ".xls"}

# 分镜标记：行首（允许 markdown 标题号、列表符号）「分镜/镜头/shot」+ 编号。
# `分镜标题：…` 这种字段行不会命中——「分镜」后面必须紧跟编号。
SHOT_MARKER = re.compile(
    r"^[ \t]*(?:#{1,6}[ \t]*)?(?:[-*+•][ \t]*)?"
    r"(?:分镜|镜头|shot)[ \t]*[#＃]?[ \t]*([0-9]{1,3})"
    r"(?:[ \t]*[:：．.、)）\-—]|[ \t]+|[ \t]*$)",
    re.IGNORECASE,
)

# 字段行：`- 上屏文字：xxx` / `上屏文字: xxx` / `**上屏文字**：xxx`。
# 键不含冒号，所以值里再出现冒号（04 第 4 镜「来料确认：…」）不受影响。
FIELD_LINE = re.compile(
    r"^[ \t]*(?:[-*+•][ \t]*|\d{1,2}[.)][ \t]*)?"
    r"(?:\*\*|__)?[ \t]*([^:：\t]{1,32}?)[ \t]*(?:\*\*|__)?[ \t]*[:：][ \t]*(.*)$"
)

# 列表符 / 标题 / 表格 / 引用 / 分隔线 —— 这些开头说明「新起了一行结构」，不是上一行的续写。
STRUCTURAL_PREFIX = re.compile(r"^[ \t]*(?:[-*+•][ \t]|[-*+•]$|\d{1,2}[.)][ \t]|#|\||>|```|~~~|---|___|\*\*\*)")
BULLET_PREFIX = re.compile(r"^[ \t]*(?:[-*+•][ \t]|[-*+•]$|\d{1,2}[.)][ \t])")
FENCE_LINE = re.compile(r"^[ \t]*(?:```|~~~)")

# 键名归一后（去空白/星号/下划线/连字符、转小写）认这些写法。
FIELD_BY_KEY = {
    "上屏文字": "card_content",
    "上屏内容": "card_content",
    "上屏文案": "card_content",
    "上屏正文": "card_content",
    "卡片文字": "card_content",
    "卡片内容": "card_content",
    "卡片文案": "card_content",
    "卡片正文": "card_content",
    # 2026-09-22 真实生产表：这一列的值是观众实际看到的钩子 / 编号卡 / 流程文字，
    # 不是分镜标题，也不是图层制作说明。
    "屏字/大字": "card_content",
    "cardcontent": "card_content",
    "onscreentext": "card_content",
    "onscreencopy": "card_content",
    "卡片样式": "card_hint",
    "卡片版式": "card_hint",
    "卡片要求": "card_hint",
    "卡片提示": "card_hint",
    "卡片说明": "card_hint",
    "卡片风格": "card_hint",
    "上屏样式": "card_hint",
    "上屏版式": "card_hint",
    "图层说明": "card_hint",
    "包装要求": "card_hint",
    "包装说明": "card_hint",
    # 同一真实生产表里「原创图层」写的是编号卡、流程条、描边等制作要求。
    "原创图层": "card_hint",
    "cardhint": "card_hint",
    "cardstyle": "card_hint",
    "cardlayout": "card_hint",
    # `title` 2026-09-21 纳入校验。只认**这几个精确写法**，绝不做子串匹配——
    # 「视频标题 / 全片标题 / 中文副标题 / 视频号标题」都是别的东西，不能当分镜标题。
    "分镜标题": "title",
    "镜头标题": "title",
    "标题": "title",
    "title": "title",
    "shottitle": "title",
}

# 内容锚点：用来确认「脚本第 N 块」和「plan 第 N 镜」说的是同一镜。
# qwen 可以合并/拆分分镜，块数相等不代表镜号对得上（复审 B2），所以纠正前先认人。
ANCHOR_BY_KEY = {
    "口播": "voice_text",
    "口播文案": "voice_text",
    "口播正文": "voice_text",
    "旁白": "voice_text",
    "解说": "voice_text",
    "配音": "voice_text",
    "voicetext": "voice_text",
    "voiceover": "voice_text",
    "voice": "voice_text",
    "narration": "voice_text",
    "中文旁白": "voice_text",
    "英文旁白": "voice_text",
    "字幕": "subtitle",
    "字幕文案": "subtitle",
    "subtitle": "subtitle",
    "分镜标题": "title",
    "镜头标题": "title",
    "标题": "title",
    "title": "title",
    "shottitle": "title",
}

# 表格脚本的**列**角色。除了上面两张表认的那些键，还要认几个「这一行像不像分镜行」
# 用得上的列。**一律精确匹配归一后的列名，不做子串匹配**——子串匹配会把
# 「视频号标题」当成分镜标题、「附属文案」当成口播，那是把对的改坏的最短路径。
TABLE_ROLE_BY_KEY: dict[str, str] = {
    # 分镜号：有这一列就能按号分组（合并单元格 / 一镜多行都靠它）
    "分镜": "shot_no", "分镜号": "shot_no", "分镜序号": "shot_no",
    "镜号": "shot_no", "镜头号": "shot_no", "镜头序号": "shot_no",
    "序号": "shot_no", "编号": "shot_no", "段号": "shot_no", "段落序号": "shot_no",
    "shot": "shot_no", "shotno": "shot_no", "shotnumber": "shot_no",
    "no": "shot_no", "#": "shot_no", "index": "shot_no",
    "拍": "shot_no",
    # 画面 / 素材：不校验，只用来判断「这一行有实质内容」
    "画面": "visual", "画面描述": "visual", "画面内容": "visual", "镜头描述": "visual",
    "素材": "visual", "素材描述": "visual", "素材要求": "visual", "素材搜索": "visual",
    "素材搜索策略": "visual", "素材搜索关键词": "visual", "推荐素材来源": "visual",
    "素材质量标准": "visual", "关键词": "visual", "搜索关键词": "visual",
    "visual": "visual", "visualquery": "visual", "footage": "visual", "shotdescription": "visual",
    # 精确写法；不能靠剥括注后的泛用「画面」去匹配其它用途的参考图列。
    "画面(素材文件,相对资料包根目录)": "visual",
    # 口播的表格写法（真实生产脚本里叫「中文文案 / 英文文案」）
    "中文文案": "voice_text", "英文文案": "voice_text", "文案": "voice_text",
    # 时长 / 时间轴：同样只用于判断实质内容
    "时长": "duration", "时间": "time_range", "时间轴": "time_range",
    "时间码": "time_range", "timecode": "time_range", "duration": "duration",
    "时长s": "duration",
}
# 只有这些角色的格子非空，才算「这一行是一条分镜」。
# 光有时间轴 / 序号的行多半是小计行、说明行。
SUBSTANTIVE_ROLES = frozenset({"voice_text", "subtitle", "title", "card_content",
                               "card_hint", "visual"})
# 表头至少要认出这么多个不同的列角色，才认这一行是表头。
MIN_HEADER_ROLES = 2
# 没有分镜号列时更严一档：那种表只剩「块数 + 内容锚点」两道闸门，入口不能松。
MIN_HEADER_ROLES_NO_SHOT_NO = 3
# 最多试几个表头候选（最像的那行底下未必真有数据行）。
MAX_HEADER_CANDIDATES = 8
# 角色密度的准入线：认出的列 / 这一行有几个非空格。封面块那种 `标题|x|文案|y|素材|z`
# 是 0.5 被挡掉；真表头带一个 `备注` 列是 0.75 照样过。**只否决，不排名**，理由见
# `header_candidates` 的注释。
MIN_HEADER_DENSITY = 0.6

# 作者用来表示「这一镜不写」的占位写法，一律当空处理（与解析器的「凭空造 hint」对冲）。
# **整段完全相等**才算占位：上屏文字写「无人化产线」不会被误杀。
# 2026-09-23 用户拍板：`card_content` 上的纯符号（`-` `—` `——` `／` …）也是占位，
# 不再当「上屏正文恰好是一个符号」——原来那条例外会让作者的「—」直接上屏。
# 第三次复审建议 3 收窄：**只认**「NFKC -> 去首尾空白 -> 去成对括号/引号」之后逐字等于这张表、
# 或纯横线/斜线（`is_placeholder`）。「没有！」「None.」「空 空」「——（不填）」「无。」这类
# 只是**像**占位（`looks_like_placeholder`），可能是作者的正文（「有没有人工？没有！」），
# 不再当没写：该镜该字段只告警，既不清 plan 也不补上屏。
PLACEHOLDER_VALUES = {
    "", "不填", "不填写", "无", "没有", "暂无", "空", "留空", "空白", "不上屏",
    "n/a", "na", "none", "null", "nil", "tbd",
}
# 只由横线 / 斜线组成（半角、全角、en/em dash，任意个数，中间可夹空白 / 换行）：
# `-` `—` `–` `——` `－` `／` `/` `— —` `-\n-`。
PLACEHOLDER_SYMBOLS = re.compile(r"^[-—–－/／\s]+$")
# 「像占位」判定时拆开的分隔：括号（`——（不填）` / `（无）`）与句末标点（`无。`）。
PLACEHOLDER_SPLIT = re.compile(r"[\s()（）【】\[\]「」《》<>“”\"'‘’。．.!！,，;；、]+")
# 原文里出现这些字样、plan 又是空的（「丢失」）时只告警不补：作者多半是在说明「这镜不上屏」，
# 只是写法不在占位名单里（`不上屏（本镜）` / `此镜不填`），补上去就把说明文字渲上屏了。
PLACEHOLDER_HINT_WORDS = ("不上屏", "不填写", "不填", "留空")
# 最终卡片里的提醒（只告警）按「整词」匹配：说明字样后面不能紧跟别的字（第三次复审建议 6），
# 所以「不上屏（本镜）」「此镜不填」会提醒，「不填充」「留空率」「不上屏幕」不会。
# 注意「丢失」闸门仍按子串（宁可漏补，也不把「此镜不填写」这类说明补上屏）。
PLACEHOLDER_HINT_TAIL = re.compile("(?:" + "|".join(PLACEHOLDER_HINT_WORDS) + r")(?!\w)")


def has_placeholder_hint(text: str) -> bool:
    """说明字样用保守子串口径；field_doubt 会先保留整格确定占位语义。"""
    normalized = unicodedata.normalize("NFKC", text)
    return any(word in normalized for word in PLACEHOLDER_HINT_WORDS)

# 上屏列里写在**行首**、给制作看的版式标签（2026-09-23 用户拍板：不该出现在画面上）。
# 只剥白名单、只剥行首（每一行都看），冒号全角半角都认、前后空白都认；正文里的冒号不动。
# 例：`大字：抓起来、放进去？\n副行：决定成败的其实是三件事` -> 两行正文。
# 同一行连写几个标签（`大字：副行：抓取卡`）连续剥；标签外包的 markdown 粗体
# （`**大字：**A` / `大字：**A**`）一并去掉，不把星号渲上屏。
# 要加新标签只改这一个元组，并同步 `prompts/script_parse.md` 第 15 条。
LAYOUT_LABELS = ("大字", "副行", "小字", "参数卡", "决策树")
_LABEL_SPACE = r"[ \t\u3000]*"
_LABEL_MARK = r"(?:(?:\*\*|__)" + _LABEL_SPACE + r")?"
LAYOUT_LABEL_HEAD = re.compile(
    "^" + _LABEL_SPACE + r"(?:(\*\*|__)" + _LABEL_SPACE + ")?"
    + "(" + "|".join(LAYOUT_LABELS) + ")" + _LABEL_SPACE
    + r"(\*\*|__)?" + _LABEL_SPACE + "[:：]" + _LABEL_SPACE
)
# 行首是白名单标签、后面**没写冒号**直接空格接正文（`大字 A句`）：拿不准是标签还是正文，
# 该镜上屏字段只告警、一字不改（第三次复审建议 4）。「大字报」这种不带空白的不算。
LAYOUT_LABEL_NO_COLON = re.compile(
    "^" + _LABEL_SPACE + _LABEL_MARK + "(?:" + "|".join(LAYOUT_LABELS) + ")"
    + _LABEL_MARK + r"[ \t\u3000]+\S"
)

# 2026-09-23 用户拍板：**标签不上屏，但用标签选版式**。结果写进 plan 的 `card_layout`，
# 值只由这里的确定性代码从脚本原文得出，模型不产出（`compact_plan` 不收这个键）：
# - `headline_sub`：`大字：` + `副行：` / `小字：`（第一行也可不写标签）-> 第一行大字、后面小一号；
# - `equal_lines`：`大字：` + `大字：`，或首行是 `参数卡：` / `决策树：` -> 各行一样大（现有版式）；
# - 单行、没写任何标签、标签组合拿不准 -> 不带（渲染层按原规则，输出与以前逐字节相同）。
# 「参数卡」「决策树」暂不单做模板，按各行一样大出（以后再做）。
CARD_LAYOUTS = ("headline_sub", "equal_lines")
HEADLINE_LABELS = frozenset({"大字"})
SUB_LABELS = frozenset({"副行", "小字"})
EQUAL_LINE_LEADS = frozenset({"参数卡", "决策树"})

BRACKET_PAIRS = (("（", "）"), ("(", ")"), ("【", "】"), ("[", "]"),
                 ("《", "》"), ("<", ">"), ("「", "」"), ("“", "”"), ('"', '"'))
# markdown 强调/行内代码：作者写 `**安全第一**`，解析器多半只给 `安全第一`。
# 这种差异不算改写——照搬星号会把星号渲到卡片上。
MARKUP_CHARS = "*_`~"

LAYOUT_NAMES = {"headline_sub": "大字+小字", "equal_lines": "各行一样大"}

KIND_LABELS = {
    "missing": "丢失",
    "invented": "臆造",
    "rewritten": "改写",
}


# ----------------------------------------------------------------------------
# 文本归一
# ----------------------------------------------------------------------------

def collapse(value: object) -> str:
    """与 `normalize_script.normalize_whitespace` 同一套空白折叠，比对前两边都要过一遍。"""
    return re.sub(r"\s+", " ", str(value or "").strip())


def authored_field_value(value: object) -> str:
    r"""表格作者字段：保留读取层给出的全部内部字符，只去首尾空白、把 CRLF / CR 统一成 LF。

    Excel 单元格内换行常以 `_x000D_\n`（解码后 `\r\n`）存；`\r` 不是作者要的字，
    渲染层也只认 `\n`。
    """
    return re.sub(r"\r\n?", "\n", str(value or "")).strip()


def _strip_edge_marks(line: str) -> str:
    """去掉**包住整行**的一对 `**` / `__`，以及一个落单的边缘标记。中间的粗体不拆。

    第三次复审建议 5：原来两端各自剥，`**抓取**卡与**放置**` 会被剥成 `抓取**卡与**放置`。
    现在只剥两种：
    - 成对包住整行、且里面不再有同一标记：`**安全第一**` -> `安全第一`；
    - 整行里这个标记是**奇数个**、落单的那个在边上：`- **上屏文字：** 安全第一` 的值是
      `** 安全第一`（冒号写在粗体里，剩下半个 `**` 跟着值走）-> `安全第一`。
    """
    changed = True
    while changed:
        changed = False
        for marker in ("**", "__"):
            size = len(marker)
            if (len(line) > 2 * size and line.startswith(marker) and line.endswith(marker)
                    and marker not in line[size:-size]):
                line = line[size:-size].strip()
                changed = True
            elif line.count(marker) % 2 == 1:
                if line.startswith(marker):
                    line = line[size:].lstrip()
                    changed = True
                elif line.endswith(marker):
                    line = line[:-size].rstrip()
                    changed = True
    return line


def split_layout_label(line: str) -> tuple[str | None, str]:
    """一行 -> (行首第一个白名单标签或 None, 剥掉全部行首标签后的正文)。"""
    first: str | None = None
    rest = line
    while True:
        matched = LAYOUT_LABEL_HEAD.match(rest)
        if not matched:
            break
        first = first or matched.group(2)
        rest = rest[matched.end():]
        opened, closed = matched.group(1), matched.group(3)
        if opened and not closed:
            # `**大字：**A`：粗体包的是标签（收尾的 `**` 在冒号后面），跟着标签一起去掉；
            # `**大字：A**`：粗体包的是整行，去掉行尾那一个。其余情况不动。
            if rest.startswith(opened):
                rest = rest[len(opened):].lstrip()
            elif rest.rstrip().endswith(opened) and opened not in rest.rstrip()[:-len(opened)]:
                rest = rest.rstrip()[:-len(opened)]
    if first is None:
        return None, line
    return first, _strip_edge_marks(rest.strip())


def strip_layout_labels(value: str) -> str:
    """剥掉每一行行首的白名单版式标签（`大字：` / `副行：` …），见 `LAYOUT_LABELS`。"""
    return "\n".join(split_layout_label(line)[1] for line in value.split("\n")).strip()


def layout_from_labels(raw: object) -> str | None:
    """脚本原文（未剥标签）-> `card_layout`，见 `CARD_LAYOUTS`。拿不准一律 None。"""
    labelled = []
    for line in authored_field_value(raw).split("\n"):
        label, text = split_layout_label(line)
        if text.strip():
            labelled.append(label)
    if len(labelled) < 2 or not any(labelled):
        return None
    head, rest = labelled[0], labelled[1:]
    if head in (HEADLINE_LABELS | {None}) and all(label in SUB_LABELS for label in rest):
        return "headline_sub"
    if all(label in HEADLINE_LABELS for label in labelled) or head in EQUAL_LINE_LEADS:
        return "equal_lines"
    return None


def strip_authored_markup(value: object) -> str:
    """不折叠内部空白地沿用既有整值 markdown / 成对括号比较规则。"""
    text = authored_field_value(value)
    previous = None
    while previous != text:
        previous = text
        text = strip_brackets(text).strip(MARKUP_CHARS).strip()
    return text


def normalize_key(key: str) -> str:
    return re.sub(r"[\s*_\-–—·]", "", key).lower()


# 列名后缀里的括注：`中文文案（直接复用）` / `素材搜索(中文)` / `上屏文字（没有就留空）`。
# 真实生产表格里同一列在不同版本的脚本模板上括注写法都不一样（全角 / 半角 / 有 / 无），
# 所以**表格列名**比对前把括注整段去掉。纯文本路的 `键：值` 不走这一步（不改既有行为）。
COLUMN_NOTE = re.compile(r"[（(【\[][^（）()【】\[\]]*[）)】\]]")

# **剥括注之后不许落到这批键上。**（2026-09-21 对抗复审阻断 1）
# 这些键太泛，而「唯一能区分它和别的东西的那个限定语，恰好就写在括号里」：
#   `标题（16字无标点）` -> `标题`  这是平台标题，不是分镜标题
#   `文案（上屏）`       -> `文案`  这是上屏文案，不是口播
#   `Title (video)`     -> `title` 这是全片标题
# 认错了就会「把对的改坏」：实测能让全片分镜标题被换成平台标题、
# 或者让正确的 card_content 被整片清空。所以泛用键**只认逐字相同的原列名**。
# `中文文案（直接复用）` / `素材搜索策略（中文）` / `上屏文字（没有就留空）` 这些真实变体
# 剥完落在**非**泛用键上，一个都不受影响。
GENERIC_KEYS = frozenset({
    "标题", "文案", "素材", "画面", "时间", "分镜", "镜头",
    "title", "voice", "subtitle", "shot", "no", "index", "duration", "visual", "footage",
})
# 注：`序号` / `编号` 2026-09-21 从这份表里拿掉了——`序号（镜）` 这种写法很常见，
# 而分镜号只影响分组、后面还有「必须严格 1..N」那道硬闸门兜，误认的代价远小于漏认。

# **括注与角色冲突时，整列认不出来。**（第二次对抗复审应修 1）
# `GENERIC_KEYS` 只挡得住「主键本身很泛」的那一类，挡不住「主键不泛、但括注把语义改掉了」：
#   `中文文案（上屏）` -> `中文文案` -> voice_text（锚点角色，值连 `foreign_values` 都不进）
#   -> 作者真写了的上屏文字被当成「解析器臆造」清空。
# 扩 `GENERIC_KEYS` 治不了它——把 `中文文案` 加进去，真实脚本的 `中文文案（直接复用）` 当场废掉。
# 所以按**角色**列冲突词：括注里出现这些字眼，说明这一列讲的不是这个角色的事，认不出来（漏报）。
# `title` 只挡「全片 / 整片」两个不可能描述逐镜标题的限定词：
# `分镜标题（全片通用）` 配纵向合并单元格时会把整片 title 覆盖成同一个值；
# `分镜标题（视频用）` / `分镜标题（中文）` 仍然是有效的逐镜标题列。
# `voice_text` 里的「标题」同理：收益低，却会误伤 `口播（配合标题卡）`。
NOTE_CONFLICTS = {
    "voice_text": ("上屏", "卡片", "字卡", "花字"),
    "subtitle": ("上屏", "卡片", "字卡", "花字"),
    "title": ("全片", "整片"),
}


def normalize_column_key(key: str) -> str:
    stripped = COLUMN_NOTE.sub("", str(key or ""))
    return normalize_key(stripped or str(key or ""))


def strip_brackets(value: str) -> str:
    text = value.strip()
    changed = True
    while changed and len(text) >= 2:
        changed = False
        for left, right in BRACKET_PAIRS:
            if text.startswith(left) and text.endswith(right):
                text = text[len(left):len(text) - len(right)].strip()
                changed = True
                break
    return text


def strip_markup(value: str) -> str:
    """去掉 markdown 强调 / 行内代码 / 成对引号括号，只用于**比对**，不用于写回。"""
    text = collapse(value)
    previous = None
    while previous != text:
        previous = text
        text = strip_brackets(text).strip(MARKUP_CHARS).strip()
    return text


def _placeholder_key(value: object) -> str:
    # NFKC：全角 `Ｎ／Ａ` -> `N/A`、全角空格 -> 空格。只用于判定，不改写回的值。
    return strip_brackets(collapse(unicodedata.normalize("NFKC", str(value or "")))).lower()


def is_placeholder(value: str, field: str = "card_hint") -> bool:
    """作者写的是**确定的**占位 -> 当成没写（清 plan / 不补都按「没写」走）。

    只认两种（第三次复审建议 3 收窄）：NFKC、去首尾空白、去成对括号 / 引号之后
    逐字等于 `PLACEHOLDER_VALUES`（`（不填）` `「无」` `N/A` `空白` `不上屏` …），
    或只由横线 / 斜线组成（`-` `——` `／` `— —` `-\\n-`）。
    `field` 参数保留只为兼容调用方；2026-09-23 起所有字段同一口径。
    """
    text = _placeholder_key(value)
    return text in PLACEHOLDER_VALUES or bool(PLACEHOLDER_SYMBOLS.match(text))


def looks_like_placeholder(value: str) -> bool:
    """**像**占位（旧的宽口径）：拆开括号和句末标点后每一段都是占位词或纯符号。

    `——（不填）` `无。` `没有！` `None.` `空 空` 都是；`不上屏（本镜）`（「本镜」不是占位）、
    `无人化` `—3%` `/分钟` `不填充` `留空率` 都不是。命中但 `is_placeholder` 不认的，
    调用方一律只告警不改（可能是作者正文，也可能是占位——拿不准）。
    """
    text = _placeholder_key(value)
    if text in PLACEHOLDER_VALUES or PLACEHOLDER_SYMBOLS.match(text):
        return True
    pieces = [piece for piece in PLACEHOLDER_SPLIT.split(text) if piece]
    return bool(pieces) and all(piece in PLACEHOLDER_VALUES or PLACEHOLDER_SYMBOLS.match(piece)
                                for piece in pieces)


def field_doubt(raw: str, field: str, *, preserve_layout: bool = False) -> str:
    """脚本原文这一格「读得到、但拿不准该不该照它改」的原因；空串 = 没有疑点。

    有疑点时该镜该字段只告警、一字不改，也不带 `card_layout`（第三次复审阻断 B1 与建议 3/4/5）：
    - 整格像占位但不是确定占位（`没有！` `——（不填）`）；
    - `card_content` 里**某一行**是占位 / 像占位，而整格不是（`大字：抓取卡↵副行：（不填）`）——
      那一行多半是「这一行不写」，但剥掉它、留着它都可能不对；
    - 行首是白名单版式标签却没写冒号（`大字 A句`）；
    - 剥完标签后正文中间还有 markdown 粗体 `**`（渲上屏会显示星号，去掉又不是原文）。
    """
    text = authored_field_value(raw) if preserve_layout else collapse(raw)
    text = _strip_edge_marks(text)
    if field != "card_content":
        if not text or is_placeholder(text):
            return ""
        if has_placeholder_hint(text):
            return "脚本原文里有像是「不上屏 / 不填 / 不填写 / 留空」的说明文字"
        if text and not is_placeholder(text) and looks_like_placeholder(text):
            return f"脚本原文「{clip(collapse(text), 20)}」像占位但不在确定的占位写法里，拿不准是不是正文"
        if "**" in text:
            return "脚本原文正文里有 markdown 粗体标记 `**`，拿不准星号要不要上屏"
        return ""
    bodies = []
    for line in text.split("\n"):
        _label, body = split_layout_label(line)
        if LAYOUT_LABEL_NO_COLON.match(body):
            return f"脚本原文这一行「{clip(body.strip(), 20)}」行首像版式标签但没写冒号，拿不准是标签还是正文"
        bodies.append(body)
    whole = "\n".join(bodies).strip()
    if not whole or is_placeholder(whole):
        return ""
    if looks_like_placeholder(whole):
        return f"脚本原文「{clip(collapse(whole), 20)}」像占位但不在确定的占位写法里，拿不准是不是正文"
    for body in bodies:
        if body.strip() and looks_like_placeholder(body):
            return (f"脚本原文里有一行是占位「{clip(body.strip(), 20)}」而整格不是，"
                    "拿不准这一行该不该上屏")
    if has_placeholder_hint(whole):
        return "脚本原文里有像是「不上屏 / 不填 / 不填写 / 留空」的说明文字"
    if "**" in whole:
        return "脚本原文正文里有 markdown 粗体标记 `**`，拿不准星号要不要上屏"
    return ""


def script_value(raw: str, field: str, *, preserve_layout: bool = False) -> str:
    """脚本原文该字段的最终取值：占位折成空串；去掉包裹整值的 markdown 强调标记。

    去强调标记是因为 `- **上屏文字：** 安全第一` 这种写法会把 `**` 留在值的开头
    （冒号写在粗体里面），照搬会把星号渲到卡片上。只剥**整值两端**的，值中间的不动。
    """
    # 表格作者字段的人工换行和横向空白都是原文；纯文本路保持既有折叠口径。
    text = authored_field_value(raw) if preserve_layout else collapse(raw)
    text = _strip_edge_marks(text)
    if field == "card_content":
        # 版式标签是写给制作的，不上屏；剥完整格为空就按「没写」处理。
        text = strip_layout_labels(text)
    return "" if is_placeholder(text, field) else text


def same_text(left: str, right: str) -> bool:
    """比对用：空白折叠后相等，或只差 markdown 强调 / 成对引号括号，都算一致。"""
    if left == right:
        return True
    return bool(left) and bool(right) and strip_markup(left) == strip_markup(right)


def anchor_matches(script_text: str, plan_text: str) -> bool:
    """锚点比对：qwen 会缩写字幕、微调标题，所以短文本要求相等，长文本允许互相包含。"""
    left, right = strip_markup(script_text), strip_markup(plan_text)
    if not left or not right:
        return False
    if left == right:
        return True
    compact_left = re.sub(r"\s+", "", left).lower()
    compact_right = re.sub(r"\s+", "", right).lower()
    if min(len(compact_left), len(compact_right)) < 6:
        return compact_left == compact_right
    return compact_left in compact_right or compact_right in compact_left


# ----------------------------------------------------------------------------
# 原文抽取
# ----------------------------------------------------------------------------

def read_script_text(path: Path) -> str | None:
    """纯文本脚本的原文；非文本格式或读不出来一律 None（= 本层放弃，零动作）。"""
    if path.suffix.lower() not in TEXT_SUFFIXES:
        return None
    try:
        raw = path.read_bytes()
    except OSError:
        return None
    for encoding in ("utf-8-sig", "gb18030"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return None


def outside_fences(lines: list[str]) -> list[bool]:
    """逐行标出「不在代码围栏里」。围栏里多半是写法示例，整段不参与抽取。"""
    result: list[bool] = []
    inside = False
    for line in lines:
        if FENCE_LINE.match(line):
            inside = not inside
            result.append(False)      # 围栏行本身也不参与
            continue
        result.append(not inside)
    return result


def line_indent(line: str) -> int:
    return len(line) - len(line.lstrip(" \t"))


def starts_new_structure(current: str, following: str) -> bool:
    """`following` 是不是一条新的结构行（而不是 `current` 的续写）。

    分四步，专治「值里本来就有冒号」这种脚本（`上屏文字：来料确认：…｜抓取确认：…`）：
    空行和列表/标题/表格/引用/分隔线开头一定是新结构；当前行是列表项而下一行没有列表符，
    按 markdown 的 lazy continuation 算续写；其余情况要求下一行像字段行且缩进不更深。
    """
    if not following.strip():
        return True
    if STRUCTURAL_PREFIX.match(following):
        return True
    if BULLET_PREFIX.match(current):
        return False
    if FIELD_LINE.match(following) and line_indent(following) <= line_indent(current):
        return True
    return False


def parse_block(block_lines: list[str], usable: list[bool]) -> dict[str, Any]:
    """一镜之内的字段。`reliable=False` 表示对不可靠，调用方只告警不改。

    除了两个上屏字段，还要收两样东西：
    - `anchors`：口播 / 字幕 / 分镜标题，用来确认镜号对得上；
    - `foreign_values`：**本块里那些「本表不认识的键」写的值**。判「臆造 / 改写」
      要清掉或换掉 plan 里的值之前，先看它是不是出现在这里——在的话说明作者其实写了、
      只是用了本表不认识的字段名，解析器抽对了。**认得出来的键不算数**：
      「字幕」的值被解析器抄进 `title` 正是要纠正的情况，不是要放过的情况。
    """
    found: dict[str, list[str]] = {field: [] for field in FIELDS}
    anchors: dict[str, list[str]] = {}
    foreign_values: set[str] = set()
    unreliable: set[str] = set()
    for index, line in enumerate(block_lines):
        if not usable[index]:
            continue
        matched = FIELD_LINE.match(line)
        if not matched:
            continue
        raw_value = matched.group(2).strip()
        key = normalize_key(matched.group(1))
        anchor = ANCHOR_BY_KEY.get(key)
        if anchor:
            anchors.setdefault(anchor, []).append(raw_value)
        field = FIELD_BY_KEY.get(key)
        if not field:
            if raw_value and anchor is None:
                foreign_values.add(strip_markup(raw_value))
            continue
        found[field].append(raw_value)
        # 紧接着的下一行；在围栏里的按空行算（围栏内容不参与抽取）。
        following = ""
        if index + 1 < len(block_lines) and usable[index + 1]:
            following = block_lines[index + 1]
        if not starts_new_structure(line, following):
            unreliable.add(field)
    result: dict[str, Any] = {"anchors": anchors, "foreign_values": foreign_values}
    for field in FIELDS:
        values = found[field]
        if len(values) > 1:
            # 同一镜写了多行同名字段（中英双语脚本常见），抽不出唯一对应关系。
            unreliable.add(field)
        result[field] = {
            "present": bool(values),
            "raw": values[0] if values else "",
            "value": script_value(values[0], field) if values else "",
            "reliable": field not in unreliable,
        }
        doubt = field_doubt(values[0], field) if values else ""
        if doubt:
            result[field].update(reliable=False, doubt=doubt, notice=doubt)
    return result


def extract_shot_card_fields(text: str) -> list[dict[str, Any]] | None:
    """按分镜切块并抽字段；结构对不上（找不到标记 / 编号不是 1..N）返回 None。"""
    lines = text.splitlines()
    usable = outside_fences(lines)
    marks: list[tuple[int, int]] = []
    for index, line in enumerate(lines):
        if not usable[index]:
            continue
        matched = SHOT_MARKER.match(line)
        if matched:
            marks.append((index, int(matched.group(1))))
    if len(marks) < 2:
        return None
    if [number for _, number in marks] != list(range(1, len(marks) + 1)):
        # 编号重复、跳号或乱序：多半是正文里「分镜 3」被误当成了标记，不能按它切块。
        return None
    blocks = []
    for position, (start, _number) in enumerate(marks):
        end = marks[position + 1][0] if position + 1 < len(marks) else len(lines)
        blocks.append(parse_block(lines[start + 1:end], usable[start + 1:end]))
    return blocks


# ----------------------------------------------------------------------------
# 表格脚本（xlsx / xlsm / csv）
# ----------------------------------------------------------------------------

ANCHOR_ROLES = frozenset(ANCHOR_BY_KEY.values())
# 「确定」判据里要求**白名单原名逐字命中**的关键列：分镜号、内容锚点、三个待校验字段。
KEY_ROLES = frozenset({"shot_no"}) | ANCHOR_ROLES | frozenset(FIELDS)
# 待校验字段落在这些格子上时，该镜该字段只告警。
CELL_KIND_DOUBTS = {
    "number": "脚本里这一格是数值（读到的是原始值，和 Excel 里看到的样子可能不同，如 95% -> 0.95）",
    "formula": "脚本里这一格是公式（读不到可靠的显示文字）",
    "boolean": "脚本里这一格是逻辑值，不是作者敲的文字",
    "error": "脚本里这一格是公式错误值",
    "truncated": "脚本里这一格超过 2 万字被截断，读到的不是全文",
}
# 这么长的格子不可能是列名，扫「别处还有没有表头」时直接跳过（省时间，也少误认）。
MAX_COLUMN_NAME_CHARS = 40
# 分镜号格子：`1` / `第1镜` / `#1` / `分镜 1` / `1.` / Excel 存成浮点的 `1.0`。
SHOT_NUMBER = re.compile(
    r"^(?:第|[#＃]|no\.?|shot|镜头|分镜)?[ \t]*([0-9]{1,3})[ \t]*(?:镜|号|段|[.、．])?$",
    re.IGNORECASE,
)


def _role_of_key(key: str) -> str | None:
    if not key:
        return None
    return FIELD_BY_KEY.get(key) or ANCHOR_BY_KEY.get(key) or TABLE_ROLE_BY_KEY.get(key)


def column_role(name: str) -> str | None:
    """一个表头格子对应哪个角色。认不出来返回 None（该列的值会进 `foreign_values`）。

    两遍查表：**先拿不剥括注的原列名查**，命中就用；没命中才剥括注再查一遍，
    而且第二遍**不许落到 `GENERIC_KEYS` 上**——见那份表上面的注释。
    """
    plain = normalize_key(str(name or ""))
    role = _role_of_key(plain)
    if role is not None:
        return role
    stripped = normalize_column_key(name)
    if stripped == plain or stripped in GENERIC_KEYS:
        return None
    role = _role_of_key(stripped)
    notes = "".join(COLUMN_NOTE.findall(str(name or "")))
    if role is not None and any(hint in notes for hint in NOTE_CONFLICTS.get(role, ())):
        return None                       # 括注说的是别的事，这一列不认（宁可漏报）
    return role


def parse_shot_number(value: str) -> int | None:
    text = collapse(value)
    text = re.sub(r"^([0-9]{1,3})\.0+$", r"\1", text)      # Excel 的 `1.0`
    matched = SHOT_NUMBER.match(text)
    return int(matched.group(1)) if matched else None


def header_candidates(rows: list[list[str]]) -> list[tuple[int, dict[int, str]]]:
    """所有像表头的行：**密度过闸的**按「①行号升序 ②同一行角色数降序」排。

    **不假定在第 1 行、也不假定从 A 列开始**——真实生产脚本的表头常在第 18–21 行
    （上面是纵向的封面文案块），起始列可能是 A 也可能是 B。

    **角色密度（认出的列 / 这一行有几个非空格）只当准入闸门，不当排名依据。**
    这条口径是三轮对抗复审打出来的，两次走错路都记在这：

    - 「同分**靠后**优先」：正表下面再跟一张 `标题 | 文案 | 素材` 的小表时，它会把表头抢走，
      而它的「文案」列逐字重复口播 → 锚点直接判 ok → **全片标题被下面那张表覆盖**；
    - 「密度当**排序键**」：真表头只要多一个不认识的列（`备注` / `填写人` / `本表说明`——
      中文分镜表极常见）密度就掉到 0.75，下面那张干净的小表 1.0 直接反超，**同一条路径原样复现**。

    结论：**位置分数是可被构造的，而「靠前」是结构事实**——表头永远在它自己的数据区之上。
    所以密度只用来**否决**封面块那一类形状（`标题 | x | 文案 | y | 素材 | z` = 3/6 = 0.5，
    一半格子是值不是列名），真表头带个备注列是 3/4 = 0.75 照样过闸；排名一律靠前优先。
    代价是密度 < 0.6 的超稀疏表头退成零动作（**漏报**，可接受）。

    **没有分镜号列时门槛抬到 3 个角色**：那种表全靠「块数 + 内容锚点」两道闸门兜底，
    入口就得更严。真实生产脚本（时间轴 / 中文文案 / 素材搜索）正好是 3 个。

    返回的是**候选列表**而不是单个答案：最像表头的那一行底下未必真有数据行
    （比如表格末尾又抄了一遍表头、或者下面另附了一张填写说明表），
    调用方按顺序试，第一个能切出分镜的才算数。
    """
    scored: list[tuple[int, int, dict[int, str]]] = []
    for index, row in enumerate(rows):
        roles: dict[int, str] = {}
        for column, cell in enumerate(row):
            role = column_role(cell)
            if role is not None:
                roles[column] = role
        distinct = set(roles.values())
        if not (distinct & SUBSTANTIVE_ROLES):
            continue
        floor = MIN_HEADER_ROLES if "shot_no" in distinct else MIN_HEADER_ROLES_NO_SHOT_NO
        if len(distinct) < floor:
            continue
        filled = sum(1 for cell in row if collapse(cell))
        density = len(roles) / filled if filled else 0.0
        if density < MIN_HEADER_DENSITY:
            continue                      # 封面块那一类：一半格子是值不是列名
        scored.append((len(distinct), index, roles))
    scored.sort(key=lambda item: (item[1], -item[0]))
    return [(index, roles) for _score, index, roles in scored[:MAX_HEADER_CANDIDATES]]


def detect_header(rows: list[list[str]]) -> tuple[int, dict[int, str]] | None:
    """最像表头的那一行。`None` = 一行都不像。"""
    candidates = header_candidates(rows)
    return candidates[0] if candidates else None


def _cell(row: list[str], column: int) -> str:
    return collapse(row[column]) if 0 <= column < len(row) else ""


def group_table_rows(rows: list[list[str]], header_index: int,
                     roles: dict[int, str]
                     ) -> tuple[list[list[list[str]]], set[int], list[list[int]]] | None:
    """表头以下的行分组，一组 = 一镜。分镜号列不是严格 1..N 就整份放弃（零动作）。

    有分镜号列时：同号（合并单元格摊开后会同号）或号为空的行并进上一组——
    「一镜多行」就是这样写的。号写成 `1-2` 这种**看不懂**的，并进上一组之外还要
    **把那一组整个标成存疑**（第二个返回值）：只靠「值变得不唯一」是不够的，
    那一行在被校验的列上可能恰好是空的，值仍然唯一（对抗复审建议 2）。
    没有分镜号列时：每个有实质内容的行算一镜，全靠块数与锚点两道闸门兜。

    返回 `(分组, 存疑的组下标集合, 每组的行号列表, 第一镜之前的内容行)`（行号 0 起）。
    第四项（第三次复审阻断 B2）：第一个有号的镜之前出现的、有实质内容或写了镜号（`片头` / `1a`）
    的行。原来这些行被静默跳过；模型却可能把片头并进第 1 镜给卡，确定档再把那张卡当「臆造」删掉。
    调用方见到非空就整份只告警（`table_certainty_problems`）。
    """
    header_row = rows[header_index]
    header_texts = {collapse(header_row[column]) for column in roles
                    if column < len(header_row)}
    shot_column = next((column for column, role in sorted(roles.items())
                        if role == "shot_no"), None)

    groups: list[list[list[str]]] = []
    indices: list[list[int]] = []
    numbers: list[int] = []
    doubtful: set[int] = set()
    # 第二次对抗复审阻断 B1/B2：上一镜之后隔着**整行空白**或**重复表头**又冒出来的
    # 同号行 / 无号行，多半是另一张表（示例块、表尾说明），不是这一镜的续写。
    # 并进上一组照旧（保持块数），但把那一组标成存疑 -> 该镜只告警、一个字不改。
    # 遇到下一个有号的新镜就清掉这两个状态。
    gap = False
    repeated_header = False
    preamble: list[int] = []
    for offset, row in enumerate(rows[header_index + 1:], header_index + 1):
        if not any(collapse(cell) for cell in row):
            gap = bool(groups)
            continue
        recognised = {_cell(row, column) for column in roles} - {""}
        if recognised and recognised <= header_texts:
            repeated_header = bool(groups)
            continue                                  # 合并表头摊开后重复的那一行
        substantive = any(_cell(row, column) for column, role in roles.items()
                          if role in SUBSTANTIVE_ROLES)
        if shot_column is None:
            if substantive:
                groups.append([row])
                indices.append([offset])
            continue
        raw = _cell(row, shot_column)
        number = parse_shot_number(raw)
        if number is not None:
            if numbers and number == numbers[-1]:
                groups[-1].append(row)
                indices[-1].append(offset)
                if gap or repeated_header:
                    doubtful.add(len(groups) - 1)   # 隔着空行 / 重复表头同号续写：多半是另一张表
            else:
                groups.append([row])
                indices.append([offset])
                numbers.append(number)
            gap = repeated_header = False
            continue
        if not groups and (substantive or raw):
            preamble.append(offset)
            continue
        if groups and (substantive or raw):
            groups[-1].append(row)
            indices[-1].append(offset)
            if raw or gap or repeated_header:
                # 号写了但认不出来（`1-2` / `小计` / `示例`），或隔着空行 / 重复表头的无号行
                # （表尾说明落在上屏列）：这一组到底是几镜、这行属不属于这一镜，都说不准
                doubtful.add(len(groups) - 1)
    if not groups:
        return None
    if numbers and numbers != list(range(1, len(numbers) + 1)):
        return None
    return groups, doubtful, indices, preamble


def block_from_rows(group: list[list[str]], roles: dict[int, str],
                    ambiguous: frozenset[str], doubtful: bool = False) -> dict[str, Any]:
    """一组行（= 一镜）里的字段，形状与 `parse_block` 完全一致。

    `foreign_values` 的口径与纯文本路对齐：**除了分镜号列，凡是不参与校验、
    也不当锚点的列（画面 / 素材 / 时长 / 时间轴，以及表头认不出来的列），
    值都算数**。纯文本路里 `画面：xxx` / `时长：7 秒` 的键同样认不出来、同样算数——
    两条路的闸门强度必须一致，否则同一份脚本的 txt 版和 xlsx 版结论会不同
    （对抗复审建议 4）。
    """
    found: dict[str, list[str]] = {field: [] for field in FIELDS}
    seen: dict[str, set[str]] = {field: set() for field in FIELDS}
    anchors: dict[str, list[str]] = {}
    foreign_values: set[str] = set()
    doubts: dict[str, str] = {}
    for row in group:
        for column, cell in enumerate(row):
            role = roles.get(column)
            kind = script_tabular.cell_kind(cell)
            if role in FIELDS and kind and role not in doubts:
                # 数值 / 公式 / 布尔 / 错误格：读到的是原始值或空的公式，不是作者在 Excel 里
                # 看到的那串字（`95%` -> `0.95`；公式没缓存就是空）。拿它当原文会改错。
                doubts[role] = CELL_KIND_DOUBTS.get(kind, CELL_KIND_DOUBTS["number"])
            collapsed = collapse(cell)
            if not collapsed:
                continue
            # 分组、锚点、外来值继续使用折叠后的文本；只有本次有真实证据的
            # card_content 保留内部字符，title/card_hint 维持既有行为。
            raw = authored_field_value(cell) if role == "card_content" else collapsed
            if role is None or (role not in FIELDS and role not in ANCHOR_ROLES
                                and role != "shot_no"):
                # 表头认不出来的列，以及画面 / 素材 / 时长这种不参与校验的列：
                # 作者完全可能就是在那儿写的上屏文字 / 标题
                foreign_values.add(strip_markup(raw))
                if role is None:
                    continue
            if role in ANCHOR_ROLES:
                anchors.setdefault(role, []).append(collapsed)
            if role in FIELDS:
                # card_content 的换行/横向空白有意义；两种排版不能去重成“唯一”值。
                marker = (script_value(raw, field=role, preserve_layout=True)
                          if role == "card_content" else strip_markup(raw))
                if marker not in seen[role]:
                    seen[role].add(marker)
                    found[role].append(raw)
    result: dict[str, Any] = {"anchors": anchors, "foreign_values": foreign_values}
    for field in FIELDS:
        values = found[field]
        result[field] = {
            "present": bool(values),
            "raw": values[0] if values else "",
            "value": script_value(values[0], field, preserve_layout=(field == "card_content"))
            if values else "",
            # 一镜多行给了两个不同的值 / 中英双语表同一角色占了两列 -> 对不唯一
            "reliable": (len(values) <= 1 and field not in ambiguous and not doubtful
                         and field not in doubts),
        }
        if field == "card_content" and values:
            result[field]["layout"] = layout_from_labels(values[0])
        if field in doubts:
            result[field]["doubt"] = doubts[field]
        doubt = (field_doubt(values[0], field, preserve_layout=(field == "card_content"))
                 if values else "")
        if doubt:
            # 第三次复审阻断 B1：逐行占位 / 像占位 / 无冒号标签 / 残留粗体 -> 只告警、不带版式
            result[field].update(reliable=False, notice=doubt)
            result[field].setdefault("doubt", doubt)
            if field == "card_content":
                result[field]["layout"] = None
    return result


def extract_table_card_fields(rows: list[list[str]]) -> dict[str, Any] | None:
    """表格 -> `{"blocks": [...], "roles": [...]}`；认不出表头或分镜行返回 None。

    位置最早的合法候选优先；如果它无法安全切出分镜，整表放弃，不回退到下方另一张表。
    这是有意的安全漏报：下方表可能是平台文案或填写说明，接管后会误改逐镜字段。
    """
    limit = len(rows) + 1
    for header_index, roles in header_candidates(rows):
        if header_index >= limit:
            continue
        grouped = group_table_rows(rows, header_index, roles)
        if grouped is None:
            limit = min(limit, header_index)
            continue
        groups, doubtful, row_groups, preamble = grouped
        counts: dict[str, int] = {}
        for role in roles.values():
            counts[role] = counts.get(role, 0) + 1
        ambiguous = frozenset(field for field in FIELDS if counts.get(field, 0) > 1)
        return {
            "blocks": [block_from_rows(group, roles, ambiguous, index in doubtful)
                       for index, group in enumerate(groups)],
            "roles": sorted(set(roles.values())),
            "ambiguous": sorted(ambiguous),
            "header_row": header_index + 1,
            # 下面三项只给「确定」判定用（`table_certainty_problems`）
            "header_index": header_index,
            "columns": dict(roles),
            "row_groups": row_groups,
            "preamble_rows": preamble,
        }
    return None


def is_field_header_row(row: list[str]) -> bool:
    """这一行像不像「带待校验字段的表头」：≥2 个格子能认成列名，且至少一个是
    上屏文字 / 卡片样式 / 分镜标题。**不看密度、不看底下有没有数据**——
    故意比选表头的闸门松：它只用来发现「别处还有一张可能被解析器读到的表」。
    """
    hits = 0
    has_field = False
    for cell in row:
        text = collapse(cell)
        if not text or len(text) > MAX_COLUMN_NAME_CHARS:
            continue
        role = column_role(text)
        if role is None:
            continue
        hits += 1
        has_field = has_field or role in FIELDS
    return hits >= 2 and has_field


def _row_signature(row: list[str]) -> list[str]:
    cells = [collapse(cell) for cell in row]
    while cells and not cells[-1]:
        cells.pop()
    return cells


def table_certainty_problems(sheets: list[tuple],
                             chosen: int, parsed: dict[str, Any]) -> list[str]:
    """表格路的「确定」判据（2026-09-23 用户拍板：只有百分之百认准表头才自动改 plan）。

    返回不满足的原因列表；**空列表 = 确定档**，否则整份只告警、一个字不改。
    `sheets` 是工作簿全部 sheet（csv 就是一张）：`(名字, 网格, 合并区域[, 隐藏的列/行])`；
    `chosen` 是选中表所在 sheet 的下标。判据共四条（镜数一致在 `reconcile` 里判）：

    1. 选中表头里的关键列（分镜号 / 口播·字幕·分镜标题 / 上屏文字 / 卡片样式）都是白名单原名
       逐字命中（`normalize_key` 只去空白和 `*_-–—·`、转小写），靠剥括注才认出来的不算；
    2. 选中表至少有一个待校验字段列（上屏文字 / 卡片样式 / 分镜标题）；
    3. 整个工作簿里除了这一行表头本身，没有任何别的「带待校验字段的表头行」
       （`is_field_header_row`：图例、填写示例、上下方另一张小表都算）。
       **同一 sheet 里逐字重复的表头也算**（第二次对抗复审阻断 B1：上方示例块与正表表头逐字
       相同、示例行号写 1 -> 示例卡片进了第 1 镜还判确定）。原来对逐字重复表头的豁免取消；
       真实生产表（v1 / v2A / v2B / v2C / v2 系列 / EN 系列）一份都没有重复表头，不受影响；
    4. 关键列在表头行及以下没有被横向合并单元格覆盖；待校验字段列的纵向合并不跨镜；
    5. 选中表所在 sheet 没有隐藏的列 / 行（隐藏的旧上屏列、示例行，解析器读不读说不准）；
    6. 表头与第一个有号的镜之间没有带内容 / 带镜号的行（片头行 `片头` / `1a` / 镜号空，第三次复审阻断 B2）。
       模型可能把它并进第 1 镜，也可能单算一镜，镜号对应说不准——保守起见整份只告警。
    """
    name, grid, merges = sheets[chosen][:3]
    hidden = sheets[chosen][3] if len(sheets[chosen]) > 3 else ()
    header_index: int = parsed["header_index"]
    columns: dict[int, str] = parsed["columns"]
    header = grid[header_index]
    problems: list[str] = []

    for column, role in sorted(columns.items()):
        if role in KEY_ROLES and _role_of_key(normalize_key(header[column])) != role:
            problems.append(f"表头「{collapse(header[column])}」是去掉括注后才认出来的，不是白名单里的原名")

    if not set(columns.values()) & set(FIELDS):
        problems.append("认出的分镜表里没有上屏文字 / 卡片样式 / 分镜标题列，没有可按原文校验的字段")

    others: list[str] = []
    for index, sheet in enumerate(sheets):
        other_name, other_grid = sheet[0], sheet[1]
        for row_index, row in enumerate(other_grid):
            if index == chosen and row_index == header_index:
                continue
            if is_field_header_row(row):
                others.append(f"「{other_name}」第 {row_index + 1} 行")
    if others:
        shown = "、".join(others[:3]) + ("等" if len(others) > 3 else "")
        problems.append(f"除「{name}」第 {header_index + 1} 行外，{shown}也像带上屏/标题列的表头"
                        "（图例、填写示例或另一张小表），无法确定解析器读的是哪一张")

    key_columns = {column for column, role in columns.items() if role in KEY_ROLES}
    field_columns = {column for column, role in columns.items() if role in FIELDS}
    shot_of_row = {row: shot for shot, rows in enumerate(parsed["row_groups"]) for row in rows}
    for top, left, bottom, right in merges:
        if bottom < header_index:
            continue
        touched = sorted(key_columns & set(range(left, right + 1)))
        if not touched:
            continue
        names = "、".join(f"「{collapse(header[column])}」" for column in touched)
        if right > left:
            problems.append(f"{names}列被横向合并单元格覆盖（第 {top + 1}–{bottom + 1} 行）")
        elif left in field_columns and len({shot_of_row.get(row) for row in range(top, bottom + 1)}
                                           - {None}) > 1:
            problems.append(f"{names}列有纵向合并单元格跨了不止一镜（第 {top + 1}–{bottom + 1} 行）")

    if hidden:
        shown = "、".join(hidden[:3]) + ("等" if len(hidden) > 3 else "")
        problems.append(f"「{name}」里有隐藏的列 / 行（{shown}），无法确定解析器读没读它们")

    preamble = parsed.get("preamble_rows") or []
    if preamble:
        shown = "、".join(f"第 {row + 1} 行" for row in preamble[:3]) + ("等" if len(preamble) > 3 else "")
        problems.append(f"第一个分镜号之前还有写了内容或镜号的行（{shown}，如片头），"
                        "解析器可能把它并进第 1 镜，也可能单算一镜，镜号对应说不准")
    return problems


# ----------------------------------------------------------------------------
# 按格式分派
# ----------------------------------------------------------------------------

def collect_blocks(script_path: Path) -> tuple[list[dict[str, Any]] | None, str, dict[str, Any]]:
    """脚本文件 -> 每镜的字段块。返回 `(blocks, status, info)`，读不了就 `(None, ...)`。

    `info["route"]` 记的是走了哪条路（`text` / `table`），日志与文档都按它对账。
    """
    info: dict[str, Any] = {"route": "", "roles": [], "sheets": []}
    suffix = script_path.suffix.lower()

    if suffix in OPAQUE_SUFFIXES:
        return None, "skipped:format", info

    if suffix in script_tabular.XLSX_SUFFIXES:
        return _from_workbook(script_path, info)

    if suffix in script_tabular.DOCX_SUFFIXES:
        info["route"] = "text"
        text = script_tabular.read_docx_text(script_path)
        if text is None:
            return None, "skipped:format", info
        return _from_text(text, info)

    if suffix in script_tabular.CSV_SUFFIXES:
        grid = script_tabular.read_csv_grid(script_path)
        if grid:
            parsed = extract_table_card_fields(grid)
            if parsed:
                info.update(route="table", roles=parsed["roles"],
                            ambiguous=parsed["ambiguous"], header_row=parsed["header_row"])
                problems = table_certainty_problems([("csv", grid, [])], 0, parsed)
                if problems:
                    info["uncertain"] = problems
                    return None, "skipped:uncertain", info
                return parsed["blocks"], "ok", info
        # 表头认不出来（比如 csv 里其实是逐行的纯文本脚本）-> 退回文本路
        info["route"] = "text"
        text = read_script_text(script_path)
        return _from_text(text, info) if text is not None else (None, "skipped:format", info)

    if suffix in TEXT_SUFFIXES:
        info["route"] = "text"
        text = read_script_text(script_path)
        return _from_text(text, info) if text is not None else (None, "skipped:format", info)

    return None, "skipped:format", info


def is_table_script(script_path: Path) -> bool:
    """`normalize_script` 用：这份脚本的 `card_content` 要不要按表格口径保留换行。

    xlsx / xlsm 一律是；csv 只有表头认得出来（走表格路）才是——认不出来时校验层退回
    文本路按单行比对，`compact_plan` 也得跟着折叠，两边口径一致。读失败按「不是」处理。
    """
    suffix = Path(script_path).suffix.lower()
    if suffix in script_tabular.XLSX_SUFFIXES:
        return True
    if suffix not in script_tabular.CSV_SUFFIXES:
        return False
    try:
        grid = script_tabular.read_csv_grid(Path(script_path))
        return bool(grid) and extract_table_card_fields(grid) is not None
    except Exception:  # noqa: BLE001 —— 判不了就按文本脚本，绝不带倒解析
        return False


def _from_text(text: str, info: dict[str, Any]) -> tuple[list[dict[str, Any]] | None, str, dict[str, Any]]:
    blocks = extract_shot_card_fields(text)
    return (blocks, "ok", info) if blocks is not None else (None, "skipped:no_markers", info)


def _from_workbook(script_path: Path,
                   info: dict[str, Any]) -> tuple[list[dict[str, Any]] | None, str, dict[str, Any]]:
    """xlsx/xlsm。**恰好一个 sheet 能认出分镜表**才动手。

    工作簿里有两张都像分镜表的 sheet（中英双版最常见）时，没有任何办法知道
    qwen-long 在服务端读的是哪一张——所以零动作，只告警。
    """
    info["route"] = "table"
    details = script_tabular.read_workbook_detail(script_path)
    sheets = [(detail.name, detail.grid) for detail in details] if details else None
    if not sheets:
        declared = script_tabular.sheet_count(script_path)
        if declared is not None and declared > script_tabular.MAX_SHEETS:
            # 不能笼统报「读不出来」——这份工作簿读得出来，是 sheet 太多我们主动放弃的
            info["sheets_declared"] = declared
            return None, "skipped:sheets_limit", info
        return None, "skipped:format", info
    usable = []
    for position, (name, grid) in enumerate(sheets):
        parsed = extract_table_card_fields(grid)
        if parsed:
            usable.append((name, parsed, position))
    if not usable:
        return None, "skipped:table", info
    # 有些生产工作簿的**第一张有效表**明确名为「分镜脚本」，后面另放逐镜完全相同的
    # 「旁白纯文本」副本。只在关系可证明时忽略副本：正表自己有待校验字段，副表没有，并且每镜至少一条旁白
    # 与正表逐字相同。绝不按「哪张待校验字段更多」抢表；主表在后、平台标题表复刻口播、
    # 任一镜对不上，都继续走下面的多 sheet 零动作。
    if len(usable) > 1:
        primary_name, primary, _position = usable[0]
        companions = [parsed for _name, parsed, _position in usable[1:]]

        def narration_copy(companion: dict[str, Any]) -> bool:
            if set(companion["roles"]) & set(FIELDS):
                return False
            if len(primary["blocks"]) != len(companion["blocks"]):
                return False
            for left, right in zip(primary["blocks"], companion["blocks"]):
                left_voice = (left.get("anchors") or {}).get("voice_text") or []
                right_voice = (right.get("anchors") or {}).get("voice_text") or []
                if not any(collapse(a) == collapse(b) for a in left_voice for b in right_voice):
                    return False
            return True

        if (primary_name == "分镜脚本" and set(primary["roles"]) & set(FIELDS)
                and all(narration_copy(item) for item in companions)):
            usable = usable[:1]
    if len(usable) > 1:
        info["sheets"] = [name for name, _parsed, _position in usable]
        return None, "skipped:sheets", info
    name, parsed, position = usable[0]
    info.update(roles=parsed["roles"], ambiguous=parsed["ambiguous"],
                header_row=parsed["header_row"], sheets=[name])
    problems = table_certainty_problems(
        [(detail.name, detail.grid, detail.merges, detail.hidden) for detail in details],
        position, parsed)
    if problems:
        info["uncertain"] = problems
        return None, "skipped:uncertain", info
    return parsed["blocks"], "ok", info


# ----------------------------------------------------------------------------
# 比对与纠正
# ----------------------------------------------------------------------------

def classify(script_text: str, plan_text: str, *, preserve_layout: bool = False) -> str | None:
    # 表格作者字段逐字比较内部排版；读取层给出什么换行就保留什么换行。
    # 整值 markup 的既有宽容规则仍保留。
    equal = (strip_authored_markup(script_text) == strip_authored_markup(plan_text)
             if preserve_layout else same_text(script_text, plan_text))
    if equal:
        return None
    if script_text and not plan_text:
        return "missing"
    if plan_text and not script_text:
        return "invented"
    return "rewritten"


def anchor_verdict(block: dict[str, Any], shot: dict) -> str:
    """这一镜的身份能不能被内容锚点确认。`ok` / `mismatch` / `absent`。"""
    anchors = block.get("anchors") or {}
    results: dict[str, bool] = {}
    for field, values in anchors.items():
        plan_text = collapse(shot.get(field))
        if not plan_text or not values:
            continue
        results[field] = any(anchor_matches(collapse(value), plan_text) for value in values)
    if not results:
        return "absent"
    if results.get("voice_text") is False:
        # 第二次对抗复审应修 1：口播对不上时，同名章节标题（几镜共用「痛点」）不能替它认人
        return "mismatch"
    return "ok" if any(results.values()) else "mismatch"


# 三档（写进日志与验收文档）：
# - certain  确定：原文读得准，逐镜逐字段比对，过了所有闸门的差异自动纠正；
# - warn_only 只告警：读到了原文但拿不准（表头不确定 / 多 sheet / 镜数不符），一个字不改；
# - skipped  跳过：读不到可比对的原文（格式不支持、没有分镜标记、认不出表头）。
WARN_ONLY_STATUSES = frozenset({"skipped:uncertain", "skipped:sheets", "skipped:shot_count"})


def tier_of(status: str) -> str:
    if status == "ok":
        return "certain"
    return "warn_only" if status in WARN_ONLY_STATUSES else "skipped"


def reconcile(plan: dict, script_path: Path, *, autofix: bool | None = None) -> dict[str, Any]:
    """比对并（默认）纠正 plan 里的上屏字段。返回一份报告，绝不抛异常。

    报告：`{"status", "checked", "corrections", "warnings"}`。
    `corrections` 里每条 `applied` 说明这条到底改没改。
    **改动先攒着，全部比对完才一次性落到 plan 上**——中途出岔子不留半份修改。
    """
    if autofix is None:
        autofix = env_bool(AUTOFIX_ENV, True)
    report: dict[str, Any] = {"status": "ok", "tier": "certain", "checked": 0,
                              "corrections": [], "warnings": [], "route": "", "info": {}}
    shots = plan.get("shots") if isinstance(plan, dict) else None
    if not isinstance(shots, list) or not shots:
        report["status"] = "skipped:no_shots"
        report["tier"] = tier_of(report["status"])
        return report

    blocks, status, info = collect_blocks(Path(script_path))
    report["route"] = info.get("route") or ""
    report["info"] = info
    if blocks is None:
        report["status"] = status
        report["tier"] = tier_of(status)
        if status == "skipped:sheets":
            report["warnings"].append(
                "工作簿里有不止一个 sheet 像分镜表（" + "、".join(info.get("sheets") or [])
                + "），无法确定解析器读的是哪一个，本次只提示不纠正"
            )
        elif status == "skipped:uncertain":
            for problem in info.get("uncertain") or []:
                report["warnings"].append(problem)
            report["warnings"].append(
                "表头没能百分百认准，本次一个字段都不改；请人工核对上屏文字、卡片样式与分镜标题")
        return report

    frozen: set[str] = set(info.get("ambiguous") or [])
    if info.get("route") == "table":
        for field in sorted(frozen):
            report["warnings"].append(
                f"表格里有不止一列对应 {field}（中英双语表常见），该字段本次只提示不纠正")
        roles = set(info.get("roles") or [])
        for field, label in (("card_content", "上屏文字"), ("card_hint", "卡片样式")):
            if field not in roles:
                # 2026-09-23 用户拍板：表里压根没有这一列时**绝不清空** plan 里的值——
                # 「作者没写所以清掉」只允许在表里确实有这一列、且这一镜那格为空/占位时发生。
                # （9/22 真实 v1 表就是上屏列没认出来、整片卡片被当「没写」清掉。）
                frozen.add(field)
                report["warnings"].append(
                    f"表格里没有{label}列，{field} 本次只提示不纠正（不会因此清空 plan 里的值）")

    if len(blocks) != len(shots):
        report["status"] = "skipped:shot_count"
        report["tier"] = tier_of(report["status"])
        report["warnings"].append(
            f"脚本里数到 {len(blocks)} 个分镜、plan 里是 {len(shots)} 个，对不上镜号，本次只提示不纠正"
        )
        return report

    report["checked"] = len(shots)
    report["layouts"] = []
    pending: list[tuple[dict, str, str]] = []
    frozen_hits: dict[str, int] = {}
    for index, (shot, block) in enumerate(zip(shots, blocks), 1):
        if not isinstance(shot, dict):
            continue
        verdict = anchor_verdict(block, shot)
        for field in FIELDS:
            entry = block[field]
            expected = entry["value"]
            preserve_layout = info.get("route") == "table" and field == "card_content"
            actual = str(shot.get(field) or "").strip() if preserve_layout else collapse(shot.get(field))
            kind = classify(expected, actual, preserve_layout=preserve_layout)
            layout = entry.get("layout") if field == "card_content" and expected else None
            if layout and (field in frozen or not entry["reliable"] or verdict != "ok"):
                layout = None                 # 这一镜这一格拿不准 -> 不带版式（回到默认规则）
            if kind is None:
                if entry.get("notice") and actual and field not in frozen:
                    # 两边一致，但原文这一格本身拿不准（逐行占位 / 像占位 / 无冒号标签 / 残留粗体）：
                    # 不改，提醒人看一眼——照抄的占位行会原样上屏
                    report["warnings"].append(
                        f"分镜 {index} 的 {field} 与脚本原文一致，但{entry['notice']}，请人工确认")
                if layout and autofix:
                    pending.append((shot, "card_layout", layout))
                    report["layouts"].append({"shot": index, "card_layout": layout})
                continue
            if kind == "invented" and field in NO_INVENT_FIELDS:
                # 脚本没写标题 -> plan 里那个是 schema 兜底的「分镜N」或解析器自拟的，
                # 都是合法产物，不是凭空造上屏内容。静默放过，连告警都不打（太常见）。
                continue
            blocked = ""
            if field in frozen:
                blocked = "该字段这一整张表都判不准"
            elif not entry["reliable"]:
                blocked = entry.get("doubt") or "脚本里这一镜的该字段写法不唯一或疑似跨行"
            elif verdict != "ok":
                blocked = ("口播/字幕/分镜标题都和 plan 对不上，镜号可能错位"
                           if verdict == "mismatch"
                           else "脚本这一镜没有口播/字幕/分镜标题可以用来确认镜号")
            elif (kind != "missing"
                  and strip_markup(actual) in block["foreign_values"]
                  and not (field == "title"
                           and entry.get("present")
                           and entry["reliable"])):
                blocked = "plan 里这个值在脚本本镜的其它字段行里出现过，多半是本表不认识的字段名"
            elif kind == "missing" and has_placeholder_hint(expected):
                # 第二次对抗复审应修 2：`不上屏（本镜）` 这类说明文字不在占位名单里，
                # 模型留空是对的；补上去就把「不上屏」三个字渲上屏了
                blocked = "脚本原文写的像是「不上屏 / 不填 / 留空」一类说明，不是上屏文字"
            if blocked:
                if field in frozen:          # 整表冻结的字段不逐镜刷屏，只记个数，循环后汇总
                    frozen_hits[field] = frozen_hits.get(field, 0) + 1
                else:
                    report["warnings"].append(
                        f"分镜 {index} 的 {field} 与脚本原文不一致（{KIND_LABELS[kind]}），"
                        f"但{blocked}，只提示不纠正")
                continue
            applied = False
            if autofix:
                pending.append((shot, field, expected))
                applied = True
                if layout:
                    pending.append((shot, "card_layout", layout))
                    report["layouts"].append({"shot": index, "card_layout": layout})
            report["corrections"].append({
                "shot": index, "field": field, "kind": kind,
                "plan": actual, "script": expected, "applied": applied,
            })

    for field, hits in sorted(frozen_hits.items()):
        # 冻结的字段不进 corrections，桌面端的 cardFieldCorrections 里看不到，
        # 所以至少要让运维知道「究竟有几处对不上」。
        report["warnings"].append(f"上面冻结的 {field} 本次共有 {hits} 处与脚本原文对不上")

    for shot, field, expected in pending:
        if expected:
            shot[field] = expected
        else:
            shot.pop(field, None)

    for index, shot in enumerate(shots, 1):
        # 作者写了「不上屏（本镜）」这类说明、模型又照抄了：两边一致不算差异，但它会被渲上屏。
        # 不改（拿不准是不是作者真想显示这几个字），只提醒人看一眼。看的是纠正之后的最终值。
        text = unicodedata.normalize("NFKC", str(shot.get("card_content") or "")) if isinstance(shot, dict) else ""
        # 整词匹配（第三次复审建议 6）：「不填充」「留空率」「不上屏幕」不提醒
        if PLACEHOLDER_HINT_TAIL.search(text) and not is_placeholder(text):
            report["warnings"].append(
                f"分镜 {index} 的 card_content 里有「不上屏 / 不填 / 留空」字样，会原样显示在画面上，请确认")
    return report


# ----------------------------------------------------------------------------
# 日志 / 进度事件
# ----------------------------------------------------------------------------

def printable(text: str) -> str:
    """把当前 stdout 编码表示不了的字符换成 `?`。

    日志会**原样回显作者写的值**（`解析得到 … -> 脚本原文 …`），而作者完全可能在上屏文字里
    放 emoji 或 `⚠`。中文 Windows 把 stdout 重定向到文件时按 gbk 编码，编不出来就当场抛
    `UnicodeEncodeError`——这一层的日志自己崩掉的话，「绝不带倒脚本解析」就失效了。
    模块自己写的那些字全是 ASCII 符号 + 汉字，**不安全的只可能是外来内容**，所以在
    出口统一过一道。正式引擎路径注了 `PYTHONUTF8=1`（`paths.rs:179-180`），
    编码是 utf-8，这个函数原样返回；踩雷的是手工直调 + 重定向，而验收正是那么跑的。
    """
    encoding = getattr(sys.stdout, "encoding", None) or "utf-8"
    try:
        text.encode(encoding)
        return text
    except (UnicodeEncodeError, LookupError, TypeError):
        pass
    try:
        return text.encode(encoding, errors="replace").decode(encoding, errors="replace")
    except Exception:  # noqa: BLE001 —— 连替换都失败就退到纯 ASCII，绝不往外抛
        return text.encode("ascii", errors="replace").decode("ascii")


def say(text: str) -> None:
    """这一层**唯一**的输出出口：过一道编码安全，再兜一层「打不出来也不许崩」。"""
    try:
        print(printable(text), flush=True)
    except Exception:  # noqa: BLE001
        pass


def emit_event(report: dict[str, Any]) -> None:
    """一条 `VACUT_EVENT`，沿用既有风格（stage 必须在桌面端白名单里，这里是 `script`）。

    **不带 current/total**：桌面端的 `optionalNumber` 缺席即「未知」，塞进去会被当成
    script 阶段的真实进度去算百分比。
    """
    corrections = report.get("corrections") or []
    applied = sum(1 for item in corrections if item.get("applied"))
    say(
        "VACUT_EVENT:"
        + json.dumps(
            {
                "kind": "workflow",
                "workflowStage": "script",
                "workflowStatus": "running",
                "workflowProgress": {
                    "stage": "script",
                    "status": "running",
                    "phase": "card_fields",
                    "label": f"脚本字段校正 {applied}/{len(corrections)} 处",
                },
                "cardFieldCorrections": corrections,
            },
            # 纯 ASCII：`\uXXXX` 转义在任何控制台编码下都安全，而且**一个字都不丢**
            # （`printable()` 那条 `?` 替换是给人读的日志行准备的，不该让事件数据也失真）。
            ensure_ascii=True,
        )
    )


def clip(value: str, limit: int = 40) -> str:
    return value if len(value) <= limit else value[:limit] + "…"


SKIP_REASONS = {
    "skipped:format": "脚本不是能在本地读出原文的格式（pdf / doc / xls 或文件读不出来）",
    "skipped:no_markers": "脚本里没有「分镜 N」式的分镜标记",
    "skipped:table": "表格里没认出分镜表头（列名一个都对不上）",
    "skipped:sheets": "工作簿里有不止一个 sheet 像分镜表",
    "skipped:sheets_limit": "工作簿里的 sheet 太多（超过 64 张），没法确定该读哪一张",
    "skipped:uncertain": "表格表头没能百分百认准（原因见下），只提示、不改任何字段",
}


def report_to_stdout(report: dict[str, Any]) -> None:
    """告警 + 事件。没有任何异常时只打一行「一致」，不吵。"""
    status = str(report.get("status") or "")
    if status == "skipped:no_shots":
        return
    if status in SKIP_REASONS:
        say(f"{LOG_PREFIX}：{SKIP_REASONS[status]}，跳过（不影响出片）")
        for warning in report.get("warnings") or []:
            say(f"{LOG_PREFIX} {WARN} {warning}")
        return

    for warning in report.get("warnings") or []:
        say(f"{LOG_PREFIX} {WARN} {warning}")

    for item in report.get("layouts") or []:
        say(f"{LOG_PREFIX}：分镜 {item['shot']} 按脚本版式标签用"
            f"「{LAYOUT_NAMES.get(item['card_layout'], item['card_layout'])}」版式"
            f"（card_layout={item['card_layout']}）")

    corrections = report.get("corrections") or []
    if not corrections:
        if status == "ok":
            say(f"{LOG_PREFIX}：{report.get('checked', 0)} 个分镜的上屏字段与分镜标题"
                f"与脚本原文逐字一致")
        return

    applied = sum(1 for item in corrections if item.get("applied"))
    say(f"{LOG_PREFIX} {WARN} AI 解析结果与脚本原文有 {len(corrections)} 处不一致"
        f"（上屏内容与分镜标题一律以脚本为准）"
        + (f"，已按原文纠正 {applied} 处：" if applied else f"，{AUTOFIX_ENV}=0 只提示不纠正："))
    for item in corrections:
        say(f"{LOG_PREFIX} {WARN} 分镜 {item['shot']} {item['field']} "
            f"{KIND_LABELS.get(item['kind'], item['kind'])}："
            f"解析得到 {clip(item['plan']) or '（空）'} -> "
            f"脚本原文 {clip(item['script']) or '（空）'}"
            f"{'' if item['applied'] else '（未纠正）'}")
    emit_event(report)


def verify_and_fix(plan: dict, script_path: Path) -> dict[str, Any]:
    """`normalize_script` 的唯一入口：比对、（默认）纠正、打日志。异常一律吞掉。

    比对跑在 plan 的深拷贝上，成功才把结果搬回原 plan——这样中途抛异常时原 plan
    一个字节都没动过，调用方照常写盘。日志本身也不许把任务带倒，所以再包一层。
    """
    empty = {"status": "error", "checked": 0, "corrections": [], "warnings": []}
    try:
        working = copy.deepcopy(plan)
        report = reconcile(working, Path(script_path))
        if isinstance(working.get("shots"), list):
            plan["shots"] = working["shots"]
    except Exception as error:  # noqa: BLE001 —— 校验失败绝不能带倒整条脚本解析
        # `say` 自己已经吞掉一切异常（编码安全 + 兜底），这里不用再包一层
        say(f"{LOG_PREFIX} {WARN} 校验本身出错，已跳过（不影响出片）："
            f"{type(error).__name__}: {error}")
        return empty
    try:
        report_to_stdout(report)
    except Exception as error:  # noqa: BLE001
        say(f"{LOG_PREFIX} {WARN} 打日志出错，已跳过：{type(error).__name__}: {error}")
    return report


__all__ = [
    "AUTOFIX_ENV",
    "CARD_LAYOUTS",
    "layout_from_labels",
    "FIELDS",
    "NO_INVENT_FIELDS",
    "anchor_verdict",
    "collect_blocks",
    "column_role",
    "is_table_script",
    "detect_header",
    "header_candidates",
    "extract_table_card_fields",
    "collapse",
    "extract_shot_card_fields",
    "is_placeholder",
    "looks_like_placeholder",
    "field_doubt",
    "printable",
    "read_script_text",
    "reconcile",
    "report_to_stdout",
    "say",
    "verify_and_fix",
]
