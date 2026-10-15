"""Word-safe wrapping using the font actually selected on the rendering host."""
from __future__ import annotations

import logging
import os
import re
import subprocess
import tempfile
import warnings
from functools import lru_cache
from pathlib import Path


def bundled_font_directory() -> Path:
    return Path(__file__).resolve().parents[1] / "fonts" / "noto-sans-cjk-sc"


@lru_cache(maxsize=1)
def register_bundled_fonts() -> None:
    """Register only in this render process; no system font installation."""
    if os.name != "nt":
        return
    import ctypes
    from ctypes import wintypes

    gdi = ctypes.WinDLL("gdi32", use_last_error=True)
    gdi.AddFontResourceExW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.LPVOID]
    gdi.AddFontResourceExW.restype = ctypes.c_int
    for name in ("NotoSansCJKsc-Regular.otf", "NotoSansCJKsc-Bold.otf"):
        path = bundled_font_directory() / name
        if not path.is_file() or not gdi.AddFontResourceExW(str(path), 0x10, None):
            raise RuntimeError(f"内置字体加载失败: {path}")


@lru_cache(maxsize=8192)
def text_width(text: str, font: str, size: int, bold: bool = True) -> float:
    if not text:
        return 0.0
    if font == "Noto Sans CJK SC":
        register_bundled_fonts()
    if os.name == "nt":
        return _windows_text_width(text, font, size, bold)
    return float(_pillow_font(font, size, bold).getlength(text))


def _windows_text_width(text: str, font: str, size: int, bold: bool) -> float:
    # GDI resolves family names and fallback glyphs without shipping another
    # font catalogue. Explicit handle types are necessary on 64-bit Windows.
    import ctypes
    from ctypes import wintypes

    gdi = ctypes.WinDLL("gdi32", use_last_error=True)
    gdi.CreateCompatibleDC.argtypes = [wintypes.HDC]
    gdi.CreateCompatibleDC.restype = wintypes.HDC
    gdi.CreateFontW.argtypes = [ctypes.c_int] * 5 + [wintypes.DWORD] * 8 + [wintypes.LPCWSTR]
    gdi.CreateFontW.restype = wintypes.HFONT
    gdi.SelectObject.argtypes = [wintypes.HDC, wintypes.HGDIOBJ]
    gdi.SelectObject.restype = wintypes.HGDIOBJ
    gdi.GetTextExtentPoint32W.argtypes = [wintypes.HDC, wintypes.LPCWSTR, ctypes.c_int, ctypes.POINTER(wintypes.SIZE)]
    gdi.GetTextExtentPoint32W.restype = wintypes.BOOL
    gdi.DeleteObject.argtypes = [wintypes.HGDIOBJ]
    gdi.DeleteDC.argtypes = [wintypes.HDC]
    dc = gdi.CreateCompatibleDC(None)
    handle = gdi.CreateFontW(-max(1, size), 0, 0, 0, 700 if bold else 400, 0, 0, 0, 1, 0, 0, 4, 0, font)
    if not dc or not handle:
        if handle:
            gdi.DeleteObject(handle)
        if dc:
            gdi.DeleteDC(dc)
        raise OSError("无法创建字幕字体测量上下文")
    previous = gdi.SelectObject(dc, handle)
    try:
        measured = wintypes.SIZE()
        if not gdi.GetTextExtentPoint32W(dc, text, len(text.encode("utf-16-le")) // 2, ctypes.byref(measured)):
            raise OSError("无法测量字幕字体宽度")
        return float(measured.cx)
    finally:
        gdi.SelectObject(dc, previous)
        gdi.DeleteObject(handle)
        gdi.DeleteDC(dc)


@lru_cache(maxsize=128)
def _pillow_font(font: str, size: int, bold: bool):
    from PIL import ImageFont

    if font == "Noto Sans CJK SC":
        return ImageFont.truetype(str(bundled_font_directory() / f"NotoSansCJKsc-{'Bold' if bold else 'Regular'}.otf"), max(1, size))
    result = subprocess.check_output(
        ["fc-match", "-f", "%{file}", f"{font}:weight={'bold' if bold else 'regular'}"],
        text=True, timeout=10,
    ).strip()
    if not result:
        raise RuntimeError(f"找不到用于字幕排版的字体: {font}")
    return ImageFont.truetype(result, max(1, size))


def text_units(text: str) -> list[str]:
    # Keep whitespace and whole Unicode words, including apostrophes, product
    # identifiers and hyphens. CJK remains breakable between characters.
    return re.findall(r"\s+|[\u3400-\u9fff\uf900-\ufaff]|[^\W_]+(?:['’._/+\-][^\W_]+)*|[^\s]", text or "")


def _subtitle_plain_text_units(text: str) -> list[str]:
    """Keep exact subtitle whitespace while separating explicit line breaks."""
    return re.findall(
        r"\r\n|[\r\n]|[^\S\r\n]+|[\u3400-\u9fff\uf900-\ufaff]|[^\W_]+(?:['’._/+\-][^\W_]+)*|[^\s]",
        text or "",
    )


# ---------------------------------------------------------------------------
# 模板包装卡片专用的换行禁则（kinsoku）。2026-09-21 加，只有 template_packaging 会开。
#
# ⚠️ 字幕（common.subtitle_display_pages）与进度条标签（add_progress）**不走这条禁则**：
# 字幕单独启用固定词典的中文词边界；进度条仍走默认逐汉字路径。两者都不带 kinsoku。
#
# ⚠️ 第二条铁律：**kinsoku 不许比不加禁则时多造出任何一条超宽的行**。上层
# （template_packaging.build_composition）会为超宽行一路压字号，压到下限还超就抛
# 「模板上屏文字包含无法完整显示的超长词」——排版规则把本来能出片的卡片弄挂，是本末倒置。
# 所以每一条会把字符塞进某一行的规则（黏合、行首禁则、行尾禁则、孤字回退）都必须先过 `fits`，
# 过不了就退回普通换行。`PackagingKinsokuTests.test_kinsoku_never_widens_a_line_beyond_plain`
# 用一批语料把这条钉死了。
# ---------------------------------------------------------------------------

# 行首禁则：这些符号不能落在一行的开头（原有那串 + 直角引号、百分号、度数符号、省略号）。
NO_LINE_START = "，,。！？!?；;：:、)]）】》”’"
KINSOKU_NO_LINE_START = NO_LINE_START + "」』〉%‰℃°…"
# 判「孤字行」时可以剥掉的结尾标点。**不含 %‰℃°**——那几个是内容不是标点（「温%」不是孤字）。
KINSOKU_TRAILING_PUNCT = NO_LINE_START + "」』〉…"
# 行尾禁则：开括号 / 开引号不留在行尾，跟着下一行走。
KINSOKU_NO_LINE_END = "（(【《「『“‘〈[{"
# 「数字 + 单位」当一个整体：数字后面紧跟的这些符号算单位的一部分（700 包/小时、12件/分、35%、180℃）。
KINSOKU_UNIT_GLUE = "/／·%‰°℃"
# 单位符号（/ · % ℃ …）之后最多再收几个汉字：「/小时」2 个够用。数字后面第一段只收 1 个。
KINSOKU_UNIT_HAN_LIMIT = 2

_HAN = re.compile(r"[\u3400-\u9fff\uf900-\ufaff]")
_HAN_RUN = re.compile(r"[\u3400-\u9fff\uf900-\ufaff]+")
_HAS_DIGIT = re.compile(r"\d")
_JIEBA_VERSION = "0.42.1"
_JIEBA_DICT_SHA256 = "7197c3211ddd98962b036cdf40324d1ea2bfaa12bd028e68faa70111a88e12a8"


@lru_cache(maxsize=1)
def _subtitle_tokenizer():
    """Load the fixed offline tokenizer only when a subtitle needs wrapping."""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            from _vendor import jieba
            from _vendor.jieba import finalseg as _finalseg  # noqa: F401
    except ImportError as exc:  # Never silently fall back to per-Han wrapping.
        raise RuntimeError("离线中文字幕分词器缺失") from exc

    # Keep routine dictionary/cache diagnostics out of renderer contracts,
    # while retaining real warnings and errors from upstream.
    jieba.setLogLevel(logging.WARNING)
    tokenizer = jieba.Tokenizer()
    cache_dir = _subtitle_cache_directory()
    if cache_dir is None or not _cache_directory_is_writable(cache_dir):
        _initialize_tokenizer_in_memory(tokenizer)
    else:
        tokenizer.tmp_dir = str(cache_dir)
        # Upstream otherwise shares ``jieba.cache`` with every jieba
        # installation. Bind this cache to the fixed vendored dictionary.
        tokenizer.cache_file = f"videoautocut-jieba-{_JIEBA_VERSION}-{_JIEBA_DICT_SHA256[:12]}.cache"
        tokenizer.initialize()
    return tokenizer


def _subtitle_cache_directory() -> Path | None:
    """Resolve a jieba cache only inside an explicitly configured workspace."""
    configured = (os.environ.get("VIDEOAUTO_DATA_ROOT", "").strip()
                  or os.environ.get("VIDEOAUTO_WORKSPACE_DIR", "").strip())
    if not configured:
        return None
    workspace = Path(configured).expanduser().resolve()
    candidate = (workspace / ".videoautocut" / "cache" / "jieba").resolve()
    try:
        candidate.relative_to(workspace)
    except ValueError:
        return None
    configured_runtime = (os.environ.get("VIDEOAUTO_RUNTIME_ROOT", "").strip()
                          or os.environ.get("VIDEOAUTO_ROOT", "").strip())
    runtime = (Path(configured_runtime).expanduser().resolve() if configured_runtime
               else Path(__file__).resolve().parents[1])
    try:
        candidate.relative_to(runtime)
    except ValueError:
        pass
    else:
        # Installed runtimes can be read-only and must remain immutable even
        # if a caller accidentally points the data/workspace variable there.
        return None
    return candidate


def _cache_directory_is_writable(cache_dir: Path) -> bool:
    """Probe the exact cache directory and remove the probe before returning."""
    try:
        cache_dir.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(prefix=".write-probe-", dir=cache_dir, delete=True):
            pass
        return True
    except OSError:
        return False


def _initialize_tokenizer_in_memory(tokenizer) -> None:
    """Build the fixed prefix dictionary without asking upstream for a temp dir."""
    with tokenizer.lock:
        if tokenizer.initialized:
            return
        tokenizer.FREQ, tokenizer.total = tokenizer.gen_pfdict(tokenizer.get_dict_file())
        tokenizer.initialized = True


def subtitle_text_units(text: str) -> list[str]:
    """Return ordinary Unicode units plus offline-tokenized contiguous Han runs."""
    units: list[str] = []
    tokenizer = None
    for chunk in re.split(r"([\u3400-\u9fff\uf900-\ufaff]+)", text or ""):
        if not chunk:
            continue
        if _HAN_RUN.fullmatch(chunk):
            tokenizer = tokenizer or _subtitle_tokenizer()
            units.extend(tokenizer.cut(chunk, HMM=True))
        else:
            units.extend(_subtitle_plain_text_units(chunk))
    return units


def _split_oversized_cjk_units(units: list[str], fits) -> list[str]:
    """Split only a Chinese token wider than a whole line, preserving every codepoint."""
    result: list[str] = []
    for unit in units:
        if unit.isspace() or not _HAN.search(unit) or fits(unit):
            result.append(unit)
            continue
        piece = ""
        for character in unit:
            if piece and not fits(piece + character):
                result.append(piece)
                piece = character
            else:
                piece += character
        if piece:
            result.append(piece)
    return result


def _glue_number_units(units: list[str], fits, *, preserve_separator: bool = False) -> list[str]:
    """把「数字 + 单位」黏成一个不可断单元：`700 包/小时`、`12件/分`、`35%`、`180℃`。

    起点是含数字的字母数字单元；后面最多允许**一个**普通空格（且空格后必须是汉字），
    再收紧跟的汉字与 `/·%‰°℃` 这类单位符号，汉字最多 KINSOKU_UNIT_HAN_LIMIT 个，
    遇到顿号、竖线、字母词、第二个空格就停。单位符号**不要求前面先有汉字**，
    所以 `35%` / `180℃` 也会被黏住——这同时让 `%` `℃` 不会自己跑到行首去。

    黏出来的整体必须自己放得进一行（`fits`），否则原样退回——不能因为加了这条规则，
    就把原本排得下的卡片逼出「超长词」错误。
    """
    glued: list[str] = []
    index = 0
    while index < len(units):
        unit = units[index]
        if unit.isspace() or not _HAS_DIGIT.search(unit):
            glued.append(unit)
            index += 1
            continue
        end = index + 1
        if end + 1 < len(units) and units[end] == " " and _HAN.fullmatch(units[end + 1]):
            end += 1
        absorbed = 0
        # 单位的形状：先最多 1 个汉字（「700 包」「12件」），之后每遇到一个 / · % ℃ 这类
        # 单位符号，再最多收 2 个汉字（「/小时」「/分」）。不贪心——多收一个字就可能把
        # 下一个词的词头黏进来，反而制造断点（「700保输并抓」那种）。
        allowance = 1
        while end < len(units):
            following = units[end]
            if _HAN.fullmatch(following):
                if allowance <= 0:
                    break
                allowance -= 1
            elif following in KINSOKU_UNIT_GLUE:
                allowance = KINSOKU_UNIT_HAN_LIMIT
            else:
                break
            absorbed += 1
            end += 1
        candidate = "".join(units[index:end])
        preceding_separator = glued[-1] if glued and glued[-1].isspace() else ""
        if (absorbed and fits(candidate)
                and (not preserve_separator or fits(preceding_separator + candidate))):
            glued.append(candidate)
            index = end
        else:
            glued.append(unit)
            index += 1
    return glued


def _is_single_han_line(line: str) -> bool:
    """这一行去掉首尾空白与结尾标点之后，是不是只剩一个汉字。"""
    text = line.strip().rstrip(KINSOKU_TRAILING_PUNCT)
    return len(text) == 1 and bool(_HAN.fullmatch(text))


def _reflow_orphan_lines(lines: list[str], fits, atomic=(), *, preserve_spaces: bool = False) -> list[str]:
    """行尾孤字回退：某一行只剩 1 个汉字时，从上一行末尾借一个汉字下来凑成 2 个。

    这修的是「路径确｜认」那类最刺眼的切词——下一行只剩一个「认」字。判定不需要分词表，
    只看「这一行的汉字是不是只有一个」，所以确定性、可解释。

    限制：只借 1 个字；上一行末尾必须是汉字；**借完上一行自己不能变成孤字行**（否则只是
    把问题往上推一行，而且本函数从前往后走不会回头再修）；不从 `atomic`（黏好的
    「数字+单位」）里抠字；借完的那一行仍要过 `fits`。**不处理「拍确认」这种下一行有两个字
    以上的切词**——那要判词边界，不引入分词库做不到，见 docs。
    """
    for index in range(1, len(lines)):
        if not _is_single_han_line(lines[index]):
            continue
        previous = lines[index - 1]
        if len(previous) < 2 or not _HAN.fullmatch(previous[-1]):
            continue
        if previous[-2] in KINSOKU_NO_LINE_END or _is_single_han_line(previous[:-1]):
            continue
        if any(previous.endswith(unit) for unit in atomic):
            continue
        moved = previous[-1] + lines[index]
        if not fits(moved):
            continue
        lines[index - 1] = previous[:-1] if preserve_spaces else previous[:-1].rstrip(" ")
        lines[index] = moved
    return lines


def _wrap_text_legacy(text: str, fits, *, kinsoku: bool = False) -> list[str]:
    """Exact a3e64b4 wrapping for progress labels and packaging cards."""
    lines: list[str] = []
    current = ""
    parts: list[str] = []
    pending_space = ""
    no_line_start = KINSOKU_NO_LINE_START if kinsoku else NO_LINE_START
    units = []
    for chunk in re.split(r"([\u3400-\u9fff\uf900-\ufaff])", text or ""):
        units.extend(text_units(chunk))
    atomic: set[str] = set()
    if kinsoku:
        units = _glue_number_units(units, fits)
        atomic = {unit for unit in units if len(unit) > 1 and _HAN.fullmatch(unit[-1])}
    for unit in units:
        if unit.isspace():
            if "\n" in unit and current:
                lines.append(current)
                current = ""
                parts = []
            pending_space = " " if current else ""
            continue
        piece = pending_space + unit
        candidate = current + piece
        if current and not fits(candidate) and unit[0] not in no_line_start:
            held = ""
            if kinsoku:
                while (len(parts) > 1 and parts[-1] in KINSOKU_NO_LINE_END
                       and fits(parts[-1] + held + unit)
                       and not _is_single_han_line("".join(parts[:-1]))):
                    held = parts.pop() + held
            lines.append("".join(parts))
            current = held + unit
            parts = ([held] if held else []) + [unit]
        elif current and not fits(candidate) and kinsoku:
            moved = parts[-1].lstrip(" ") + unit if parts else ""
            head = "".join(parts[:-1])
            if len(parts) > 1 and fits(moved) and not _is_single_han_line(head):
                lines.append(head)
            else:
                lines.append(current)
                moved = unit
            current = moved
            parts = [moved]
        else:
            current = candidate
            parts.append(piece)
        pending_space = ""
    if current:
        lines.append(current)
    return _reflow_orphan_lines(lines, fits, atomic) if kinsoku else lines


def wrap_text(text: str, fits, *, kinsoku: bool = False,
              cjk_word_boundaries: bool = False) -> list[str]:
    """Wrap text; exact whitespace preservation is subtitle-only."""
    if not cjk_word_boundaries:
        return _wrap_text_legacy(text, fits, kinsoku=kinsoku)

    lines: list[str] = []
    current = ""
    # current 由哪些片段拼成（每段 = 前导空格 + 单元），"".join(parts) 恒等于 current。
    # 只有 kinsoku 的两条禁则要用它把「最后一个单元」整体挪行。
    parts: list[str] = []
    pending_space = ""
    no_line_start = KINSOKU_NO_LINE_START if kinsoku else NO_LINE_START
    units = _split_oversized_cjk_units(subtitle_text_units(text), fits)
    atomic: set[str] = set()
    if kinsoku:
        units = _glue_number_units(units, fits, preserve_separator=True)
        # 黏好的「数字+单位」是这里唯一以汉字结尾的多字单元，孤字回退不许从里面抠字。
        atomic = {unit for unit in units if len(unit) > 1 and _HAN.fullmatch(unit[-1])}
    for unit in units:
        if unit.isspace():
            if unit in {"\r", "\n", "\r\n"}:
                if current or pending_space:
                    current += pending_space
                    lines.append(current)
                current = ""
                parts = []
                pending_space = ""
            else:
                pending_space += unit
            continue
        piece = pending_space + unit
        candidate = current + piece
        if current and not fits(candidate) and unit[0] not in no_line_start:
            # Preserve the exact separator without making an exactly-line-wide
            # next token overflow when the preceding line has room for it.
            if pending_space and fits(current + pending_space):
                current += pending_space
                parts.append(pending_space)
                piece = unit
            held = ""
            if kinsoku:
                # 行尾禁则：开括号 / 开引号不留在行尾，跟着下一行走。挪不动（挪完放不下、
                # 或本行只剩这一个单元）就维持原样，绝不硬塞。
                while (len(parts) > 1 and parts[-1] in KINSOKU_NO_LINE_END
                       and fits(parts[-1] + held + unit)
                       and not _is_single_han_line("".join(parts[:-1]))):
                    held = parts.pop() + held
            lines.append("".join(parts))
            current = held + piece
            parts = ([held] if held else []) + [piece]
        elif current and not fits(candidate) and kinsoku:
            # 行首禁则遇上「放不下」：先试「追い出し」——把本行最后一个单元连同这个符号一起
            # 挪到下一行；追不动就老老实实换行，让符号落在行首。**绝不无条件硬拼**，
            # 那会造出比不加禁则还宽的行，上层先压字号、压不动就抛「超长词」。
            moved = parts[-1] + pending_space + unit if parts else ""
            head = "".join(parts[:-1])
            if len(parts) > 1 and fits(moved) and not _is_single_han_line(head):
                lines.append(head)
            else:
                lines.append(current)
                moved = pending_space + unit
            current = moved
            parts = [moved]
        else:
            current = candidate
            parts.append(piece)
        pending_space = ""
    if pending_space:
        current += pending_space
    if current:
        lines.append(current)
    return (_reflow_orphan_lines(lines, fits, atomic, preserve_spaces=True)
            if kinsoku else lines)


def wrap_text_pixels(text: str, width: float, font: str, size: int, bold: bool = True, *,
                     kinsoku: bool = False, cjk_word_boundaries: bool = False) -> list[str]:
    return wrap_text(text, lambda candidate: text_width(candidate, font, size, bold) <= width,
                     kinsoku=kinsoku, cjk_word_boundaries=cjk_word_boundaries)


def fit_label(text: str, width: float, height: float, font: str, size: int, minimum: int) -> tuple[list[str], int] | None:
    """Fit complete labels on at most two lines, never cutting a word."""
    for candidate_size in range(max(1, size), max(1, minimum) - 1, -1):
        lines = wrap_text_pixels(text, width, font, candidate_size)
        if (len(lines) <= 2 and len(lines) * candidate_size * 1.35 <= height
                and all(text_width(line, font, candidate_size) <= width for line in lines)):
            return lines, candidate_size
    return None
