#!/usr/bin/env python3
"""Capture B5 Chroma/Click failures without changing the tested modules."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import sys
import traceback
import unittest
from unittest import mock


TARGETS = {
    "test_analysis_cache.ContentAnalysisTests.test_real_chroma_alias_queries_remain_strictly_scoped",
    "test_analysis_cache.ContentAnalysisTests.test_real_cli_index_export_import_and_cloud_reuse",
}


def module_facts(module) -> dict:
    return {
        "repr": repr(module),
        "type": type(module).__name__ if module is not None else None,
        "file": getattr(module, "__file__", None) if module is not None else None,
        "has_persistent_client": hasattr(module, "PersistentClient") if module is not None else False,
    }


def cases(suite):
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            yield from cases(item)
        else:
            yield item


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source_root")
    parser.add_argument("mode", choices=("mixed", "isolated"))
    parser.add_argument("output_json")
    args = parser.parse_args()

    root = Path(args.source_root).resolve()
    output = Path(args.output_json).resolve()
    sys.path[:0] = [str(root / "tests"), str(root), str(root / "sentrysearch")]
    os.chdir(root)

    spec = importlib.util.find_spec("chromadb")
    evidence = {
        "mode": args.mode,
        "python": sys.executable,
        "source_root": str(root),
        "chromadb_spec_origin": getattr(spec, "origin", None),
        "chromadb_before_discovery": module_facts(sys.modules.get("chromadb")),
    }

    loader = unittest.TestLoader()
    pattern = "test_*.py" if args.mode == "mixed" else "test_analysis_cache.py"
    discovered = loader.discover("tests", pattern=pattern)
    all_cases = list(cases(discovered))
    evidence["discovered_case_count"] = len(all_cases)
    evidence["loader_errors"] = list(loader.errors)
    evidence["chromadb_after_discovery"] = module_facts(sys.modules.get("chromadb"))

    diagnostic_errors = []
    if args.mode == "mixed":
        selected = [case for case in all_cases if case.id() in TARGETS]
        selected_ids = {case.id() for case in selected}
        missing = TARGETS - selected_ids
        if missing:
            diagnostic_errors.append(f"target tests were not discovered: {sorted(missing)}")
    else:
        selected = all_cases
    evidence["selected_ids"] = [case.id() for case in selected]
    if loader.errors:
        diagnostic_errors.append(f"test discovery reported {len(loader.errors)} loader error(s)")

    from click.testing import CliRunner

    captures = []
    original_invoke = CliRunner.invoke

    def invoke_with_evidence(self, cli, *invoke_args, **invoke_kwargs):
        result = original_invoke(self, cli, *invoke_args, **invoke_kwargs)
        error = result.exception
        record = {
            "args": repr(invoke_args[0] if invoke_args else invoke_kwargs.get("args")),
            "exit_code": result.exit_code,
            "output": result.output,
            "exception": repr(error),
            "traceback": "" if error is None else "".join(
                traceback.format_exception(type(error), error, error.__traceback__)
            ),
        }
        captures.append(record)
        print("B5_CLI_RESULT:" + json.dumps(record, ensure_ascii=False), flush=True)
        return result

    with mock.patch.object(CliRunner, "invoke", invoke_with_evidence):
        result = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(selected))

    store_module = sys.modules.get("sentrysearch.store")
    evidence["production_store_loaded"] = store_module is not None
    evidence["production_store_chromadb"] = module_facts(
        getattr(store_module, "chromadb", None) if store_module is not None else None
    )
    evidence["cli_results"] = captures
    evidence["tests_run"] = result.testsRun
    evidence["failures"] = len(result.failures)
    evidence["errors"] = len(result.errors)
    evidence["skipped"] = len(result.skipped)
    skipped_targets = [test.id() for test, _reason in result.skipped if test.id() in TARGETS]
    evidence["skipped_target_ids"] = skipped_targets
    if skipped_targets:
        diagnostic_errors.append(f"real integration tests were skipped: {skipped_targets}")
    evidence["diagnostic_errors"] = diagnostic_errors
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
    for error in diagnostic_errors:
        print(f"B5_DIAGNOSTIC_ERROR: {error}", file=sys.stderr, flush=True)
    return 0 if result.wasSuccessful() and not diagnostic_errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
