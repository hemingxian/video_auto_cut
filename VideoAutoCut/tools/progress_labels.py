"""Choose chapter labels in the language of the displayed/spoken script."""
from __future__ import annotations

import re

from common import clean_label


def text_language(text: str) -> str:
    han = len(re.findall(r"[\u3400-\u9fff]", text or ""))
    words = len(re.findall(r"[A-Za-z]+(?:['’-][A-Za-z]+)*", text or ""))
    if han and han >= words:
        return "zh"
    if words:
        return "en"
    return ""


def shot_script_text(shot: dict) -> str:
    return str(shot.get("subtitle") or shot.get("voice_text") or "").strip()


def label_matches_language(label: str, language: str, context: str = "") -> bool:
    if not label.strip():
        return False
    if not language:
        return True
    if language == "zh":
        if re.search(r"[\u3400-\u9fff]", label):
            return True
        # Keep an actual acronym/product identifier from the script. A Chinese
        # chapter may correctly be called FANUC or CRX-10iA; do not strip it.
        return bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/+\-]*", label)
                    and label in context and (label.isupper() or any(c.isdigit() for c in label)))
    return bool(re.search(r"[A-Za-z]", label) and not re.search(r"[\u3400-\u9fff]", label))


def progress_label_choices(shots: list[dict]) -> list[dict]:
    overall = text_language(" ".join(shot_script_text(shot) for shot in shots))
    choices = []
    for index, shot in enumerate(shots, 1):
        context = shot_script_text(shot)
        language = text_language(context) or overall
        candidates = [clean_label(str(shot.get(field) or ""), index) if shot.get(field) else ""
                      for field in ("module_label", "title")]
        label = next((candidate for candidate in candidates if label_matches_language(candidate, language, context)), "")
        needs_review = not label
        if not label:
            # Offline/old-plan fallback uses a complete original clause. It is
            # neither an invented translation nor an arbitrary character cut.
            clauses = re.split(r"(?<=[。！？!?；;])\s*|[，,]\s*", context)
            label = next((clause.strip() for clause in clauses
                          if label_matches_language(clause, language, context)), "")
        if not label:
            label = f"Chapter {index}" if language == "en" else f"章节{index}"
        choices.append({"shot": index, "module_label": label, "language": language,
                        "context": context, "needs_review": needs_review})
    return choices


def progress_labels_for_shots(shots: list[dict]) -> list[str]:
    return [choice["module_label"] for choice in progress_label_choices(shots)]


def ensure_progress_labels(plan: dict, reviewer=None) -> dict:
    shots = plan.get("shots") or []
    choices = progress_label_choices(shots)
    pending = [choice for choice in choices if choice["needs_review"] and choice["context"] and choice["language"]]
    for _ in range(2 if reviewer else 0):
        if not pending:
            break
        try:
            reviewed = reviewer(pending)
            rows = reviewed.get("labels", []) if isinstance(reviewed, dict) else []
            by_shot = {row.get("shot"): row for row in rows if isinstance(row, dict)}
            remaining = []
            for choice in pending:
                candidate = str(by_shot.get(choice["shot"], {}).get("module_label") or "").strip()
                if label_matches_language(candidate, choice["language"], choice["context"]):
                    choice["module_label"] = candidate
                else:
                    remaining.append(choice)
            pending = remaining
        except Exception as exc:
            print(f"[警告] 章节标签复核失败，使用脚本原文标签: {exc}")
            break
    if pending and reviewer:
        print("[警告] 部分章节标签未通过语言复核，使用对应语言的脚本原文标签")
    for shot, choice in zip(shots, choices):
        shot["module_label"] = choice["module_label"]
    return plan
