import importlib.util
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("audit", HERE / "ass_event_text_audit.py")
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


def event(text, start=0.0, end=1.0, line=1, y=100.0):
    return {"visible": text, "start": start, "end": end, "layer": "0", "line": line,
            "pos_y": y, "group_key": [start, end, "0"], "physical_line_index": 0,
            "physical_line_count": 1}


def check(name, actual, expected):
    if actual != expected:
        raise AssertionError(f"{name}: expected {expected!r}, got {actual!r}")
    print(f"PASS {name}")


check("terminal full stop allowed", audit.match_expected("甲。", [event("甲")])["match"], True)
check("terminal full stop unique", audit.match_expected("甲。", [event("甲")])["solution_count"], 1)
check("internal comma missing fails", audit.match_expected("甲，乙。", [event("甲乙")])["match"], False)
check("internal character change fails", audit.match_expected("甲乙。", [event("甲丙")])["match"], False)

first, second = event("甲", 0, 1, 1, 100), event("乙", 0, 1, 2, 200)
first["physical_line_count"] = second["physical_line_count"] = 2
first["physical_line_index"], second["physical_line_index"] = 0, 1
check("physical soft seam two spaces fails", audit.match_expected("甲  乙", [first, second])["match"], False)

ordered, groups, errors = audit.order_and_group([event("甲", 0, 2, 1), event("乙", 1, 3, 2)])
check("unequal overlap rejected", bool(errors), True)
