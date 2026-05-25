import os
import tempfile
from pathlib import Path
import pytest
from profile_manager import list_profiles, get_profile_detail, _safe_name

def _fixture_home(tmp_path: Path) -> Path:
    home = tmp_path / "hermes"
    (home / "profiles" / "wms_writer").mkdir(parents=True)
    (home / "profiles" / "wms_writer" / "SOUL.md").write_text("you are a writer\n")
    (home / "profiles" / "wms_writer" / "config.yaml").write_text(
        "model:\n  default: deepseek-v4-flash\n"
        "toolsets:\n  - hermes-cli\n"
        "agent:\n  disabled_toolsets: [browser, web]\n"
        "mcp_servers:\n  wemedia-studio:\n    url: http://localhost:8000/mcp\n"
        "skills:\n  disabled: []\n"
    )
    (home / "SOUL.md").write_text("default soul\n")
    (home / "config.yaml").write_text("model:\n  default: mimo-v2.5\n")
    return home

def test_list_profiles_includes_default_and_subprofiles(tmp_path, monkeypatch):
    home = _fixture_home(tmp_path)
    monkeypatch.setenv("HERMES_HOME_ROOT", str(home))
    rows = list_profiles()
    names = [p["name"] for p in rows]
    assert "default" in names
    assert "wms_writer" in names
    default = next(p for p in rows if p["name"] == "default")
    assert default["is_default"] is True

def test_get_profile_detail_parses_toolsets_and_mcp(tmp_path, monkeypatch):
    home = _fixture_home(tmp_path)
    monkeypatch.setenv("HERMES_HOME_ROOT", str(home))
    detail = get_profile_detail("wms_writer")
    assert detail["soul"] == "you are a writer\n"
    # browser is in disabled_toolsets → enabled == False
    browser = next(t for t in detail["toolsets"] if t["name"] == "browser")
    assert browser["enabled"] is False
    # 'skills' is enabled by default (not in disabled_toolsets, present in known list)
    skills_ts = next(t for t in detail["toolsets"] if t["name"] == "skills")
    assert skills_ts["enabled"] is True
    mcp = detail["mcp_servers"]
    assert mcp[0]["name"] == "wemedia-studio"
    assert mcp[0]["enabled"] is True

def test_safe_name_rejects_traversal():
    assert _safe_name("wms_writer") == "wms_writer"
    with pytest.raises(ValueError):
        _safe_name("../etc")
    with pytest.raises(ValueError):
        _safe_name("a/b")
