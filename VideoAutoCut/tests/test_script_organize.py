from __future__ import annotations

import copy
import contextlib
import io
import json
import os
import sys
import tempfile
import subprocess
import tarfile
import types
import uuid
import unittest
import zipfile
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "VideoAutoCut" / "tools"
sys.path.insert(0, str(TOOLS))

import normalize_script
import script_organize
import script_card_fields
import shot_plan_schema


def raw_shot(**changes):
    value = {"shot": 1, "title": "标题", "duration": 2, "visual_query": "机械臂抓取",
             "download_query": "机械臂", "voice_text": "这是原文口播正文", "voiceover": True,
             "subtitle": "原文字幕", "card_content": "", "card_hint": "",
             "shot_size": "近景", "camera_move": "推", "camera_angle": "俯拍",
             "transition": "叠化", "material_source": "指定：a.mp4",
             "evidence": {"shot_size": "景别：近景", "camera_move": "镜头推近",
                          "camera_angle": "拍摄角度：俯拍", "transition": "转场：叠化"},
             "voice_source": {"source": "document_quote", "value": "这是原文口播正文"}}
    value.update(changes)
    return value


class ScriptOrganizeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name, "plain.txt")
        self.path.write_text("语言：中文\n分镜标题：标题\n景别：近景\n镜头推近\n拍摄角度：俯拍\n转场：叠化\n这是原文口播正文\n原文字幕\n指定：a.mp4", encoding="utf-8")

    def organize(self, item=None, suffix_path=None):
        item = item or raw_shot()
        plan = normalize_script.compact_plan({"topic": "固定", "shots": [copy.deepcopy(item)]}, "固定")
        return script_organize.organize(plan, suffix_path or self.path,
                                        {"project_info": {"片名": "不存在", "语言": "原文"},
                                         "shots": [copy.deepcopy(item)]})

    def test_o1_preserves_legacy_fields_except_unquoted_subtitle(self):
        item = raw_shot(subtitle="模型生成字幕")
        before = normalize_script.compact_plan({"topic": "固定", "shots": [copy.deepcopy(item)]}, "固定")
        after = script_organize.organize(copy.deepcopy(before), self.path, {"shots": [item]})
        old_shot, new_shot = before["shots"][0], copy.deepcopy(after["shots"][0])
        new_shot.pop("script_meta")
        self.assertNotIn("subtitle", new_shot)
        old_shot.pop("subtitle")
        self.assertEqual(old_shot, new_shot)
        self.assertEqual({"script_source"}, set(after) - set(before))

    def test_o2_camera_requires_dictionary_contiguous_evidence_and_context(self):
        cases = [
            ("missing_evidence", {"evidence": {}}, "shot_size", "不限"),
            ("not_in_source", {"evidence": {"shot_size": "别处景别：近景"}}, "shot_size", "不限"),
            ("word_missing", {"evidence": {"shot_size": "景别字段"}}, "shot_size", "不限"),
            ("not_in_dictionary", {"shot_size": "近景特写", "evidence": {"shot_size": "景别：近景特写"}}, "shot_size", "不限"),
            ("single_without_context", {"camera_move": "跟", "evidence": {"camera_move": "节拍才跟得上产线"}}, "camera_move", "不限"),
            ("alias", {"shot_size": "特写", "evidence": {"shot_size": "景别：大特写"}}, "shot_size", "不限"),
            ("combined_alias", {"shot_size": "特写", "evidence": {"shot_size": "景别：近景特写"}}, "shot_size", "不限"),
            ("angle_without_evidence", {"evidence": {"camera_angle": ""}}, "camera_angle", "不限"),
            ("transition_without_evidence", {"evidence": {"transition": ""}}, "transition", ""),
        ]
        for name, changes, field, expected in cases:
            with self.subTest(name=name):
                evidence = next(iter(changes.get("evidence", {}).values()), "")
                if name in {"word_missing", "not_in_dictionary", "single_without_context", "alias", "combined_alias"}:
                    self.path.write_text(self.path.read_text(encoding="utf-8") + "\n" + evidence,
                                         encoding="utf-8")
                item = raw_shot(**changes)
                meta = self.organize(item)["shots"][0]["script_meta"]
                self.assertEqual(expected, meta[field])
                self.assertIn("camera_inferred_dropped", [w["code"] for w in meta["review"]["warnings"]])
        positive = self.organize()["shots"][0]["script_meta"]
        self.assertEqual(("近景", "推", "俯拍", "叠化"),
                         tuple(positive[field] for field in script_organize.CAMERA_FIELDS))

    def test_o3_pdf_camera_is_unverifiable_and_defaults(self):
        opaque = Path(self.temp.name, "plain.pdf")
        opaque.write_bytes(b"pdf")
        meta = self.organize(suffix_path=opaque)["shots"][0]["script_meta"]
        self.assertEqual(("不限", "不限", "不限", ""),
                         (meta["shot_size"], meta["camera_move"], meta["camera_angle"], meta["transition"]))
        self.assertIn("camera_unverifiable", [w["code"] for w in meta["review"]["warnings"]])

    def test_o4_generated_subtitle_is_cleared_with_warning_and_no_hint(self):
        result = self.organize(raw_shot(subtitle="不存在字幕"))["shots"][0]
        self.assertNotIn("subtitle", result)
        self.assertNotIn("render_hints", result)
        self.assertIn("subtitle_not_in_script", [w["code"] for w in result["script_meta"]["review"]["warnings"]])

    def test_o5_card_fields_are_not_invented_by_organizer(self):
        source = Path(self.temp.name, "cards.md")
        source.write_text("# 脚本\n\n## 分镜 1\n\n- 分镜标题：标题\n- 口播：这是原文口播正文\n- 上屏文字：（不填）\n- 卡片样式：（不填）\n\n## 分镜 2\n\n- 分镜标题：第二镜\n- 口播：第二镜原文口播正文\n- 上屏文字：（不填）\n- 卡片样式：（不填）\n", encoding="utf-8")
        item = raw_shot(title="标题", card_content="模型臆造卡片", card_hint="模型臆造样式")
        second = raw_shot(title="第二镜", voice_text="第二镜原文口播正文",
                          voice_source={"source": "document_quote", "value": "第二镜原文口播正文"},
                          card_content="模型臆造卡片二", card_hint="模型臆造样式二")
        plan = normalize_script.compact_plan({"topic": "固定", "shots": [copy.deepcopy(item), copy.deepcopy(second)]}, "固定")
        script_card_fields.verify_and_fix(plan, source)
        result = script_organize.organize(plan, source, {"shots": [item, second]})["shots"][0]
        self.assertNotIn("card_content", result)
        self.assertNotIn("card_hint", result)
        self.assertNotIn("authored", result["script_meta"])

    def test_o6_all_sixteen_fields_pending_and_origins_exact(self):
        item = raw_shot(voice_source={"source": "document_quote", "value": "这是原文口播正文"})
        plan = normalize_script.compact_plan({"topic": "固定", "shots": [copy.deepcopy(item)]}, "固定")
        result = script_organize.organize(plan, self.path, {"project_info": {"语言": "中文", "巧合": "原文", "画幅": "16:9"},
                                                           "shots": [item]})
        meta = result["shots"][0]["script_meta"]
        expected = ["title", "voice_text", "subtitle", "card_content", "card_hint", "module_label",
                    "duration", "visual_description", "shot_size", "camera_move", "camera_angle",
                    "transition", "search_keywords", "material_requirements", "material_source", "notes"]
        self.assertEqual(expected, meta["review"]["ai_suggested"])
        self.assertEqual({
            "subtitle": "script", "material_source": "script", "voice_text": "script",
            "shot_size": "script", "camera_move": "script", "camera_angle": "script",
            "transition": "script", "title": "script", "module_label": "ai", "duration": "ai",
            "visual_description": "ai", "search_keywords": "ai", "material_requirements": "ai",
            "notes": "ai", "card_content": "default", "card_hint": "default",
        }, meta["field_origin"])
        self.assertEqual({"语言": "中文"}, result["script_source"]["project_info"])
        self.assertEqual({"shots": 1, "warnings": 0, "shots_with_ai_suggested": 1},
                         result["script_source"]["import_summary"])

        old_prompt = subprocess.run(["git", "show", "09aa088:VideoAutoCut/tools/prompts/script_parse.md"],
                                    cwd=ROOT, check=True, capture_output=True, text=True, encoding="utf-8").stdout
        new_prompt = (TOOLS / "prompts" / "script_parse.md").read_text(encoding="utf-8")
        def protected_rules(text):
            return text[text.index("14. 严格区分"):text.index("16. 只输出")]
        self.assertEqual(protected_rules(old_prompt), protected_rules(new_prompt))

        fake = raw_shot(voice_text="模型伪称原文口播", voice_source={"source": "document_quote", "value": "模型伪称原文口播"})
        fake_result = self.organize(fake)["shots"][0]["script_meta"]
        self.assertEqual("ai", fake_result["field_origin"]["voice_text"])
        self.assertIn("voice_quote_unverified", [w["code"] for w in fake_result["review"]["warnings"]])

    def test_o7_docx_reads_chinese_and_table_paragraphs(self):
        docx = Path(self.temp.name, "sample.docx")
        xml = ('<?xml version="1.0" encoding="UTF-8"?>'
               '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
               '<w:p><w:r><w:t>中文正文</w:t></w:r></w:p><w:tbl><w:tr><w:tc>'
               '<w:p><w:r><w:t>镜头推近</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>')
        with zipfile.ZipFile(docx, "w") as archive:
            archive.writestr("word/document.xml", xml.encode("utf-8"))
        self.assertEqual("中文正文\n镜头推近", script_organize._read_docx_text(docx))

        item = raw_shot(card_content="镜头推近")
        plan = normalize_script.compact_plan({"topic": "固定", "shots": [copy.deepcopy(item)]}, "固定")
        shot = script_organize.organize(plan, docx, {"shots": [item]})["shots"][0]
        self.assertEqual("镜头推近", shot["card_content"])
        self.assertEqual("script", shot["script_meta"]["field_origin"]["card_content"])

    def test_o8_organizer_adds_no_model_or_network_calls(self):
        old_source = subprocess.run(["git", "show", "a29d74f:VideoAutoCut/tools/normalize_script.py"],
                                    cwd=ROOT, check=True, capture_output=True, text=True, encoding="utf-8").stdout
        old_schema_source = subprocess.run(["git", "show", "a29d74f:VideoAutoCut/tools/shot_plan_schema.py"],
                                           cwd=ROOT, check=True, capture_output=True, text=True, encoding="utf-8").stdout
        old_schema = types.ModuleType("schema_a29_o8")
        exec(compile(old_schema_source, "schema_a29_o8.py", "exec"), old_schema.__dict__)
        old = types.ModuleType("normalize_a29_o8")
        old.__file__ = "normalize_a29_o8.py"
        exec(compile(old_source, old.__file__, "exec"), old.__dict__)
        old.normalize_shot_plan = old_schema.normalize_shot_plan

        for needs_review in (False, True):
            raw = raw_shot(subtitle="" if needs_review else "原文字幕", module_label="固定章节")
            reviewed = raw_shot(subtitle="原文字幕", module_label="固定章节")
            counts = []
            for module, schema in ((old, old_schema), (normalize_script, shot_plan_schema)):
                output = Path(self.temp.name, f"o8-{needs_review}-{len(counts)}.json")
                argv = ["normalize_script.py", "--input", str(self.path), "--output", str(output), "--topic", "固定"]
                upload = mock.Mock(return_value="fixed-file")
                parse = mock.Mock(return_value={"topic": "固定", "shots": [copy.deepcopy(raw)]})
                voice_review = mock.Mock(return_value={"topic": "固定", "shots": [copy.deepcopy(reviewed)]})
                progress = mock.Mock(return_value={"labels": []})
                with mock.patch.object(sys, "argv", argv), mock.patch.object(schema.uuid, "uuid4", return_value=uuid.UUID(int=1)), \
                     mock.patch.object(module, "upload_script_file", upload), \
                     mock.patch.object(module, "normalize_with_ai", parse), \
                     mock.patch.object(module, "review_voice_and_subtitles_with_ai", voice_review), \
                     mock.patch.object(module, "review_progress_labels_with_ai", progress), \
                     mock.patch.object(module, "verify_card_fields", return_value={}):
                    module.main()
                counts.append((upload.call_count, parse.call_count, voice_review.call_count, progress.call_count))
            expected_review = 0
            self.assertEqual((1, 1, int(needs_review), 0), counts[0])
            self.assertEqual((1, 1, expected_review, 0), counts[1])

    def test_f1_voice_present_subtitle_empty_does_not_review(self):
        plan = normalize_script.compact_plan(
            {"topic": "固定", "shots": [raw_shot(subtitle="")]}, "固定")
        self.assertFalse(normalize_script.should_review_voice_and_subtitles(plan))
        plan["shots"][0].pop("voice_text")
        self.assertTrue(normalize_script.should_review_voice_and_subtitles(plan))

    def test_f2_review_only_replaces_voice_fields(self):
        initial = raw_shot(subtitle="原文字幕", card_content="原文卡片", shot_size="近景")
        reviewed = raw_shot(voice_text="复核口播正文", voiceover=True,
                            voice_source={"source": "generated_from_document"},
                            voice_requirements="复核要求", subtitle="复核字幕",
                            card_content="复核卡片", shot_size="特写", evidence={})
        merged = normalize_script.merge_reviewed_voice_fields(
            {"topic": "初次", "shots": [initial]}, {"topic": "复核", "shots": [reviewed]})
        shot = merged["shots"][0]
        self.assertEqual("复核口播正文", shot["voice_text"])
        self.assertEqual("复核要求", shot["voice_requirements"])
        self.assertEqual("原文字幕", shot["subtitle"])
        self.assertEqual("原文卡片", shot["card_content"])
        self.assertEqual("近景", shot["shot_size"])
        self.assertEqual(initial["evidence"], shot["evidence"])

    def test_f3_voice_source_without_value_is_undeclared_and_organizer_verifies(self):
        quoted = raw_shot(voice_source={"source": "document_quote"})
        compact = normalize_script.compact_plan({"topic": "固定", "shots": [quoted]}, "固定")
        self.assertEqual("这是原文口播正文", compact["shots"][0]["voice_text"])
        result = script_organize.organize(compact, self.path, {"shots": [quoted]})
        meta = result["shots"][0]["script_meta"]
        self.assertEqual("script", meta["field_origin"]["voice_text"])
        self.assertNotIn("voice_quote_unverified", [w["code"] for w in meta["review"]["warnings"]])

        unquoted = raw_shot(voice_text="模型生成口播", voice_source={"source": "document_quote"})
        compact = normalize_script.compact_plan({"topic": "固定", "shots": [unquoted]}, "固定")
        result = script_organize.organize(compact, self.path, {"shots": [unquoted]})
        meta = result["shots"][0]["script_meta"]
        self.assertEqual("ai", meta["field_origin"]["voice_text"])
        self.assertIn("voice_quote_unverified", [w["code"] for w in meta["review"]["warnings"]])

    def test_f4_subtitle_equal_to_card_is_cleared_but_empty_values_do_not_warn(self):
        item = raw_shot(subtitle="原文字幕", card_content="原文字幕")
        result = self.organize(item)["shots"][0]
        self.assertNotIn("subtitle", result)
        self.assertIn("subtitle_is_card", [w["code"] for w in result["script_meta"]["review"]["warnings"]])

        empty = self.organize(raw_shot(subtitle="", card_content="", card_hint=""))["shots"][0]
        self.assertNotIn("subtitle_is_card", [w["code"] for w in empty["script_meta"]["review"]["warnings"]])

        hint = self.organize(raw_shot(subtitle="强调样式", card_content="", card_hint="强调样式"))["shots"][0]
        self.assertNotIn("subtitle", hint)
        self.assertNotIn("card_hint", hint)
        self.assertIn("card_not_in_script", [w["code"] for w in hint["script_meta"]["review"]["warnings"]])
        self.assertIn("subtitle_not_in_script", [w["code"] for w in hint["script_meta"]["review"]["warnings"]])

        for subtitle in ("原文字幕 ", "原文字幕。"):
            with self.subTest(strict_non_match=subtitle):
                raw = raw_shot(subtitle="原文字幕", card_content="原文字幕")
                plan = normalize_script.compact_plan({"topic": "固定", "shots": [raw]}, "固定")
                plan["shots"][0]["subtitle"] = subtitle
                different = script_organize.organize(plan, self.path, {"shots": [raw]})["shots"][0]
                self.assertNotIn("subtitle_is_card",
                                 [w["code"] for w in different["script_meta"]["review"]["warnings"]])

    def test_card_voice_mode_requires_exact_labeled_value(self):
        confirmed = Path(self.temp.name, "confirmed.txt")
        confirmed.write_text(
            "普通口播里提到原文上屏，但不是标签。\n上屏：明确上屏\n上屏文字：另一条上屏\n卡片提示：参数列表\n", encoding="utf-8")
        item = raw_shot(card_content="普通口播里提到原文上屏", card_hint="模型提示")
        plan = normalize_script.compact_plan({"topic": "固定", "shots": [copy.deepcopy(item)]}, "固定")
        shot = script_organize.organize(
            plan, self.path, {"shots": [item]}, evidence_path=confirmed, voice_mode=True)["shots"][0]
        self.assertNotIn("card_content", shot)
        self.assertNotIn("card_hint", shot)
        self.assertEqual(("default", "default"),
                         (shot["script_meta"]["field_origin"]["card_content"],
                          shot["script_meta"]["field_origin"]["card_hint"]))
        self.assertEqual(["card_not_in_script", "card_not_in_script"],
                         [w["code"] for w in shot["script_meta"]["review"]["warnings"]
                          if w["field"] in {"card_content", "card_hint"}])

        kept = raw_shot(card_content="明确上屏", card_hint="参数列表")
        plan = normalize_script.compact_plan({"topic": "固定", "shots": [copy.deepcopy(kept)]}, "固定")
        shot = script_organize.organize(
            plan, self.path, {"shots": [kept]}, evidence_path=confirmed, voice_mode=True)["shots"][0]
        self.assertEqual(("明确上屏", "参数列表"), (shot["card_content"], shot["card_hint"]))
        self.assertEqual(("script", "script"),
                         (shot["script_meta"]["field_origin"]["card_content"],
                          shot["script_meta"]["field_origin"]["card_hint"]))

        kept_alias = raw_shot(card_content="另一条上屏", card_hint="")
        plan = normalize_script.compact_plan({"topic": "固定", "shots": [copy.deepcopy(kept_alias)]}, "固定")
        shot = script_organize.organize(
            plan, self.path, {"shots": [kept_alias]}, evidence_path=confirmed, voice_mode=True)["shots"][0]
        self.assertEqual("另一条上屏", shot["card_content"])
        self.assertEqual("script", shot["script_meta"]["field_origin"]["card_content"])

        for name, card_content in (("substring", "明确"),
                                   ("internal_whitespace", "明确 上屏"),
                                   ("wrong_field_label", "参数列表")):
            with self.subTest(name=name):
                item = raw_shot(card_content=card_content)
                plan = normalize_script.compact_plan(
                    {"topic": "固定", "shots": [copy.deepcopy(item)]}, "固定")
                shot = script_organize.organize(
                    plan, self.path, {"shots": [item]},
                    evidence_path=confirmed, voice_mode=True)["shots"][0]
                self.assertNotIn("card_content", shot)
                self.assertEqual("default", shot["script_meta"]["field_origin"]["card_content"])
                self.assertIn("card_not_in_script",
                              [w["code"] for w in shot["script_meta"]["review"]["warnings"]])

    def test_voice_main_passes_explicit_voice_mode_to_organizer(self):
        confirmed = Path(self.temp.name, "confirmed-main.txt")
        confirmed.write_text("这是原文口播正文", encoding="utf-8")
        output = Path(self.temp.name, "voice-main.json")
        raw = {"topic": "固定", "shots": [raw_shot(subtitle="", card_content="", card_hint="")]}
        organize = mock.Mock(side_effect=script_organize.organize)
        argv = ["normalize_script.py", "--input", str(self.path), "--output", str(output),
                "--topic", "固定", "--voice-script-body", str(confirmed)]
        with mock.patch.object(sys, "argv", argv), \
             mock.patch.object(normalize_script, "normalize_voice_script_with_ai",
                               return_value=copy.deepcopy(raw)), \
             mock.patch.object(normalize_script, "verify_card_fields", return_value={}), \
             mock.patch.object(normalize_script.script_organize, "organize", organize), \
             mock.patch.object(normalize_script.script_voice, "apply", side_effect=lambda plan, *_args, **_kwargs: plan), \
             mock.patch.object(normalize_script, "ensure_progress_labels", side_effect=lambda plan, **_kwargs: plan):
            normalize_script.main()
        self.assertTrue(organize.call_args.kwargs["voice_mode"])

    def test_card_ordinary_excerpt_and_unverifiable_origins(self):
        source = Path(self.temp.name, "prose.txt")
        source.write_text("散文里连续写了明确上屏。", encoding="utf-8")
        item = raw_shot(card_content="明确上屏", card_hint="模型提示")
        plan = normalize_script.compact_plan({"topic": "固定", "shots": [copy.deepcopy(item)]}, "固定")
        shot = script_organize.organize(plan, source, {"shots": [item]})["shots"][0]
        self.assertEqual("明确上屏", shot["card_content"])
        self.assertNotIn("card_hint", shot)
        self.assertEqual(("script", "default"),
                         (shot["script_meta"]["field_origin"]["card_content"],
                          shot["script_meta"]["field_origin"]["card_hint"]))
        self.assertIn("card_not_in_script", [w["code"] for w in shot["script_meta"]["review"]["warnings"]])

        opaque = Path(self.temp.name, "opaque.pdf")
        opaque.write_bytes(b"pdf")
        item = raw_shot(card_content="保留上屏", card_hint="保留提示")
        plan = normalize_script.compact_plan({"topic": "固定", "shots": [copy.deepcopy(item)]}, "固定")
        shot = script_organize.organize(plan, opaque, {"shots": [item]})["shots"][0]
        self.assertEqual(("保留上屏", "保留提示"), (shot["card_content"], shot["card_hint"]))
        self.assertEqual(("ai", "ai"),
                         (shot["script_meta"]["field_origin"]["card_content"],
                          shot["script_meta"]["field_origin"]["card_hint"]))

    def test_card_real_voice_failure_fixture_clears_shots_ten_and_eleven(self):
        root = Path(__file__).with_name("fixtures") / "voice-card-51505407"
        imported = json.loads((root / "before-edit-shots.json").read_text(encoding="utf-8"))
        confirmed = root / "confirmed-body.txt"
        self.assertEqual(("箱子的尺寸和重量、每小时要码多少箱、托盘规格，还有目标垛型", "把你的箱型和垛型发过来",
                          "提供信息获取定制方案"),
                         (imported["shots"][9]["card_content"], imported["shots"][10]["card_content"],
                          imported["shots"][10]["card_hint"]))
        plan = copy.deepcopy(imported)
        plan.pop("script_source", None)
        for shot in plan["shots"]:
            shot.pop("script_meta", None)
        result = script_organize.organize(
            plan, confirmed, {"shots": copy.deepcopy(plan["shots"])},
            evidence_path=confirmed, voice_mode=True)
        for index in (9, 10):
            shot = result["shots"][index]
            self.assertNotIn("card_content", shot)
            self.assertEqual("default", shot["script_meta"]["field_origin"]["card_content"])
            self.assertIn("card_not_in_script", [w["code"] for w in shot["script_meta"]["review"]["warnings"]])
        self.assertNotIn("card_hint", result["shots"][10])
        self.assertEqual("default", result["shots"][10]["script_meta"]["field_origin"]["card_hint"])

    def test_f1_f2_offline_replay_three_diagnostic_runs(self):
        fixture_root = Path(__file__).with_name("fixtures") / "prose-review-51502926"
        source = ROOT / "docs" / "script-template-v1" / "示例_食品码垛_散文.md"
        for run in range(1, 4):
            with self.subTest(run=run):
                first = json.loads((fixture_root / f"run-{run}-01-first-parse-raw.json").read_text(encoding="utf-8"))
                reviewed = json.loads((fixture_root / f"run-{run}-02-review-raw.json").read_text(encoding="utf-8"))
                merged = normalize_script.merge_reviewed_voice_fields(first, reviewed)
                plan = normalize_script.compact_plan(merged, "食品码垛")
                script_card_fields.verify_and_fix(plan, source)
                result = script_organize.organize(plan, source, merged)
                shots = result["shots"]
                self.assertEqual(("特写", "script"),
                                 (shots[2]["script_meta"]["shot_size"],
                                  shots[2]["script_meta"]["field_origin"]["shot_size"]))
                self.assertEqual(9, sum(bool(s.get("voice_text")) for s in shots))
                self.assertEqual(0, sum(bool(s.get("subtitle")) for s in shots))
                self.assertEqual([4], [index for index, s in enumerate(shots, 1) if s.get("card_content")])

    def test_f1_offline_replay_runs_real_main_before_and_after(self):
        fixture_root = Path(__file__).with_name("fixtures") / "prose-review-51502926"
        source = ROOT / "docs" / "script-template-v1" / "示例_食品码垛_散文.md"
        archive = subprocess.run(
            ["git", "archive", "0f9cc402", "VideoAutoCut/tools"], cwd=ROOT,
            check=True, capture_output=True).stdout
        baseline_root = Path(self.temp.name, "baseline")
        baseline_root.mkdir()
        with tarfile.open(fileobj=io.BytesIO(archive)) as bundle:
            bundle.extractall(baseline_root)
        probe = r'''
import contextlib, copy, io, json, sys
from pathlib import Path
from unittest import mock
sys.path.insert(0, sys.argv[1])
import normalize_script
first = json.loads(Path(sys.argv[3]).read_text(encoding="utf-8"))
reviewed = json.loads(Path(sys.argv[4]).read_text(encoding="utf-8"))
output = Path(sys.argv[5])
parse = mock.Mock(return_value=copy.deepcopy(first))
review = mock.Mock(return_value=copy.deepcopy(reviewed))
stdout = io.StringIO()
argv = ["normalize_script.py", "--input", sys.argv[2], "--output", str(output), "--topic", "食品码垛"]
with mock.patch.object(sys, "argv", argv), \
     mock.patch.object(normalize_script, "upload_script_file", return_value="fixed-file"), \
     mock.patch.object(normalize_script, "normalize_with_ai", parse), \
     mock.patch.object(normalize_script, "review_voice_and_subtitles_with_ai", review), \
     mock.patch.object(normalize_script, "review_progress_labels_with_ai", return_value={"labels": []}), \
     contextlib.redirect_stdout(stdout):
    normalize_script.main()
print(json.dumps({"parse_calls": parse.call_count, "review_calls": review.call_count,
                  "stdout": stdout.getvalue()}, ensure_ascii=False))
'''
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", PYTHONIOENCODING="utf-8")
        for run in range(1, 4):
            first = fixture_root / f"run-{run}-01-first-parse-raw.json"
            reviewed = fixture_root / f"run-{run}-02-review-raw.json"
            results = []
            for label, tool_root in (("before", baseline_root / "VideoAutoCut" / "tools"),
                                     ("after", TOOLS)):
                output = Path(self.temp.name, f"main-{run}-{label}.json")
                completed = subprocess.run(
                    [sys.executable, "-B", "-X", "utf8", "-c", probe, str(tool_root),
                     str(source), str(first), str(reviewed), str(output)],
                    cwd=self.temp.name, env=env, check=True, capture_output=True, text=True,
                    encoding="utf-8")
                results.append((json.loads(output.read_text(encoding="utf-8")),
                                json.loads(completed.stdout)))
            before, after = results
            self.assertEqual(1, before[1]["review_calls"])
            self.assertEqual(0, after[1]["review_calls"])
            shots = after[0]["shots"]
            self.assertEqual(("特写", "script"),
                             (shots[2]["script_meta"]["shot_size"],
                              shots[2]["script_meta"]["field_origin"]["shot_size"]))
            self.assertEqual((9, 0, [4]),
                             (sum(bool(s.get("voice_text")) for s in shots),
                              sum(bool(s.get("subtitle")) for s in shots),
                              [i for i, s in enumerate(shots, 1) if s.get("card_content")]))

    def test_f2_real_main_reviews_empty_voice_and_preserves_initial_non_voice_fields(self):
        first = {"topic": "固定", "shots": [raw_shot(
            voice_text="", voiceover=False, subtitle="原文字幕", card_content="原文卡片",
            shot_size="近景")]}
        reviewed = {"topic": "复核", "shots": [raw_shot(
            voice_text="复核口播正文", voiceover=True,
            voice_source={"source": "generated_from_document"}, voice_requirements="复核要求",
            subtitle="复核字幕", card_content="复核卡片", shot_size="特写", evidence={})]}
        output = Path(self.temp.name, "f2-main.json")
        review = mock.Mock(return_value=copy.deepcopy(reviewed))
        argv = ["normalize_script.py", "--input", str(self.path), "--output", str(output), "--topic", "固定"]
        with mock.patch.object(sys, "argv", argv), \
             mock.patch.object(normalize_script, "upload_script_file", return_value="fixed-file"), \
             mock.patch.object(normalize_script, "normalize_with_ai", return_value=copy.deepcopy(first)), \
             mock.patch.object(normalize_script, "review_voice_and_subtitles_with_ai", review), \
             mock.patch.object(normalize_script, "review_progress_labels_with_ai", return_value={"labels": []}), \
             mock.patch.object(normalize_script, "verify_card_fields", return_value={}):
            normalize_script.main()
        self.assertEqual(1, review.call_count)
        shot = json.loads(output.read_text(encoding="utf-8"))["shots"][0]
        self.assertEqual("复核口播正文", shot["voice_text"])
        self.assertEqual("复核要求", shot["voice_requirements"])
        self.assertEqual("原文字幕", shot["subtitle"])
        self.assertNotIn("card_content", shot)
        self.assertIn("card_not_in_script", [w["code"] for w in shot["script_meta"]["review"]["warnings"]])
        self.assertEqual("近景", shot["script_meta"]["shot_size"])

    def test_f2_shot_count_mismatch_uses_review_plan_and_fails_closed(self):
        initial = {"topic": "固定", "shots": [raw_shot()]}
        reviewed = {"topic": "固定", "shots": [raw_shot(), raw_shot(title="第二镜")]}
        merged = normalize_script.merge_reviewed_voice_fields(initial, reviewed)
        self.assertIs(merged, reviewed)
        plan = normalize_script.compact_plan(merged, "固定")
        result = script_organize.organize(plan, self.path, merged, force_shot_mismatch=True)
        self.assertEqual(2, len(result["shots"]))
        for shot in result["shots"]:
            meta = shot["script_meta"]
            self.assertEqual("不限", meta["shot_size"])
            self.assertEqual("", meta["material_source"])
            self.assertIn("organize_shot_mismatch", [w["code"] for w in meta["review"]["warnings"]])

        reviewed_quote = {"topic": "固定", "shots": [raw_shot(
            voice_text="伪称原文口播", voice_source={"source": "document_quote"})]}
        plan = normalize_script.compact_plan(reviewed_quote, "固定")
        result = script_organize.organize(
            plan, self.path, reviewed_quote, force_shot_mismatch=True)
        meta = result["shots"][0]["script_meta"]
        self.assertEqual("ai", meta["field_origin"]["voice_text"])
        self.assertIn("voice_quote_unverified", [w["code"] for w in meta["review"]["warnings"]])
        self.assertIn("organize_shot_mismatch", [w["code"] for w in meta["review"]["warnings"]])

        # The raw counts still govern the mismatch even if compact_plan drops
        # an invalid review item and the normalized count happens to match.
        reviewed_with_invalid = {"topic": "固定", "shots": [raw_shot(), "invalid"]}
        merged = normalize_script.merge_reviewed_voice_fields(initial, reviewed_with_invalid)
        plan = normalize_script.compact_plan(merged, "固定")
        self.assertEqual(1, len(plan["shots"]))
        result = script_organize.organize(plan, self.path, merged, force_shot_mismatch=True)
        meta = result["shots"][0]["script_meta"]
        self.assertEqual("不限", meta["shot_size"])
        self.assertIn("organize_shot_mismatch", [w["code"] for w in meta["review"]["warnings"]])

        initial_with_invalid = {"topic": "固定", "shots": [raw_shot(), "invalid"]}
        reviewed_valid = {"topic": "固定", "shots": [raw_shot(), raw_shot(title="第二镜")]}
        self.assertFalse(normalize_script.review_shot_counts_match(initial_with_invalid, reviewed_valid))
        self.assertIs(normalize_script.merge_reviewed_voice_fields(initial_with_invalid, reviewed_valid),
                      reviewed_valid)

    def test_review_fix_raw_plan_count_mismatch_fails_closed_per_shot(self):
        first, second = raw_shot(), raw_shot(title="第二镜")
        plan = normalize_script.compact_plan({"topic": "固定", "shots": [copy.deepcopy(first)]}, "固定")
        result = script_organize.organize(plan, self.path, {"shots": [first, second]})
        meta = result["shots"][0]["script_meta"]
        self.assertEqual(("不限", "不限", "不限", ""),
                         tuple(meta[field] for field in script_organize.CAMERA_FIELDS))
        self.assertEqual("", meta["material_source"])
        self.assertEqual(1, sum(w["code"] == "organize_shot_mismatch"
                                for w in meta["review"]["warnings"]))

    def test_review_fix_syncs_replaced_nonempty_label_and_summary(self):
        result = self.organize(raw_shot(module_label="Introduction"))
        shot = result["shots"][0]
        original = [shot["module_label"]]
        shot["module_label"] = "标题"
        before = result["script_source"]["import_summary"]["warnings"]
        script_organize.sync_progress_labels(result, original)
        self.assertEqual("标题", shot["script_meta"]["segment"])
        self.assertEqual(1, sum(w["code"] == "module_label_replaced"
                                for w in shot["script_meta"]["review"]["warnings"]))
        self.assertEqual(before + 1, result["script_source"]["import_summary"]["warnings"])

    def test_review_fix_syncs_empty_label_fallback_without_warning(self):
        result = self.organize(raw_shot(module_label=""))
        shot = result["shots"][0]
        original = [shot.get("module_label")]
        before = result["script_source"]["import_summary"]["warnings"]
        shot["module_label"] = shot["title"]
        script_organize.sync_progress_labels(result, original)
        self.assertEqual(shot["title"], shot["script_meta"]["segment"])
        self.assertNotIn("module_label_replaced",
                         [w["code"] for w in shot["script_meta"]["review"]["warnings"]])
        self.assertEqual(before, result["script_source"]["import_summary"]["warnings"])

    def test_review_fix_fd3_full_main_diff_is_only_authorized_segment_path(self):
        old_organize_source = subprocess.run(
            ["git", "show", "fd3f1e2:VideoAutoCut/tools/script_organize.py"], cwd=ROOT,
            check=True, capture_output=True, text=True, encoding="utf-8").stdout
        old_main_source = subprocess.run(
            ["git", "show", "fd3f1e2:VideoAutoCut/tools/normalize_script.py"], cwd=ROOT,
            check=True, capture_output=True, text=True, encoding="utf-8").stdout
        old_organize = types.ModuleType("script_organize_fd3")
        exec(compile(old_organize_source, "script_organize_fd3.py", "exec"), old_organize.__dict__)
        with mock.patch.dict(sys.modules, {"script_organize": old_organize}):
            old_main = types.ModuleType("normalize_script_fd3")
            old_main.__file__ = "normalize_script_fd3.py"
            exec(compile(old_main_source, old_main.__file__, "exec"), old_main.__dict__)

        directory = Path(self.temp.name)
        input_path = directory / "fd3-plain.txt"
        input_path.write_text("原文", encoding="utf-8")
        for label in ("", "Introduction"):
            with self.subTest(original_label=label or "empty"):
                raw_shot_value = {
                    "shot": 1, "title": "标题", "module_label": label, "duration": 2,
                    "visual_query": "画面", "download_query": "检索", "voice_text": "中文口播正文",
                    "subtitle": "中文口播正文", "voiceover": True,
                }
                raw = {"topic": "固定", "shots": [raw_shot_value]}
                results = []
                for module in (old_main, normalize_script):
                    output = directory / f"fd3-{bool(label)}.json"
                    stdout = io.StringIO()
                    argv = ["normalize_script.py", "--input", str(input_path), "--output", str(output),
                            "--topic", "固定"]
                    with contextlib.ExitStack() as stack:
                        stack.enter_context(mock.patch.object(sys, "argv", argv))
                        stack.enter_context(mock.patch.object(shot_plan_schema.uuid, "uuid4", return_value=uuid.UUID(int=1)))
                        stack.enter_context(mock.patch.object(module, "upload_script_file", return_value="fixed-file"))
                        stack.enter_context(mock.patch.object(module, "normalize_with_ai", return_value=copy.deepcopy(raw)))
                        stack.enter_context(mock.patch.object(module, "review_voice_and_subtitles_with_ai",
                                                               return_value=copy.deepcopy(raw)))
                        stack.enter_context(mock.patch.object(module, "review_progress_labels_with_ai",
                                                               return_value={"labels": []}))
                        stack.enter_context(mock.patch.object(module, "verify_card_fields", return_value={}))
                        stack.enter_context(contextlib.redirect_stdout(stdout))
                        module.main()
                    results.append((json.loads(output.read_text(encoding="utf-8")), stdout.getvalue().splitlines()))

                baseline, candidate = results[0][0], results[1][0]
                baseline_meta = baseline["shots"][0]["script_meta"]
                candidate_meta = candidate["shots"][0]["script_meta"]
                self.assertEqual(label, baseline_meta["segment"])
                self.assertEqual("标题", candidate_meta["segment"])
                candidate_meta["segment"] = label
                if label:
                    added = [item for item in candidate_meta["review"]["warnings"]
                             if item.get("code") == "module_label_replaced"]
                    self.assertEqual(1, len(added))
                    candidate_meta["review"]["warnings"].remove(added[0])
                    self.assertEqual(baseline["script_source"]["import_summary"]["warnings"] + 1,
                                     candidate["script_source"]["import_summary"]["warnings"])
                    candidate["script_source"]["import_summary"]["warnings"] -= 1
                self.assertEqual(baseline, candidate)
                self.assertEqual(results[0][1], results[1][1])


if __name__ == "__main__":
    unittest.main()
