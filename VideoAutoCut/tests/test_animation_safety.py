from __future__ import annotations

import sys
import unittest
from pathlib import Path


TOOLS_DIR = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS_DIR))

from animation_agent.source_utils import (  # noqa: E402
    extract_source,
    validate_source_filename,
)
from material_gen_manim_safety import validate_manim_source  # noqa: E402


VALID_MANIM_SOURCE = """
from manim import *
import math

class GeneratedMaterialScene(Scene):
    def construct(self):
        dot = Dot().shift(RIGHT * math.cos(0))
        self.play(FadeIn(dot))
"""


class GeneratedSourceBoundaryTests(unittest.TestCase):
    def test_expected_code_fence_is_removed(self) -> None:
        self.assertEqual(
            extract_source({"source": "```python\nprint('ok')\n```"}, {"python"}),
            "print('ok')",
        )

    def test_unexpected_code_fence_is_not_silently_relabelled(self) -> None:
        source = "```bash\nrm -rf .\n```"
        self.assertEqual(extract_source(source, {"python"}), source)

    def test_source_filename_must_be_a_plain_filename(self) -> None:
        self.assertEqual(validate_source_filename("index.html"), "index.html")
        for value in (
            "",
            "..",
            "../index.html",
            "..\\index.html",
            "/tmp/x",
            "a/b",
            "C:relative.html",
        ):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    validate_source_filename(value)


class ManimSourceSafetyTests(unittest.TestCase):
    def test_normal_scene_is_allowed(self) -> None:
        validate_manim_source(VALID_MANIM_SOURCE)

    def test_submodule_import_is_rejected(self) -> None:
        source = VALID_MANIM_SOURCE + "\nimport numpy.ctypeslib\n"
        with self.assertRaisesRegex(ValueError, "不允许导入模块"):
            validate_manim_source(source)

    def test_dangerous_symbol_cannot_be_aliased_from_allowed_module(self) -> None:
        source = VALID_MANIM_SOURCE + "\nfrom manim import os as harmless\n"
        with self.assertRaisesRegex(ValueError, "不允许从 manim 导入"):
            validate_manim_source(source)

    def test_private_module_attribute_is_rejected(self) -> None:
        source = VALID_MANIM_SOURCE + "\nimport random\nrandom._os.system('whoami')\n"
        with self.assertRaisesRegex(ValueError, "不允许的属性"):
            validate_manim_source(source)

    def test_numpy_file_access_is_rejected(self) -> None:
        source = VALID_MANIM_SOURCE + "\nimport numpy as np\nnp.load('payload.npy')\n"
        with self.assertRaisesRegex(ValueError, "不允许的属性: load"):
            validate_manim_source(source)


if __name__ == "__main__":
    unittest.main()
