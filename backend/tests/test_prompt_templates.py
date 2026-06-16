import pytest

import prompt_templates as ptpl


def test_load_reads_and_strips(tmp_path, monkeypatch):
    d = tmp_path / "writer"
    d.mkdir()
    (d / "x.md").write_text("\n  hello world  \n", encoding="utf-8")
    monkeypatch.setattr(ptpl, "_PROMPTS_DIR", tmp_path)
    assert ptpl.load("writer/x.md") == "hello world"


def test_render_substitutes_placeholders(tmp_path, monkeypatch):
    (tmp_path / "t.md").write_text("max {{max_chars}} 字, raw={{raw}}", encoding="utf-8")
    monkeypatch.setattr(ptpl, "_PROMPTS_DIR", tmp_path)
    assert ptpl.render("t.md", max_chars=200, raw="100-200 字") == "max 200 字, raw=100-200 字"


def test_load_missing_file_raises(tmp_path, monkeypatch):
    monkeypatch.setattr(ptpl, "_PROMPTS_DIR", tmp_path)
    with pytest.raises(FileNotFoundError):
        ptpl.load("nope.md")
