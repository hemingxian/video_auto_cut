from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


TOOLS_DIR = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS_DIR))

from register_voice_template import (  # noqa: E402
    load_voice_registry,
    safe_upload_filename,
    update_env_value,
)


class VoiceConfigSafetyTests(unittest.TestCase):
    def test_env_update_rejects_name_and_value_injection(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "app.env"
            with self.assertRaises(ValueError):
                update_env_value(path, "BAD-NAME", "value")
            with self.assertRaises(ValueError):
                update_env_value(path, "VALID_NAME", "ok\nINJECTED=true")
            self.assertFalse(path.exists())

    def test_env_update_preserves_other_values(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "app.env"
            path.write_text("KEEP=yes\nVOICE=old\n", encoding="utf-8")
            update_env_value(path, "VOICE", "new")
            self.assertEqual(path.read_text(encoding="utf-8"), "KEEP=yes\nVOICE=new\n")

    def test_upload_filename_is_header_safe(self) -> None:
        filename = safe_upload_filename(Path("我的 声音;sample.mp3"))
        self.assertEqual(filename, "我的_声音_sample.mp3")
        self.assertNotRegex(filename, r"[\r\n\"/\\]")

    def test_invalid_registry_is_not_silently_overwritten_as_empty(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            registry = root / "voice_templates" / "voice_registry.json"
            registry.parent.mkdir(parents=True)
            registry.write_text("{broken", encoding="utf-8")
            with mock.patch.dict(os.environ, {"VIDEOAUTO_DATA_ROOT": str(root)}, clear=False):
                with self.assertRaisesRegex(ValueError, "voice_registry.json"):
                    load_voice_registry()


if __name__ == "__main__":
    unittest.main()
