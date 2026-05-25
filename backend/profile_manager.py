"""Read + parse Hermes profile state. Mutations live elsewhere (CLI shellouts)."""
from __future__ import annotations
import os
import re
import subprocess
from pathlib import Path
from typing import Any
import yaml

# Catalog of built-in toolsets we surface in the UI. Keep in sync with `hermes tools list`.
# (name, human label, emoji)
KNOWN_TOOLSETS: list[tuple[str, str, str]] = [
    ("web", "Web Search & Scraping", "🔍"),
    ("browser", "Browser Automation", "🌐"),
    ("terminal", "Terminal & Processes", "💻"),
    ("file", "File Operations", "📁"),
    ("code_execution", "Code Execution", "⚡"),
    ("vision", "Vision / Image Analysis", "👁️"),
    ("video", "Video Analysis", "🎬"),
    ("image_gen", "Image Generation", "🎨"),
    ("video_gen", "Video Generation", "🎬"),
    ("x_search", "X (Twitter) Search", "🐦"),
    ("moa", "Mixture of Agents", "🧠"),
    ("tts", "Text-to-Speech", "🔊"),
    ("skills", "Skills", "📚"),
    ("todo", "Task Planning", "📋"),
    ("memory", "Memory", "💾"),
    ("session_search", "Session Search", "🔎"),
    ("clarify", "Clarifying Questions", "❓"),
    ("delegation", "Task Delegation", "👥"),
    ("cronjob", "Cron Jobs", "⏰"),
    ("messaging", "Cross-Platform Messaging", "📨"),
    ("homeassistant", "Home Assistant", "🏠"),
    ("spotify", "Spotify", "🎵"),
    ("yuanbao", "Yuanbao", "🤖"),
    ("computer_use", "Computer Use (macOS)", "🖱️"),
]

_NAME_RE = re.compile(r"^[a-zA-Z0-9_-]+$")


def _hermes_root() -> Path:
    # Test override via HERMES_HOME_ROOT; production reads ~/.hermes
    override = os.environ.get("HERMES_HOME_ROOT")
    return Path(override) if override else Path.home() / ".hermes"


def _safe_name(name: str) -> str:
    if not _NAME_RE.match(name):
        raise ValueError(f"invalid profile name: {name!r}")
    return name


def _profile_dir(name: str) -> Path:
    name = _safe_name(name)
    root = _hermes_root()
    return root if name == "default" else root / "profiles" / name


def list_profiles() -> list[dict[str, Any]]:
    root = _hermes_root()
    rows: list[dict[str, Any]] = []
    if (root / "config.yaml").exists():
        rows.append({"name": "default", "is_default": True, **_summary(root)})
    profiles_dir = root / "profiles"
    if profiles_dir.is_dir():
        for child in sorted(profiles_dir.iterdir()):
            if child.is_dir() and _NAME_RE.match(child.name):
                rows.append({"name": child.name, "is_default": False, **_summary(child)})
    return rows


def _summary(profile_dir: Path) -> dict[str, Any]:
    cfg = _load_config(profile_dir)
    model = (cfg.get("model") or {}).get("default", "")
    skills_dir = profile_dir / "skills"
    skill_count = sum(1 for _ in skills_dir.iterdir()) if skills_dir.is_dir() else 0
    return {"model": model, "skill_count": skill_count}


def _load_config(profile_dir: Path) -> dict[str, Any]:
    f = profile_dir / "config.yaml"
    if not f.exists():
        return {}
    with f.open("r", encoding="utf-8") as fh:
        return yaml.safe_load(fh) or {}


def get_profile_detail(name: str) -> dict[str, Any]:
    pdir = _profile_dir(name)
    if not pdir.exists():
        raise FileNotFoundError(name)
    cfg = _load_config(pdir)
    soul_path = pdir / "SOUL.md"
    soul = soul_path.read_text(encoding="utf-8") if soul_path.exists() else ""

    enabled_toolsets = set(cfg.get("toolsets") or [])  # whitelist when set
    disabled_toolsets = set((cfg.get("agent") or {}).get("disabled_toolsets") or [])
    toolsets = []
    for ts_name, label, emoji in KNOWN_TOOLSETS:
        # Hermes semantics: a toolset is enabled if NOT in disabled_toolsets.
        # The top-level `toolsets:` list selects activation packs, not per-tool gating.
        toolsets.append({
            "name": ts_name,
            "label": label,
            "emoji": emoji,
            "enabled": ts_name not in disabled_toolsets,
        })

    mcp_cfg = cfg.get("mcp_servers") or {}
    mcp_servers = [
        {"name": k, "url": (v or {}).get("url", ""), "enabled": not (v or {}).get("disabled", False)}
        for k, v in mcp_cfg.items()
    ]

    # Skills: read-only listing from `hermes skills list` (parsed).
    skills = _read_skills(pdir)

    return {
        "name": name,
        "is_default": name == "default",
        "soul": soul,
        "toolsets": toolsets,
        "mcp_servers": mcp_servers,
        "skills": skills,
    }


def _read_skills(profile_dir: Path) -> list[dict[str, Any]]:
    """List skills by walking the skills/ directory. Each subdir is either a
    category folder (containing skill subdirs) or a skill itself (has SKILL.md).
    """
    skills_dir = profile_dir / "skills"
    if not skills_dir.is_dir():
        return []
    disabled = set()
    cfg = _load_config(profile_dir)
    if isinstance(cfg.get("skills"), dict):
        disabled = set(cfg["skills"].get("disabled") or [])

    out: list[dict[str, Any]] = []
    for entry in sorted(skills_dir.iterdir()):
        if not entry.is_dir() or entry.name.startswith("."):
            continue
        # If entry contains SKILL.md, treat as a top-level skill
        if (entry / "SKILL.md").exists():
            out.append({"name": entry.name, "category": "", "source": "local",
                         "enabled": entry.name not in disabled})
            continue
        # Otherwise treat as category folder
        for sub in sorted(entry.iterdir()):
            if sub.is_dir() and (sub / "SKILL.md").exists():
                out.append({"name": sub.name, "category": entry.name, "source": "local",
                             "enabled": sub.name not in disabled})
    return out


def write_soul(name: str, content: str) -> None:
    if name == "default":
        raise PermissionError("default profile is read-only")
    pdir = _profile_dir(name)
    if not pdir.exists():
        raise FileNotFoundError(name)
    (pdir / "SOUL.md").write_text(content, encoding="utf-8")


def set_toolset(name: str, toolset: str, enabled: bool) -> None:
    if name == "default":
        raise PermissionError("default profile is read-only")
    _safe_name(name)
    if not _NAME_RE.match(toolset):
        raise ValueError(f"invalid toolset name: {toolset!r}")
    pdir = _profile_dir(name)
    if not pdir.exists():
        raise FileNotFoundError(name)
    cmd = ["hermes", "tools", "enable" if enabled else "disable", toolset]
    env = {**os.environ, "HERMES_HOME": str(pdir)}
    result = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        raise RuntimeError(f"hermes failed: {result.stderr.strip() or result.stdout.strip()}")


def set_mcp_server(name: str, server: str, enabled: bool) -> None:
    if name == "default":
        raise PermissionError("default profile is read-only")
    _safe_name(name)
    if not _NAME_RE.match(server):
        raise ValueError(f"invalid mcp server name: {server!r}")
    pdir = _profile_dir(name)
    if not pdir.exists():
        raise FileNotFoundError(name)
    cfg_path = pdir / "config.yaml"
    if not cfg_path.exists():
        raise FileNotFoundError(str(cfg_path))

    # NOTE: This is the ONE exception to "never write config.yaml ourselves".
    # `hermes mcp` has no non-interactive enable/disable subcommand (only
    # serve/add/remove/list/test/configure/login), and `configure` requires
    # an interactive TTY. We therefore do a surgical ruamel.yaml round-trip
    # that mutates ONLY `mcp_servers.<name>.disabled`, preserving every other
    # key, comment, and formatting choice in the file. If hermes ever ships
    # a CLI flag for this, swap the body back to a subprocess shellout.
    from ruamel.yaml import YAML
    yaml_rt = YAML()
    yaml_rt.preserve_quotes = True
    with cfg_path.open("r", encoding="utf-8") as fh:
        data = yaml_rt.load(fh) or {}
    servers = data.get("mcp_servers")
    if not isinstance(servers, dict) or server not in servers:
        raise KeyError(f"mcp server {server!r} not found in {cfg_path}")
    entry = servers[server]
    if entry is None:
        servers[server] = {}
        entry = servers[server]
    if enabled:
        # Remove the key entirely when re-enabling, to keep the file tidy.
        if "disabled" in entry:
            del entry["disabled"]
    else:
        entry["disabled"] = True
    with cfg_path.open("w", encoding="utf-8") as fh:
        yaml_rt.dump(data, fh)
