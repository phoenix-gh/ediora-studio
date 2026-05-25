# Hermes Profile Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/profiles` page that lets the user list all Hermes profiles, edit each profile's `SOUL.md`, and toggle its built-in toolsets and MCP servers. The currently-active `default` profile is read-only. Skills are listed read-only in Phase 1.

**Architecture:** New FastAPI router `backend/routers/profiles.py` talks to Hermes by (a) reading `~/.hermes/profiles/<name>/{SOUL.md,config.yaml}` for state, (b) shelling out to `HERMES_HOME=<profile-dir> hermes …` for any state mutation that has a non-interactive CLI (tools/MCP). `SOUL.md` is the one file we read/write directly. We never write `config.yaml` ourselves — the official CLI does that. A new top-level Next.js page `wemedia-studio/app/profiles/` provides the UI: left-side profile list, right-side detail panel with three tabs (SOUL / Tools / Skills).

**Tech Stack:** FastAPI (Python 3.11, conda env `wems`), PyYAML for read-only config parsing, `subprocess` for `hermes` CLI calls, Next.js App Router (non-standard — consult `node_modules/next/dist/docs/` before editing routing), Tailwind + shadcn/ui (`Button`, `Input`, `Textarea`, `Switch`, `Tabs`).

**Scope boundaries:**
- Phase 1 (this plan): SOUL edit, built-in toolset toggles, MCP server enable/disable, read-only skill list.
- Out of scope: creating/deleting/renaming profiles, editing `.env`, model selection, MCP server *add/remove*, per-skill toggles (no non-interactive CLI exists — punt to Phase 2).

**Conventions reminders** (read before coding):
- Every backend command must run inside `conda run -n wems …` (see `memory/project_env.md`).
- Frontend uses a *forked* Next.js with breaking changes — read `wemedia-studio/node_modules/next/dist/docs/` before adding routes (see `wemedia-studio/AGENTS.md`).

---

## File Structure

**Backend (new):**
- `backend/profile_manager.py` — pure helper functions (list/read/write profile files, parse `config.yaml` for state, shell out to `hermes` CLI). No FastAPI types here.
- `backend/routers/profiles.py` — FastAPI router with the seven endpoints below; imports from `profile_manager`.

**Backend (modify):**
- `backend/main.py:7` — add `profiles` to the routers import list and `app.include_router(profiles.router, prefix="/api")`.

**Frontend (new):**
- `wemedia-studio/app/profiles/page.tsx` — server component, just renders `<ProfilesClient />`.
- `wemedia-studio/app/profiles/ProfilesClient.tsx` — main client component: profile list + detail panel.
- `wemedia-studio/app/profiles/SoulEditor.tsx` — textarea + save button for `SOUL.md`.
- `wemedia-studio/app/profiles/ToolsPanel.tsx` — toolsets + MCP servers as Switch rows.
- `wemedia-studio/app/profiles/SkillsPanel.tsx` — read-only skill list grouped by category, with search.
- `wemedia-studio/lib/api/profiles.ts` — typed fetch wrappers.

**Frontend (modify):**
- `wemedia-studio/components/features/Sidebar.tsx:23` (the "今日工作台" group): insert `{ href: '/profiles', label: 'Profile', icon: UserCog }` after `/studio`. Add `UserCog` to the lucide-react import.

---

## API Contract (locked before implementation)

All endpoints under `/api/profiles`. Names like `wms_writer` are URL-safe; the backend MUST validate `^[a-zA-Z0-9_-]+$` and reject anything else (path-traversal guard).

```
GET    /api/profiles
  → { profiles: [{ name, is_default, model, gateway, skill_count }] }

GET    /api/profiles/{name}
  → {
      name, is_default,
      soul: string,                                  # raw SOUL.md content
      toolsets: [{ name, label, emoji, enabled }],   # built-in toolsets
      mcp_servers: [{ name, url, enabled }],         # registered MCP servers
      skills: [{ name, category, source, enabled }], # read-only in Phase 1
    }

PUT    /api/profiles/{name}/soul
  body: { content: string }
  → { ok: true }
  errors: 403 if name == "default"

POST   /api/profiles/{name}/toolsets
  body: { name: string, enabled: bool }
  → { ok: true }
  errors: 403 if name == "default", 502 if hermes CLI fails

POST   /api/profiles/{name}/mcp
  body: { name: string, enabled: bool }
  → { ok: true }
  errors: 403 if name == "default", 502 if hermes CLI fails
```

Implementation notes:
- "Default profile read-only" = `name == "default"` returns 403 on any mutation; GETs work normally.
- Toolset enable/disable: `HERMES_HOME=<dir> hermes tools enable <name>` / `disable <name>`.
- MCP enable/disable: same — `hermes tools enable <server>:*` actually doesn't work; MCP servers are enabled at the *server* level via `hermes mcp enable/disable`. Verify in Task 4 and fall back to `hermes tools enable/disable` if needed.

---

## Task 1: Backend helper — list profiles and read detail

**Files:**
- Create: `backend/profile_manager.py`
- Test: `backend/tests/test_profile_manager.py` (create `backend/tests/__init__.py` if missing)

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_profile_manager.py
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `conda run -n wems pytest backend/tests/test_profile_manager.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'profile_manager'`.

- [ ] **Step 3: Implement the helper**

```python
# backend/profile_manager.py
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
    # `hermes mcp enable/disable` toggles a server; verified manually in Task 4.
    cmd = ["hermes", "mcp", "enable" if enabled else "disable", server]
    env = {**os.environ, "HERMES_HOME": str(pdir)}
    result = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        raise RuntimeError(f"hermes failed: {result.stderr.strip() or result.stdout.strip()}")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `conda run -n wems pytest backend/tests/test_profile_manager.py -v`
Expected: all three tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/profile_manager.py backend/tests/__init__.py backend/tests/test_profile_manager.py
git commit -m "feat(profiles): add profile_manager helper for reading hermes profile state"
```

---

## Task 2: Backend router — wire endpoints

**Files:**
- Create: `backend/routers/profiles.py`
- Modify: `backend/main.py:7` (import) and after line 60 (include_router)
- Test: `backend/tests/test_profiles_router.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_profiles_router.py
import os
from pathlib import Path
from fastapi.testclient import TestClient
import pytest

@pytest.fixture
def client(tmp_path, monkeypatch):
    home = tmp_path / "hermes"
    (home / "profiles" / "wms_writer").mkdir(parents=True)
    (home / "profiles" / "wms_writer" / "SOUL.md").write_text("hi\n")
    (home / "profiles" / "wms_writer" / "config.yaml").write_text(
        "model:\n  default: x\ntoolsets: []\nagent:\n  disabled_toolsets: [web]\n"
        "skills:\n  disabled: []\nmcp_servers: {}\n"
    )
    (home / "SOUL.md").write_text("\n")
    (home / "config.yaml").write_text("model:\n  default: y\n")
    monkeypatch.setenv("HERMES_HOME_ROOT", str(home))
    monkeypatch.setenv("WMS_DISABLE_SCHEDULER", "1")
    from main import app
    return TestClient(app)

def test_list(client):
    r = client.get("/api/profiles")
    assert r.status_code == 200
    names = [p["name"] for p in r.json()["profiles"]]
    assert "wms_writer" in names

def test_get_detail(client):
    r = client.get("/api/profiles/wms_writer")
    assert r.status_code == 200
    assert r.json()["soul"] == "hi\n"

def test_default_soul_is_readonly(client):
    r = client.put("/api/profiles/default/soul", json={"content": "x"})
    assert r.status_code == 403

def test_invalid_name_404(client):
    r = client.get("/api/profiles/..%2Fetc")
    assert r.status_code in (400, 404)

def test_write_soul_roundtrip(client):
    r = client.put("/api/profiles/wms_writer/soul", json={"content": "new\n"})
    assert r.status_code == 200
    r2 = client.get("/api/profiles/wms_writer")
    assert r2.json()["soul"] == "new\n"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `conda run -n wems pytest backend/tests/test_profiles_router.py -v`
Expected: FAIL — router not registered.

- [ ] **Step 3: Implement the router**

```python
# backend/routers/profiles.py
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import profile_manager as pm

router = APIRouter(prefix="/profiles", tags=["profiles"])


class SoulBody(BaseModel):
    content: str


class ToggleBody(BaseModel):
    name: str
    enabled: bool


@router.get("")
def list_profiles():
    return {"profiles": pm.list_profiles()}


@router.get("/{name}")
def get_profile(name: str):
    try:
        return pm.get_profile_detail(name)
    except ValueError:
        raise HTTPException(400, "invalid profile name")
    except FileNotFoundError:
        raise HTTPException(404, "profile not found")


@router.put("/{name}/soul")
def put_soul(name: str, body: SoulBody):
    try:
        pm.write_soul(name, body.content)
        return {"ok": True}
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError:
        raise HTTPException(400, "invalid profile name")
    except FileNotFoundError:
        raise HTTPException(404, "profile not found")


@router.post("/{name}/toolsets")
def post_toolset(name: str, body: ToggleBody):
    try:
        pm.set_toolset(name, body.name, body.enabled)
        return {"ok": True}
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except FileNotFoundError:
        raise HTTPException(404, "profile not found")
    except RuntimeError as e:
        raise HTTPException(502, str(e))


@router.post("/{name}/mcp")
def post_mcp(name: str, body: ToggleBody):
    try:
        pm.set_mcp_server(name, body.name, body.enabled)
        return {"ok": True}
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except FileNotFoundError:
        raise HTTPException(404, "profile not found")
    except RuntimeError as e:
        raise HTTPException(502, str(e))
```

- [ ] **Step 4: Wire into main.py**

Modify `backend/main.py`:
- Line 7 import list: append `, profiles` after `publish_accounts`.
- After the existing `include_router` block (around line 60+), add: `app.include_router(profiles.router, prefix="/api")`.

- [ ] **Step 5: Run tests**

Run: `conda run -n wems pytest backend/tests/test_profiles_router.py -v`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/routers/profiles.py backend/main.py backend/tests/test_profiles_router.py
git commit -m "feat(profiles): add /api/profiles router (list, detail, soul, toolset, mcp)"
```

---

## Task 3: Frontend API client + sidebar entry

**Files:**
- Create: `wemedia-studio/lib/api/profiles.ts`
- Modify: `wemedia-studio/components/features/Sidebar.tsx` (imports + first group)

- [ ] **Step 1: Add the API client**

```ts
// wemedia-studio/lib/api/profiles.ts
import { apiFetch } from './fetcher' // verify exact helper name in lib/api/

export interface ProfileSummary {
  name: string
  is_default: boolean
  model: string
  skill_count: number
}

export interface Toolset { name: string; label: string; emoji: string; enabled: boolean }
export interface McpServer { name: string; url: string; enabled: boolean }
export interface Skill { name: string; category: string; source: string; enabled: boolean }

export interface ProfileDetail {
  name: string
  is_default: boolean
  soul: string
  toolsets: Toolset[]
  mcp_servers: McpServer[]
  skills: Skill[]
}

export const listProfiles = () =>
  apiFetch<{ profiles: ProfileSummary[] }>('/api/profiles').then(r => r.profiles)

export const getProfile = (name: string) =>
  apiFetch<ProfileDetail>(`/api/profiles/${encodeURIComponent(name)}`)

export const saveSoul = (name: string, content: string) =>
  apiFetch(`/api/profiles/${encodeURIComponent(name)}/soul`, {
    method: 'PUT',
    body: JSON.stringify({ content }),
  })

export const toggleToolset = (profile: string, name: string, enabled: boolean) =>
  apiFetch(`/api/profiles/${encodeURIComponent(profile)}/toolsets`, {
    method: 'POST',
    body: JSON.stringify({ name, enabled }),
  })

export const toggleMcp = (profile: string, name: string, enabled: boolean) =>
  apiFetch(`/api/profiles/${encodeURIComponent(profile)}/mcp`, {
    method: 'POST',
    body: JSON.stringify({ name, enabled }),
  })
```

Verify the actual fetcher helper name by reading one existing `lib/api/*.ts` (e.g. `personas.ts`) and matching its import.

- [ ] **Step 2: Add sidebar entry**

Modify `wemedia-studio/components/features/Sidebar.tsx`:
- Add `UserCog` to the lucide-react import line at the top.
- Inside the first sidebar group (around line 23, the one starting with `今日工作台`), insert immediately after the `/studio` entry:
  ```ts
  { href: '/profiles', label: 'Profile', icon: UserCog },
  ```

- [ ] **Step 3: Lint-check**

Run: `cd wemedia-studio && npm run lint -- --max-warnings=0` (or the project's standard lint command — check `package.json`).
Expected: no errors related to new files.

- [ ] **Step 4: Commit**

```bash
git add wemedia-studio/lib/api/profiles.ts wemedia-studio/components/features/Sidebar.tsx
git commit -m "feat(profiles): add profiles API client + sidebar entry"
```

---

## Task 4: Frontend page — profile list + SOUL editor

**Files:**
- Create: `wemedia-studio/app/profiles/page.tsx`
- Create: `wemedia-studio/app/profiles/ProfilesClient.tsx`
- Create: `wemedia-studio/app/profiles/SoulEditor.tsx`

**Pre-step:** Read `wemedia-studio/node_modules/next/dist/docs/` for this fork's routing conventions (per `wemedia-studio/AGENTS.md`). Confirm whether `page.tsx` requires `'use server'` or any non-standard directive.

- [ ] **Step 1: Server page shell**

```tsx
// wemedia-studio/app/profiles/page.tsx
import { ProfilesClient } from './ProfilesClient'

export default function Page() {
  return <ProfilesClient />
}
```

- [ ] **Step 2: Client container with list + detail layout**

```tsx
// wemedia-studio/app/profiles/ProfilesClient.tsx
'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { listProfiles, getProfile, ProfileSummary, ProfileDetail } from '@/lib/api/profiles'
import { SoulEditor } from './SoulEditor'
// Imports for ToolsPanel + SkillsPanel are added in Tasks 5 + 6.

export function ProfilesClient() {
  const [list, setList] = useState<ProfileSummary[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<ProfileDetail | null>(null)
  const [tab, setTab] = useState<'soul' | 'tools' | 'skills'>('soul')

  useEffect(() => {
    listProfiles().then(rows => {
      setList(rows)
      const first = rows.find(p => !p.is_default) ?? rows[0]
      if (first) setSelected(first.name)
    }).catch(e => toast.error(String(e)))
  }, [])

  useEffect(() => {
    if (!selected) return
    getProfile(selected).then(setDetail).catch(e => toast.error(String(e)))
  }, [selected])

  const readonly = detail?.is_default ?? false

  return (
    <div className="flex h-full">
      <aside className="w-64 border-r overflow-y-auto">
        <ul>
          {list.map(p => (
            <li key={p.name}>
              <button
                className={`w-full text-left px-4 py-2 hover:bg-muted ${selected === p.name ? 'bg-muted font-medium' : ''}`}
                onClick={() => setSelected(p.name)}
              >
                <div className="flex items-center gap-2">
                  <span>{p.name}</span>
                  {p.is_default && <span className="text-xs text-muted-foreground">(default · 只读)</span>}
                </div>
                <div className="text-xs text-muted-foreground">{p.model}</div>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <main className="flex-1 overflow-y-auto p-6">
        {!detail ? <p className="text-muted-foreground">选择一个 profile</p> : (
          <>
            <h1 className="text-xl font-semibold mb-4">{detail.name}</h1>
            <div className="border-b mb-4 flex gap-4">
              {(['soul', 'tools', 'skills'] as const).map(t => (
                <button key={t}
                  className={`pb-2 ${tab === t ? 'border-b-2 border-primary font-medium' : 'text-muted-foreground'}`}
                  onClick={() => setTab(t)}
                >{t.toUpperCase()}</button>
              ))}
            </div>
            {tab === 'soul' && (
              <SoulEditor
                profile={detail.name}
                initial={detail.soul}
                readonly={readonly}
                onSaved={text => setDetail({ ...detail, soul: text })}
              />
            )}
            {/* ToolsPanel mounted in Task 5, SkillsPanel in Task 6 */}
          </>
        )}
      </main>
    </div>
  )
}
```

- [ ] **Step 3: SOUL editor component**

```tsx
// wemedia-studio/app/profiles/SoulEditor.tsx
'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { saveSoul } from '@/lib/api/profiles'

interface Props {
  profile: string
  initial: string
  readonly: boolean
  onSaved: (text: string) => void
}

export function SoulEditor({ profile, initial, readonly, onSaved }: Props) {
  const [text, setText] = useState(initial)
  const [saving, setSaving] = useState(false)
  useEffect(() => { setText(initial) }, [initial, profile])

  async function handleSave() {
    setSaving(true)
    try {
      await saveSoul(profile, text)
      onSaved(text)
      toast.success('SOUL 已保存')
    } catch (e) {
      toast.error(String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3">
      <Textarea
        value={text}
        onChange={e => setText(e.target.value)}
        disabled={readonly}
        className="min-h-[420px] font-mono text-sm"
      />
      <div className="flex justify-end">
        <Button disabled={readonly || saving || text === initial} onClick={handleSave}>
          {saving ? '保存中…' : '保存'}
        </Button>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Manual smoke**

Run: `cd wemedia-studio && npm run dev` in one terminal and `conda run -n wems uvicorn main:app --reload --app-dir backend` in another.
Visit `http://localhost:3000/profiles`. Expected: profile list on the left (`default` greyed/readonly hint, plus `wms_*`); selecting `wms_writer` shows the SOUL editor with current content. Edit + save → toast success → re-select → content persists. Try saving on `default` → button disabled.

- [ ] **Step 5: Commit**

```bash
git add wemedia-studio/app/profiles/
git commit -m "feat(profiles): profile list page with SOUL editor"
```

---

## Task 5: Tools panel — toolset + MCP toggles

**Files:**
- Create: `wemedia-studio/app/profiles/ToolsPanel.tsx`
- Modify: `wemedia-studio/app/profiles/ProfilesClient.tsx` (mount the panel)

**Pre-step:** Verify `hermes mcp enable/disable <server>` exists. If not, fall back path: read-only MCP list with a UI hint that toggling needs `hermes mcp` CLI. (The plan ships disabling capability either way — only the *channel* changes.)

Run: `source ~/.zshrc && hermes mcp --help` and confirm an `enable`/`disable` subcommand exists. If absent:
- Edit `backend/profile_manager.py: set_mcp_server` to write the `mcp_servers.<name>.disabled` flag via a tightly scoped YAML patch (use `ruamel.yaml` to preserve formatting; load → set just that key → dump back). This is the *one* exception to "never write config.yaml" and it must be documented inline with a comment explaining why.
- Update `backend/tests/test_profile_manager.py` with a roundtrip test for the YAML patch path.

- [ ] **Step 1: Build ToolsPanel**

```tsx
// wemedia-studio/app/profiles/ToolsPanel.tsx
'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Switch } from '@/components/ui/switch'
import { Toolset, McpServer, toggleToolset, toggleMcp } from '@/lib/api/profiles'

interface Props {
  profile: string
  readonly: boolean
  toolsets: Toolset[]
  mcpServers: McpServer[]
  onChange: (next: { toolsets: Toolset[]; mcp_servers: McpServer[] }) => void
}

export function ToolsPanel({ profile, readonly, toolsets, mcpServers, onChange }: Props) {
  const [busy, setBusy] = useState<string | null>(null)

  async function flipToolset(t: Toolset) {
    setBusy(`ts:${t.name}`)
    try {
      await toggleToolset(profile, t.name, !t.enabled)
      onChange({
        toolsets: toolsets.map(x => x.name === t.name ? { ...x, enabled: !t.enabled } : x),
        mcp_servers: mcpServers,
      })
    } catch (e) { toast.error(String(e)) } finally { setBusy(null) }
  }

  async function flipMcp(m: McpServer) {
    setBusy(`mcp:${m.name}`)
    try {
      await toggleMcp(profile, m.name, !m.enabled)
      onChange({
        toolsets,
        mcp_servers: mcpServers.map(x => x.name === m.name ? { ...x, enabled: !m.enabled } : x),
      })
    } catch (e) { toast.error(String(e)) } finally { setBusy(null) }
  }

  return (
    <div className="space-y-8">
      <section>
        <h2 className="font-semibold mb-3">内置 Toolsets</h2>
        <div className="grid grid-cols-2 gap-2">
          {toolsets.map(t => (
            <label key={t.name} className="flex items-center justify-between gap-3 border rounded px-3 py-2">
              <span className="text-sm">
                <span className="mr-2">{t.emoji}</span>
                <span className="font-mono">{t.name}</span>
                <span className="ml-2 text-muted-foreground">{t.label}</span>
              </span>
              <Switch checked={t.enabled} disabled={readonly || busy === `ts:${t.name}`} onCheckedChange={() => flipToolset(t)} />
            </label>
          ))}
        </div>
      </section>
      <section>
        <h2 className="font-semibold mb-3">MCP Servers</h2>
        {mcpServers.length === 0 ? <p className="text-sm text-muted-foreground">未注册 MCP server</p> : (
          <div className="space-y-2">
            {mcpServers.map(m => (
              <label key={m.name} className="flex items-center justify-between gap-3 border rounded px-3 py-2">
                <span className="text-sm">
                  <span className="font-mono">{m.name}</span>
                  <span className="ml-2 text-muted-foreground">{m.url}</span>
                </span>
                <Switch checked={m.enabled} disabled={readonly || busy === `mcp:${m.name}`} onCheckedChange={() => flipMcp(m)} />
              </label>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
```

- [ ] **Step 2: Mount in ProfilesClient**

In `ProfilesClient.tsx`:
- Add: `import { ToolsPanel } from './ToolsPanel'`
- Add after the `{tab === 'soul' && ...}` block:
  ```tsx
  {tab === 'tools' && (
    <ToolsPanel
      profile={detail.name}
      readonly={readonly}
      toolsets={detail.toolsets}
      mcpServers={detail.mcp_servers}
      onChange={next => setDetail({ ...detail, ...next })}
    />
  )}
  ```

- [ ] **Step 3: Manual test**

Start backend + frontend. On `wms_writer`, flip `web` toolset → confirm UI reflects, then verify on disk: `grep -A3 "disabled_toolsets" ~/.hermes/profiles/wms_writer/config.yaml`. Flip the `wemedia-studio` MCP → verify either via `hermes mcp list` or by inspecting config.yaml. Flip back. Try toggling on `default` profile → switches disabled.

- [ ] **Step 4: Commit**

```bash
git add wemedia-studio/app/profiles/ToolsPanel.tsx wemedia-studio/app/profiles/ProfilesClient.tsx
git commit -m "feat(profiles): tools + mcp toggle panel"
```

---

## Task 6: Skills panel — read-only listing with grouping + search

**Files:**
- Create: `wemedia-studio/app/profiles/SkillsPanel.tsx`
- Modify: `wemedia-studio/app/profiles/ProfilesClient.tsx`

- [ ] **Step 1: Build SkillsPanel**

```tsx
// wemedia-studio/app/profiles/SkillsPanel.tsx
'use client'

import { useMemo, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Skill } from '@/lib/api/profiles'

interface Props { skills: Skill[] }

export function SkillsPanel({ skills }: Props) {
  const [q, setQ] = useState('')
  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase()
    return term ? skills.filter(s => s.name.toLowerCase().includes(term) || s.category.toLowerCase().includes(term)) : skills
  }, [skills, q])
  const grouped = useMemo(() => {
    const map = new Map<string, Skill[]>()
    for (const s of filtered) {
      const key = s.category || '(uncategorized)'
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(s)
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [filtered])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <Input placeholder="搜索 skill 或 category…" value={q} onChange={e => setQ(e.target.value)} className="max-w-sm" />
        <p className="text-sm text-muted-foreground">
          共 {skills.length} 个 skill · Phase 1 只读，需要切换请运行 <code className="font-mono">hermes skills config</code>
        </p>
      </div>
      <div className="space-y-3">
        {grouped.map(([cat, items]) => (
          <details key={cat} open>
            <summary className="cursor-pointer font-semibold py-1">{cat} <span className="text-muted-foreground font-normal">({items.length})</span></summary>
            <ul className="mt-2 grid grid-cols-3 gap-1 text-sm">
              {items.map(s => (
                <li key={`${cat}/${s.name}`} className="font-mono px-2 py-1 rounded bg-muted/40">
                  {s.enabled ? '✓' : '✗'} {s.name}
                </li>
              ))}
            </ul>
          </details>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Mount in ProfilesClient**

In `ProfilesClient.tsx`:
- Add: `import { SkillsPanel } from './SkillsPanel'`
- Add after the tools-tab block:
  ```tsx
  {tab === 'skills' && <SkillsPanel skills={detail.skills} />}
  ```

- [ ] **Step 3: Manual test**

Open `wms_writer` → Skills tab. Should see ~111 skills grouped by category (`autonomous-ai-agents`, `creative`, etc.). Search "baoyu" → only baoyu-* show. Each row shows ✓ (enabled) or ✗ (disabled).

- [ ] **Step 4: Commit**

```bash
git add wemedia-studio/app/profiles/SkillsPanel.tsx wemedia-studio/app/profiles/ProfilesClient.tsx
git commit -m "feat(profiles): read-only skills listing with search + category grouping"
```

---

## Task 7: End-to-end verification + memory update

- [ ] **Step 1: Run all backend tests**

Run: `conda run -n wems pytest backend/tests/ -v`
Expected: all pass.

- [ ] **Step 2: Walk the page end-to-end**

With backend + frontend running:
1. Navigate `/profiles` from the sidebar → page loads, list shows 6 profiles (default + 5 wms_*).
2. Select `default` → SOUL textarea readonly, save button disabled, switches disabled.
3. Select `wms_writer` → edit a line in SOUL, save, reload page, content persists.
4. Toggle `web` toolset on → off → verify with `HERMES_HOME=~/.hermes/profiles/wms_writer hermes tools list | grep web`.
5. Toggle MCP server `wemedia-studio` and revert.
6. Skills tab: searches and groupings work, count matches `hermes skills list | wc -l`.

- [ ] **Step 3: Update memory index**

Add one line to `/home/violet/.claude/projects/-workspace-projects-WeMediaStudio/memory/MEMORY.md`:
```
- [Profile 管理页面](project_profile_mgmt.md) — /profiles 页面：SOUL 编辑 + toolsets/MCP 开关；skills Phase 1 只读
```
And create `project_profile_mgmt.md` with type `project`, body:
```
/profiles 页面在 wemedia-studio/app/profiles/，后端 backend/routers/profiles.py + backend/profile_manager.py。
SOUL 直接读写文件；toolsets/MCP 通过 `HERMES_HOME=<dir> hermes tools|mcp enable/disable` CLI 修改。
Skills 因 hermes skills 仅有交互式 TUI，Phase 1 只读列表。

**Why:** 用户要求"config.yaml 不直接改，走 CLI"；skills 缺非交互 CLI 所以暂缓写入。
**How to apply:** 加 skills 写入功能时，先确认 hermes 是否新增非交互 flag；否则需 ruamel.yaml 窄补丁 skills.disabled 并在 PR 说明例外原因。
```

- [ ] **Step 4: Final commit**

```bash
git add /home/violet/.claude/projects/-workspace-projects-WeMediaStudio/memory/
git commit -m "docs(memory): record /profiles page architecture"
```

---

## Phase 2 (out of scope, documented for future)

- Per-skill enable/disable: requires either upstream hermes adding a non-interactive `hermes skills enable/disable <name>` flag, or a documented exception to write `config.yaml: skills.disabled` via `ruamel.yaml`.
- Profile lifecycle: create/delete/rename/clone via `hermes profile {create,delete,rename}` CLI.
- `.env` editing UI (API keys per profile).
- Model selection per profile via `hermes config set model.default <model>`.
- MCP server *registration* (currently only enable/disable of pre-registered servers).
