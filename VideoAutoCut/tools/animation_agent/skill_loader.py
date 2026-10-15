from __future__ import annotations

from pathlib import Path

ENGINE_SKILLS = {"manim", "remotion", "hyperframes"}
AGENT_DIR = Path(__file__).resolve().parent
SKILLS_DIR = AGENT_DIR / "skills"
OFFICIAL_DIR = AGENT_DIR / "official"


def normalize_engine(engine: str) -> str:
    token = str(engine or "").strip().lower()
    if token not in ENGINE_SKILLS:
        raise ValueError(f"Unsupported animation engine skill: {engine}")
    return token


def _read_required(path: Path) -> str:
    if not path.exists():
        raise FileNotFoundError(f"Missing animation skill file: {path}")
    return path.read_text(encoding="utf-8")


def _section(title: str, body: str) -> str:
    return f"\n\n# {title}\n\n{body.strip()}\n"


def available_remotion_rules() -> list[str]:
    rules_dir = OFFICIAL_DIR / "remotion" / "rules"
    if not rules_dir.exists():
        return []
    return sorted(path.stem for path in rules_dir.glob("*.md"))


def _read_many(paths: list[Path]) -> str:
    parts: list[str] = []
    for path in paths:
        parts.append(_section(str(path.relative_to(AGENT_DIR)), _read_required(path)))
    return "".join(parts).strip()


def load_manim_official_skill() -> str:
    official = OFFICIAL_DIR / "manim"
    return _read_many(
        [
            official / "SOURCES.md",
            official / "tutorials" / "quickstart.rst",
            official / "tutorials" / "building_blocks.rst",
            official / "tutorials" / "output_and_config.rst",
        ]
    )


def load_remotion_official_skill(rule_names: list[str] | tuple[str, ...] | None = None) -> str:
    official = OFFICIAL_DIR / "remotion"
    parts = [
        _section("Official Remotion llms.txt", _read_required(official / "llms.txt")),
        _section("Official Remotion SKILL.md", _read_required(official / "SKILL.md")),
    ]

    seen: set[str] = set()
    for name in rule_names or []:
        token = str(name or "").strip().lower().replace("_", "-").removesuffix(".md")
        if not token or token in seen:
            continue
        seen.add(token)
        rule_path = official / "rules" / f"{token}.md"
        if not rule_path.exists():
            raise FileNotFoundError(f"Missing official Remotion rule: {rule_path}")
        parts.append(_section(f"Official Remotion Rule: {token}", _read_required(rule_path)))
    return "".join(parts).strip()


HYPERFRAMES_OPTIONAL_SECTIONS: dict[str, list[Path]] = {
    "animation-techniques": [
        OFFICIAL_DIR / "hyperframes" / "hyperframes-animation" / "techniques.md",
    ],
    "animation-rules-index": [
        OFFICIAL_DIR / "hyperframes" / "hyperframes-animation" / "rules-index.md",
    ],
    "dynamic-content-sequencing": [
        OFFICIAL_DIR / "hyperframes" / "hyperframes-animation" / "rules" / "dynamic-content-sequencing.md",
    ],
    "discrete-text-sequence": [
        OFFICIAL_DIR / "hyperframes" / "hyperframes-animation" / "rules" / "discrete-text-sequence.md",
    ],
    "gsap-effects": [
        OFFICIAL_DIR / "hyperframes" / "hyperframes-animation" / "rules" / "gsap-effects.md",
    ],
    "stat-bars-and-fills": [
        OFFICIAL_DIR / "hyperframes" / "hyperframes-animation" / "rules" / "stat-bars-and-fills.md",
    ],
    "svg-path-draw": [
        OFFICIAL_DIR / "hyperframes" / "hyperframes-animation" / "rules" / "svg-path-draw.md",
    ],
    "motion-graphics": [
        OFFICIAL_DIR / "hyperframes" / "motion-graphics" / "SKILL.md",
        OFFICIAL_DIR / "hyperframes" / "motion-graphics" / "catalog-map.md",
        OFFICIAL_DIR / "hyperframes" / "motion-graphics" / "references" / "builder-contract.md",
        OFFICIAL_DIR / "hyperframes" / "motion-graphics" / "references" / "motion-vocabulary.md",
        OFFICIAL_DIR / "hyperframes" / "motion-graphics" / "references" / "shot-plan-ir.md",
    ],
    "media": [
        OFFICIAL_DIR / "hyperframes" / "hyperframes-media" / "SKILL.md",
    ],
    "graphic-overlays": [
        OFFICIAL_DIR / "hyperframes" / "graphic-overlays" / "SKILL.md",
    ],
    "embedded-captions": [
        OFFICIAL_DIR / "hyperframes" / "embedded-captions" / "SKILL.md",
    ],
    "general-video": [
        OFFICIAL_DIR / "hyperframes" / "general-video" / "SKILL.md",
    ],
}


def available_hyperframes_sections() -> list[str]:
    return sorted(HYPERFRAMES_OPTIONAL_SECTIONS)


def load_hyperframes_official_skill(section_names: list[str] | tuple[str, ...] | None = None) -> str:
    official = OFFICIAL_DIR / "hyperframes"
    paths = [
        official / "SOURCES.md",
        official / "hyperframes" / "SKILL.md",
        official / "hyperframes-core" / "SKILL.md",
        official / "hyperframes-core" / "references" / "minimal-composition.md",
        official / "hyperframes-core" / "references" / "data-attributes.md",
        official / "hyperframes-core" / "references" / "tracks-and-clips.md",
        official / "hyperframes-core" / "references" / "determinism-rules.md",
        official / "hyperframes-cli" / "SKILL.md",
        official / "hyperframes-cli" / "references" / "lint-validate-inspect.md",
        official / "hyperframes-animation" / "SKILL.md",
    ]
    seen: set[str] = set()
    for name in section_names or []:
        token = str(name or "").strip().lower().replace("_", "-").removesuffix(".md")
        if not token or token in seen:
            continue
        seen.add(token)
        if token not in HYPERFRAMES_OPTIONAL_SECTIONS:
            raise FileNotFoundError(f"Missing official HyperFrames section: {token}")
        paths.extend(HYPERFRAMES_OPTIONAL_SECTIONS[token])
    return _read_many(paths)


def load_local_engine_skill(engine: str) -> str:
    token = normalize_engine(engine)
    path = SKILLS_DIR / f"{token}.md"
    return _read_required(path)


def load_engine_skill(engine: str, rule_names: list[str] | tuple[str, ...] | None = None) -> str:
    token = normalize_engine(engine)
    local_skill = load_local_engine_skill(token)
    if token == "manim":
        return "".join(
            [
                load_manim_official_skill(),
                _section("VideoAutoCut Manim Constraints", local_skill),
            ]
        ).strip()
    if token == "hyperframes":
        return "".join(
            [
                load_hyperframes_official_skill(rule_names),
                _section("VideoAutoCut HyperFrames Constraints", local_skill),
            ]
        ).strip()
    if token != "remotion":
        return local_skill
    return "".join(
        [
            load_remotion_official_skill(rule_names),
            _section("VideoAutoCut Remotion Constraints", local_skill),
        ]
    ).strip()


def write_skill_snapshot(engine: str, target_dir: Path) -> Path:
    token = normalize_engine(engine)
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / f"{token}.skill.md"
    target.write_text(load_engine_skill(token), encoding="utf-8")
    return target
