"""Golden snapshot of the writer rule assemblers — locks current output so the
markdown-extraction refactor can be proven byte-identical.

Intended change? Regenerate:
    UPDATE_WRITER_SNAPSHOTS=1 conda run -n wems python -m pytest tests/test_writer_prompts_golden.py
"""
import os
from pathlib import Path

import pytest

import pipeline_template as pt

SNAP_DIR = Path(__file__).parent / "snapshots" / "writer"

# name -> ctx. Covers genre × {long, short} × {plan spec, default} × humanizer on/off.
COMBOS: dict[str, dict] = {
    "commentary_long":         {"genre": "commentary"},
    "commentary_short_plan":   {"genre": "commentary", "word_spec": {"min": 100, "max": 200, "raw": "100-200 字"}},
    "commentary_spec_default": {"genre": "commentary", "word_spec": {"min": 1500, "max": 2200}},
    "tutorial_long":           {"genre": "tutorial"},
    "tutorial_short_plan":     {"genre": "tutorial", "word_spec": {"max": 300, "raw": "300 字以内"}},
    "story_long":              {"genre": "story"},
    "review_long":             {"genre": "review"},
}


def _bundle(ctx: dict) -> str:
    """Concatenate every writer assembler's output for one ctx into one snapshot."""
    return "\n\n===SECTION===\n\n".join([
        pt.writer_rules_md(ctx),
        pt.writer_first_person_anchor_md(ctx),
        pt.writer_structure_directive_md(ctx),
        pt.writer_word_directive_md(ctx),
        pt.writer_humanizer_line_md(ctx),
    ])


@pytest.mark.parametrize("name", list(COMBOS))
def test_writer_rule_bundle_matches_snapshot(name):
    actual = _bundle(COMBOS[name])
    snap = SNAP_DIR / f"{name}.md"
    if os.environ.get("UPDATE_WRITER_SNAPSHOTS"):
        snap.parent.mkdir(parents=True, exist_ok=True)
        snap.write_text(actual, encoding="utf-8")
        pytest.skip(f"snapshot written: {snap.name}")
    assert snap.exists(), f"missing snapshot {snap}; run with UPDATE_WRITER_SNAPSHOTS=1 first"
    assert actual == snap.read_text(encoding="utf-8")
