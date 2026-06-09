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


def _project_skills_root() -> Path:
    # Test override via WEMS_SKILLS_ROOT; production = repo's skills/ dir.
    override = os.environ.get("WEMS_SKILLS_ROOT")
    if override:
        return Path(override)
    return Path(__file__).resolve().parent.parent / "skills"


def parse_skill_frontmatter(skill_md: Path) -> dict[str, Any]:
    """Extract description/version/tags from a SKILL.md YAML frontmatter block."""
    try:
        text = skill_md.read_text(encoding="utf-8")
    except OSError:
        return {"description": "", "version": "", "tags": []}
    if not text.startswith("---"):
        return {"description": "", "version": "", "tags": []}
    parts = text.split("---", 2)
    if len(parts) < 3:
        return {"description": "", "version": "", "tags": []}
    data = yaml.safe_load(parts[1]) or {}
    tags = ((data.get("metadata") or {}).get("hermes") or {}).get("tags") or []
    return {
        "description": data.get("description", "") or "",
        "version": str(data.get("version", "") or ""),
        "tags": list(tags),
    }


def list_project_skills() -> list[dict[str, Any]]:
    """Scan the project skills/ dir; return metadata for each skill dir with a SKILL.md."""
    root = _project_skills_root()
    if not root.is_dir():
        return []
    out: list[dict[str, Any]] = []
    for entry in sorted(root.iterdir()):
        skill_md = entry / "SKILL.md"
        if not entry.is_dir() or entry.name.startswith(".") or not skill_md.exists():
            continue
        meta = parse_skill_frontmatter(skill_md)
        out.append({"name": entry.name, **meta})
    return out


def list_project_skills_for_profile(profile: str) -> list[dict[str, Any]]:
    """All project skills plus a per-profile `installed` flag (symlink check)."""
    _safe_name(profile)
    wemedia_dir = _profile_dir(profile) / "skills" / "wemedia"
    root = _project_skills_root()
    out: list[dict[str, Any]] = []
    for meta in list_project_skills():
        link = wemedia_dir / meta["name"]
        src = root / meta["name"]
        installed = link.is_symlink() and link.resolve() == src.resolve()
        out.append({**meta, "installed": installed})
    return out


def install_project_skill(profile: str, skill: str) -> None:
    """Symlink a project skill into the profile's skills/wemedia/ dir."""
    if profile == "default":
        raise PermissionError("default profile is read-only")
    _safe_name(profile)
    if not _NAME_RE.match(skill):
        raise ValueError(f"invalid skill name: {skill!r}")
    src = _project_skills_root() / skill
    if not (src / "SKILL.md").exists():
        raise FileNotFoundError(f"project skill not found: {skill}")
    pdir = _profile_dir(profile)
    if not pdir.exists():
        raise FileNotFoundError(f"profile not found: {profile}")
    wemedia_dir = pdir / "skills" / "wemedia"
    wemedia_dir.mkdir(parents=True, exist_ok=True)
    link = wemedia_dir / skill
    if link.is_symlink():
        if link.resolve() == src.resolve():
            return  # already installed
        link.unlink()  # repoint a stale/wrong symlink
    elif link.exists():
        raise RuntimeError(f"{link} exists and is not a symlink; refusing to overwrite")
    link.symlink_to(src.resolve(), target_is_directory=True)


def uninstall_project_skill(profile: str, skill: str) -> None:
    """Remove the symlink for a project skill from a profile. Idempotent."""
    if profile == "default":
        raise PermissionError("default profile is read-only")
    _safe_name(profile)
    if not _NAME_RE.match(skill):
        raise ValueError(f"invalid skill name: {skill!r}")
    pdir = _profile_dir(profile)
    if not pdir.exists():
        raise FileNotFoundError(f"profile not found: {profile}")
    link = pdir / "skills" / "wemedia" / skill
    if link.is_symlink():
        link.unlink()
        return
    if link.exists():
        raise RuntimeError(f"{link} is not a symlink; refusing to delete")
    # neither symlink nor real path: idempotent no-op


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

    # `hermes tools enable/disable <name>` writes the allowlist at
    # `platform_toolsets.<platform>` (cli for our case). A toolset is enabled
    # iff its name is in that list. `agent.disabled_toolsets` is a separate
    # legacy override that also force-disables, so AND both for safety.
    platform_enabled = set(((cfg.get("platform_toolsets") or {}).get("cli") or []))
    force_disabled = set((cfg.get("agent") or {}).get("disabled_toolsets") or [])
    toolsets = [
        {
            "name": ts_name,
            "label": label,
            "emoji": emoji,
            "enabled": ts_name in platform_enabled and ts_name not in force_disabled,
        }
        for ts_name, label, emoji in KNOWN_TOOLSETS
    ]

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

    # `hermes tools enable` only adds to the platform allowlist; it does NOT
    # remove the toolset from `agent.disabled_toolsets`, which acts as a
    # force-disable override and keeps hermes treating the toolset as off.
    # Narrowly patch that override out so the user's toggle matches reality.
    if enabled:
        _remove_from_disabled_toolsets(pdir, toolset)


def _remove_from_disabled_toolsets(profile_dir: Path, toolset: str) -> None:
    cfg_path = profile_dir / "config.yaml"
    if not cfg_path.exists():
        return
    from ruamel.yaml import YAML
    yaml_rt = YAML()
    yaml_rt.preserve_quotes = True
    with cfg_path.open("r", encoding="utf-8") as fh:
        data = yaml_rt.load(fh) or {}
    agent = data.get("agent")
    if not isinstance(agent, dict):
        return
    lst = agent.get("disabled_toolsets")
    if not isinstance(lst, list) or toolset not in lst:
        return
    lst.remove(toolset)
    with cfg_path.open("w", encoding="utf-8") as fh:
        yaml_rt.dump(data, fh)


def set_skills(name: str, skills: list[str], enabled: bool) -> None:
    """Toggle a batch of skills on/off via narrow `skills.disabled` patch.

    hermes has no non-interactive `skills enable/disable` CLI — `hermes
    skills config` is interactive TUI only. So we surgically mutate the
    `skills.disabled` list with ruamel.yaml. Verified empirically: hermes
    treats any skill listed there as disabled (`hermes skills list` shows
    Status=disabled).
    """
    if name == "default":
        raise PermissionError("default profile is read-only")
    _safe_name(name)
    for s in skills:
        if not _NAME_RE.match(s):
            raise ValueError(f"invalid skill name: {s!r}")
    pdir = _profile_dir(name)
    if not pdir.exists():
        raise FileNotFoundError(name)
    cfg_path = pdir / "config.yaml"
    if not cfg_path.exists():
        raise FileNotFoundError(str(cfg_path))

    from ruamel.yaml import YAML
    yaml_rt = YAML()
    yaml_rt.preserve_quotes = True
    with cfg_path.open("r", encoding="utf-8") as fh:
        data = yaml_rt.load(fh) or {}
    skills_section = data.get("skills")
    if not isinstance(skills_section, dict):
        data["skills"] = {"disabled": []}
        skills_section = data["skills"]
    disabled = skills_section.get("disabled")
    if not isinstance(disabled, list):
        skills_section["disabled"] = []
        disabled = skills_section["disabled"]

    if enabled:
        for s in skills:
            while s in disabled:
                disabled.remove(s)
    else:
        for s in skills:
            if s not in disabled:
                disabled.append(s)

    with cfg_path.open("w", encoding="utf-8") as fh:
        yaml_rt.dump(data, fh)


def create_profile_via_cli(
    name: str,
    *,
    clone_from: str | None = None,
    description: str = "",
) -> None:
    """Create a new hermes profile via `hermes profile create`.

    `clone_from='default'` is treated as the active profile (hermes default).
    Pass any other name to clone from that profile's config + SOUL.md.
    """
    name = _safe_name(name)
    pdir = _profile_dir(name)
    if pdir.exists():
        raise ValueError(f"profile {name!r} already exists")
    cmd = ["hermes", "profile", "create", name]
    if clone_from:
        _safe_name(clone_from)
        if clone_from != "default":
            cmd += ["--clone-from", clone_from]
        else:
            cmd += ["--clone"]
    if description:
        cmd += ["--description", description]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        raise RuntimeError(f"hermes profile create failed: {result.stderr.strip() or result.stdout.strip()}")


def delete_profile_via_cli(name: str) -> None:
    if name == "default":
        raise PermissionError("default profile is read-only")
    name = _safe_name(name)
    pdir = _profile_dir(name)
    if not pdir.exists():
        raise FileNotFoundError(name)
    result = subprocess.run(
        ["hermes", "profile", "delete", name, "-y"],
        capture_output=True, text=True, timeout=60,
    )
    if result.returncode != 0:
        raise RuntimeError(f"hermes profile delete failed: {result.stderr.strip() or result.stdout.strip()}")


def set_hermes_description(name: str, text: str) -> None:
    """Sync description into hermes via `hermes profile describe --text`.

    Kanban orchestrator reads this for role routing — keep them in sync with the
    DB-stored description.
    """
    if name == "default":
        raise PermissionError("default profile is read-only")
    name = _safe_name(name)
    result = subprocess.run(
        ["hermes", "profile", "describe", name, "--text", text],
        capture_output=True, text=True, timeout=30,
    )
    if result.returncode != 0:
        raise RuntimeError(f"hermes profile describe failed: {result.stderr.strip() or result.stdout.strip()}")


def list_profile_names() -> list[str]:
    """Names only — for cheap clone-source dropdowns."""
    return [p["name"] for p in list_profiles()]


CODEX_IMAGEGEN_SCRIPT = Path.home() / ".hermes" / "skills" / "custom" / "codex_imagegen" / "scripts" / "main.py"


def generate_avatar_via_codex(prompt: str, out_path: Path) -> None:
    """Invoke the codex_imagegen skill script to render an avatar PNG.

    Square 1:1 aspect; caller decides where to put the file.
    """
    if not CODEX_IMAGEGEN_SCRIPT.exists():
        raise RuntimeError(f"codex_imagegen skill not found at {CODEX_IMAGEGEN_SCRIPT}")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "python", str(CODEX_IMAGEGEN_SCRIPT),
        "--image", str(out_path),
        "--prompt", prompt,
        "--aspect", "1:1",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if result.returncode != 0 or not out_path.exists():
        raise RuntimeError(f"codex_imagegen failed: {result.stderr.strip() or result.stdout.strip()}")


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
