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
        "agent:\n  disabled_toolsets: [memory]\n"
        "platform_toolsets:\n  cli: [skills, web]\n"
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
    # `skills` and `web` are in platform_toolsets.cli → enabled
    skills_ts = next(t for t in detail["toolsets"] if t["name"] == "skills")
    assert skills_ts["enabled"] is True
    web_ts = next(t for t in detail["toolsets"] if t["name"] == "web")
    assert web_ts["enabled"] is True
    # `browser` is NOT in platform_toolsets.cli → disabled
    browser = next(t for t in detail["toolsets"] if t["name"] == "browser")
    assert browser["enabled"] is False
    # `memory` is in platform_toolsets.cli? no — also in agent.disabled_toolsets → disabled either way
    memory = next(t for t in detail["toolsets"] if t["name"] == "memory")
    assert memory["enabled"] is False
    mcp = detail["mcp_servers"]
    assert mcp[0]["name"] == "wemedia-studio"
    assert mcp[0]["enabled"] is True

def test_set_mcp_server_roundtrip(tmp_path, monkeypatch):
    from profile_manager import set_mcp_server, get_profile_detail
    home = _fixture_home(tmp_path)
    monkeypatch.setenv("HERMES_HOME_ROOT", str(home))
    # set_mcp_server uses the YAML patch path (no hermes CLI), so this is CI-safe.
    set_mcp_server("wms_writer", "wemedia-studio", False)
    detail = get_profile_detail("wms_writer")
    mcp = next(m for m in detail["mcp_servers"] if m["name"] == "wemedia-studio")
    assert mcp["enabled"] is False
    set_mcp_server("wms_writer", "wemedia-studio", True)
    detail2 = get_profile_detail("wms_writer")
    mcp2 = next(m for m in detail2["mcp_servers"] if m["name"] == "wemedia-studio")
    assert mcp2["enabled"] is True


def test_safe_name_rejects_traversal():
    assert _safe_name("wms_writer") == "wms_writer"
    with pytest.raises(ValueError):
        _safe_name("../etc")
    with pytest.raises(ValueError):
        _safe_name("a/b")
