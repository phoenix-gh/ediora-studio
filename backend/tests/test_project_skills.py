import os
from pathlib import Path
import pytest
from profile_manager import (
    parse_skill_frontmatter,
    list_project_skills,
)


def _make_skill(root: Path, name: str, *, description="", version="1.0.0", tags=None):
    d = root / name
    d.mkdir(parents=True)
    fm = [f"---", f"name: {name}", f'description: "{description}"', f"version: {version}"]
    if tags is not None:
        fm += ["metadata:", "  hermes:", f"    tags: [{', '.join(tags)}]"]
    fm += ["---", "", f"# {name}", "body text"]
    (d / "SKILL.md").write_text("\n".join(fm), encoding="utf-8")
    return d


def test_parse_skill_frontmatter_extracts_fields(tmp_path):
    d = _make_skill(tmp_path, "article-drafting",
                    description="从素材到初稿", version="1.0.0",
                    tags=["content-creation", "drafting"])
    meta = parse_skill_frontmatter(d / "SKILL.md")
    assert meta["description"] == "从素材到初稿"
    assert meta["version"] == "1.0.0"
    assert meta["tags"] == ["content-creation", "drafting"]


def test_parse_skill_frontmatter_handles_no_frontmatter(tmp_path):
    p = tmp_path / "SKILL.md"
    p.write_text("# no frontmatter here\n", encoding="utf-8")
    assert parse_skill_frontmatter(p) == {"description": "", "version": "", "tags": []}


def test_list_project_skills_scans_root(tmp_path, monkeypatch):
    skills_root = tmp_path / "skills"
    _make_skill(skills_root, "x-post", description="推文", tags=["social-media"])
    _make_skill(skills_root, "content-ideation", description="选题", tags=["ideation"])
    # 非技能目录（无 SKILL.md）应被忽略
    (skills_root / "not-a-skill").mkdir(parents=True)
    monkeypatch.setenv("WEMS_SKILLS_ROOT", str(skills_root))
    rows = list_project_skills()
    names = [r["name"] for r in rows]
    assert names == ["content-ideation", "x-post"]  # sorted
    assert rows[1]["description"] == "推文"
    assert rows[1]["tags"] == ["social-media"]


def test_list_project_skills_empty_when_root_missing(tmp_path, monkeypatch):
    monkeypatch.setenv("WEMS_SKILLS_ROOT", str(tmp_path / "nope"))
    assert list_project_skills() == []
