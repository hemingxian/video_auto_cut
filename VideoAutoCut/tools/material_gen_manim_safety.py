from __future__ import annotations

import ast


def inject_manim_helper_prelude(source: str) -> str:
    """Keep generated Manim code self-contained without hiding invalid APIs."""
    text = (source or "").strip()
    if not text:
        return text
    if "from manim import" in text:
        return text + ("\n" if not text.endswith("\n") else "")
    return "from manim import *\n" + text + ("\n" if not text.endswith("\n") else "")


def validate_manim_source(source: str) -> None:
    if "class GeneratedMaterialScene" not in source:
        raise ValueError("脚本必须定义 class GeneratedMaterialScene")
    if ".get_words(" in source:
        raise ValueError("不要使用 Text.get_words()，当前 Manim 环境不保证支持该 API")

    tree = ast.parse(source)
    allowed_modules = {"manim", "math", "random", "numpy"}
    blocked_manim_names = {
        "MathTex",
        "Tex",
        "SingleStringMathTex",
        "Matrix",
        "MobjectMatrix",
        "DecimalNumber",
        "Integer",
        "Variable",
        "NumberLine",
        "GrowFromBottom",
    }
    blocked_names = {
        "open", "exec", "eval", "compile", "__import__", "input", "globals", "locals",
        "vars", "dir", "getattr", "setattr", "delattr", "breakpoint",
    }
    blocked_roots = {
        "os", "sys", "subprocess", "pathlib", "shutil", "socket", "requests", "urllib",
        "http", "ftplib", "glob", "tempfile", "pickle", "ctypes", "importlib",
    }
    blocked_attributes = blocked_roots | {
        "DataSource",
        "ctypeslib",
        "dump",
        "dumps",
        "fromfile",
        "genfromtxt",
        "load",
        "loads",
        "loadtxt",
        "memmap",
        "open_memmap",
        "popen",
        "save",
        "savetxt",
        "savez",
        "savez_compressed",
        "system",
        "tofile",
    }

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name not in allowed_modules:
                    raise ValueError(f"不允许导入模块: {alias.name}")
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            if node.level or module not in allowed_modules:
                raise ValueError(f"不允许导入模块: {node.module}")
            for alias in node.names:
                if alias.name == "*":
                    if module != "manim":
                        raise ValueError(f"不允许从 {module} 使用通配符导入")
                    continue
                if alias.name.startswith("_") or alias.name in blocked_attributes:
                    raise ValueError(f"不允许从 {module} 导入: {alias.name}")
        elif isinstance(node, ast.Name):
            if node.id in blocked_manim_names:
                raise ValueError(
                    f"当前 Manim 运行环境不支持 {node.id}。"
                    "不要使用 TeX/LaTeX 依赖对象；公式和数字请用 Text 或手工 VGroup 绘制。"
                    "GrowFromBottom 请改用 GrowFromEdge(bar, DOWN)、FadeIn 或 Create。"
                )
            if node.id in blocked_names or node.id in blocked_attributes or node.id.startswith("__"):
                raise ValueError(f"脚本包含不允许的名称: {node.id}")
        elif isinstance(node, ast.Attribute):
            if node.attr in blocked_manim_names:
                raise ValueError(
                    f"当前 Manim 运行环境不支持 {node.attr}。"
                    "不要使用 TeX/LaTeX 依赖对象；公式和数字请用 Text 或手工 VGroup 绘制。"
                )
            if node.attr.startswith("_") or node.attr in blocked_attributes:
                raise ValueError(f"脚本包含不允许的属性: {node.attr}")
