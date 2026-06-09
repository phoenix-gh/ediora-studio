# 项目技能 Per-Profile 安装 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** WeMedia Studio 项目内维护一批 Hermes 技能，通过 Profiles 页面把它们以 symlink 形式按需安装到各 agent 的 `skills/wemedia/` 目录。

**Architecture:** 技能源文件版本化在 `WeMediaStudio/skills/`。后端 `profile_manager.py` 提供扫描/解析/安装/卸载的纯文件系统函数（symlink），通过新的 `skills` router 和 `profiles` router 扩展端点暴露。前端在 Profiles 页面新增「项目技能」tab，列出可用技能并用开关控制安装状态。已安装技能（symlink 在 `skills/wemedia/` 下）会被现有 `_read_skills` 自动识别为 `wemedia` category，照常出现在 SKILLS tab 的 enable/disable 列表中。

**Tech Stack:** FastAPI、Pydantic、pytest（`conda run -n wems`）、Next.js（非标准版本，写前端代码前读 `node_modules/next/dist/docs/`）、shadcn/ui、sonner。

---

## File Structure

| 文件 | 责任 |
|------|------|
| `WeMediaStudio/skills/{skill}/` | 技能源文件（source of truth），从 `~/.hermes/skills/custom/` 迁移 |
| `backend/profile_manager.py` | 新增：`_project_skills_root`、`parse_skill_frontmatter`、`list_project_skills`、`list_project_skills_for_profile`、`install_project_skill`、`uninstall_project_skill` |
| `backend/routers/skills.py` | 新建：`GET /skills/` 列出全部项目技能元数据 |
| `backend/routers/profiles.py` | 扩展：`GET/POST/DELETE /profiles/{name}/project-skills[/{skill}]` |
| `backend/main.py` | 注册 skills router |
| `backend/tests/test_project_skills.py` | 新建：覆盖 profile_manager 新函数 |
| `backend/tests/test_skills_router.py` | 新建：覆盖 router 端点 |
| `wemedia-studio/lib/api/skills.ts` | 新建：项目技能 API 封装 + `ProjectSkill` 类型 |
| `wemedia-studio/app/profiles/ProjectSkillsPanel.tsx` | 新建：安装管理 UI |
| `wemedia-studio/app/profiles/ProfilesClient.tsx` | 扩展：新增 `project` tab |

**关键复用：** `profile_manager.py` 已有 `_hermes_root()`（env `HERMES_HOME_ROOT` override）、`_profile_dir()`、`_safe_name()`、`_NAME_RE`、`import yaml`。新代码沿用这些。`_read_skills`（:132）已遍历 category 子目录，无需改动。

---

## Task 1: 迁移现有技能到项目目录

把 `~/.hermes/skills/custom/` 下 5 个技能复制进项目，作为 source of truth。用 cp 保留原件（`codex_imagegen` 仍被 `profile_manager.py:328` 的 avatar 逻辑按旧路径引用，本次不动）。

**Files:**
- Create: `WeMediaStudio/skills/article-drafting/`、`content-ideation/`、`x-post/`、`cover-image/`、`codex_imagegen/`

- [ ] **Step 1: 复制技能目录**

```bash
cd /workspace/projects/WeMediaStudio
mkdir -p skills
for s in article-drafting content-ideation x-post cover-image codex_imagegen; do
  cp -r "$HOME/.hermes/skills/custom/$s" "skills/$s"
done
```

- [ ] **Step 2: 验证每个技能都有 SKILL.md**

Run:
```bash
for s in article-drafting content-ideation x-post cover-image codex_imagegen; do
  test -f "skills/$s/SKILL.md" && echo "OK $s" || echo "MISSING $s"
done
```
Expected: 5 行全部 `OK`

- [ ] **Step 3: Commit**

```bash
git add skills/
git commit -m "feat(skills): 迁移 custom 技能到项目目录作为 source of truth"
```

---

## Task 2: 后端 — frontmatter 解析 + 项目技能列表

**Files:**
- Modify: `backend/profile_manager.py`（在 `_hermes_root` 之后、`list_profiles` 之前插入新函数）
- Test: `backend/tests/test_project_skills.py`

- [ ] **Step 1: 写失败测试**

Create `backend/tests/test_project_skills.py`:

```python
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && conda run -n wems python -m pytest tests/test_project_skills.py -v`
Expected: FAIL（`ImportError: cannot import name 'parse_skill_frontmatter'`）

- [ ] **Step 3: 实现函数**

在 `backend/profile_manager.py` 中 `_hermes_root()` 函数之后插入：

```python
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd backend && conda run -n wems python -m pytest tests/test_project_skills.py -v`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add backend/profile_manager.py backend/tests/test_project_skills.py
git commit -m "feat(skills): 项目技能 frontmatter 解析与扫描"
```

---

## Task 3: 后端 — 安装/卸载/per-profile 状态

**Files:**
- Modify: `backend/profile_manager.py`（接在 Task 2 新增函数之后）
- Test: `backend/tests/test_project_skills.py`（追加）

- [ ] **Step 1: 写失败测试**

在 `backend/tests/test_project_skills.py` 末尾追加：

```python
from profile_manager import (
    list_project_skills_for_profile,
    install_project_skill,
    uninstall_project_skill,
)


def _fixture(tmp_path):
    skills_root = tmp_path / "skills"
    _make_skill(skills_root, "x-post", description="推文")
    _make_skill(skills_root, "content-ideation", description="选题")
    home = tmp_path / "hermes"
    (home / "profiles" / "wms_writer").mkdir(parents=True)
    (home / "profiles" / "wms_writer" / "config.yaml").write_text("model:\n  default: m\n")
    return skills_root, home


def test_install_creates_symlink(tmp_path, monkeypatch):
    skills_root, home = _fixture(tmp_path)
    monkeypatch.setenv("WEMS_SKILLS_ROOT", str(skills_root))
    monkeypatch.setenv("HERMES_HOME_ROOT", str(home))
    install_project_skill("wms_writer", "x-post")
    link = home / "profiles" / "wms_writer" / "skills" / "wemedia" / "x-post"
    assert link.is_symlink()
    assert link.resolve() == (skills_root / "x-post").resolve()


def test_install_is_idempotent(tmp_path, monkeypatch):
    skills_root, home = _fixture(tmp_path)
    monkeypatch.setenv("WEMS_SKILLS_ROOT", str(skills_root))
    monkeypatch.setenv("HERMES_HOME_ROOT", str(home))
    install_project_skill("wms_writer", "x-post")
    install_project_skill("wms_writer", "x-post")  # no raise
    link = home / "profiles" / "wms_writer" / "skills" / "wemedia" / "x-post"
    assert link.is_symlink()


def test_install_refuses_to_overwrite_real_dir(tmp_path, monkeypatch):
    skills_root, home = _fixture(tmp_path)
    monkeypatch.setenv("WEMS_SKILLS_ROOT", str(skills_root))
    monkeypatch.setenv("HERMES_HOME_ROOT", str(home))
    real = home / "profiles" / "wms_writer" / "skills" / "wemedia" / "x-post"
    real.mkdir(parents=True)
    with pytest.raises(RuntimeError):
        install_project_skill("wms_writer", "x-post")


def test_install_missing_skill_raises(tmp_path, monkeypatch):
    skills_root, home = _fixture(tmp_path)
    monkeypatch.setenv("WEMS_SKILLS_ROOT", str(skills_root))
    monkeypatch.setenv("HERMES_HOME_ROOT", str(home))
    with pytest.raises(FileNotFoundError):
        install_project_skill("wms_writer", "does-not-exist")


def test_install_default_profile_forbidden(tmp_path, monkeypatch):
    skills_root, home = _fixture(tmp_path)
    monkeypatch.setenv("WEMS_SKILLS_ROOT", str(skills_root))
    monkeypatch.setenv("HERMES_HOME_ROOT", str(home))
    with pytest.raises(PermissionError):
        install_project_skill("default", "x-post")


def test_uninstall_removes_symlink(tmp_path, monkeypatch):
    skills_root, home = _fixture(tmp_path)
    monkeypatch.setenv("WEMS_SKILLS_ROOT", str(skills_root))
    monkeypatch.setenv("HERMES_HOME_ROOT", str(home))
    install_project_skill("wms_writer", "x-post")
    uninstall_project_skill("wms_writer", "x-post")
    link = home / "profiles" / "wms_writer" / "skills" / "wemedia" / "x-post"
    assert not link.is_symlink()
    assert not link.exists()


def test_uninstall_idempotent_when_absent(tmp_path, monkeypatch):
    skills_root, home = _fixture(tmp_path)
    monkeypatch.setenv("WEMS_SKILLS_ROOT", str(skills_root))
    monkeypatch.setenv("HERMES_HOME_ROOT", str(home))
    uninstall_project_skill("wms_writer", "x-post")  # no raise


def test_uninstall_refuses_real_dir(tmp_path, monkeypatch):
    skills_root, home = _fixture(tmp_path)
    monkeypatch.setenv("WEMS_SKILLS_ROOT", str(skills_root))
    monkeypatch.setenv("HERMES_HOME_ROOT", str(home))
    real = home / "profiles" / "wms_writer" / "skills" / "wemedia" / "x-post"
    real.mkdir(parents=True)
    with pytest.raises(RuntimeError):
        uninstall_project_skill("wms_writer", "x-post")


def test_list_for_profile_marks_installed(tmp_path, monkeypatch):
    skills_root, home = _fixture(tmp_path)
    monkeypatch.setenv("WEMS_SKILLS_ROOT", str(skills_root))
    monkeypatch.setenv("HERMES_HOME_ROOT", str(home))
    install_project_skill("wms_writer", "x-post")
    rows = list_project_skills_for_profile("wms_writer")
    by_name = {r["name"]: r for r in rows}
    assert by_name["x-post"]["installed"] is True
    assert by_name["content-ideation"]["installed"] is False
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && conda run -n wems python -m pytest tests/test_project_skills.py -v`
Expected: FAIL（`ImportError: cannot import name 'install_project_skill'`）

- [ ] **Step 3: 实现函数**

在 `backend/profile_manager.py` 中 `list_project_skills()` 之后插入：

```python
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd backend && conda run -n wems python -m pytest tests/test_project_skills.py -v`
Expected: 13 passed

- [ ] **Step 5: Commit**

```bash
git add backend/profile_manager.py backend/tests/test_project_skills.py
git commit -m "feat(skills): per-profile 安装/卸载 symlink + 安装状态"
```

---

## Task 4: 后端 — skills router + profiles 端点 + 注册

**Files:**
- Create: `backend/routers/skills.py`
- Modify: `backend/routers/profiles.py`（在文件末尾 `post_mcp` 之后追加端点）
- Modify: `backend/main.py:13`（import）和 `:81` 之后（include_router）
- Test: `backend/tests/test_skills_router.py`

- [ ] **Step 1: 写失败测试**

Create `backend/tests/test_skills_router.py`:

```python
from pathlib import Path
import pytest
from fastapi.testclient import TestClient


def _make_skill(root: Path, name: str, description=""):
    d = root / name
    d.mkdir(parents=True)
    (d / "SKILL.md").write_text(
        f'---\nname: {name}\ndescription: "{description}"\nversion: 1.0.0\n---\n# {name}\n',
        encoding="utf-8",
    )


@pytest.fixture
def client(tmp_path, monkeypatch):
    skills_root = tmp_path / "skills"
    _make_skill(skills_root, "x-post", "推文")
    _make_skill(skills_root, "content-ideation", "选题")
    home = tmp_path / "hermes"
    (home / "profiles" / "wms_writer").mkdir(parents=True)
    (home / "profiles" / "wms_writer" / "config.yaml").write_text("model:\n  default: m\n")
    monkeypatch.setenv("WEMS_SKILLS_ROOT", str(skills_root))
    monkeypatch.setenv("HERMES_HOME_ROOT", str(home))
    from main import app
    return TestClient(app)


def test_list_all_skills(client):
    r = client.get("/api/skills")
    assert r.status_code == 200
    names = [s["name"] for s in r.json()["skills"]]
    assert names == ["content-ideation", "x-post"]


def test_list_profile_skills_default_uninstalled(client):
    r = client.get("/api/profiles/wms_writer/project-skills")
    assert r.status_code == 200
    rows = {s["name"]: s for s in r.json()["skills"]}
    assert rows["x-post"]["installed"] is False


def test_install_then_uninstall_roundtrip(client):
    r = client.post("/api/profiles/wms_writer/project-skills/x-post")
    assert r.status_code == 200
    r = client.get("/api/profiles/wms_writer/project-skills")
    rows = {s["name"]: s for s in r.json()["skills"]}
    assert rows["x-post"]["installed"] is True
    r = client.delete("/api/profiles/wms_writer/project-skills/x-post")
    assert r.status_code == 204
    r = client.get("/api/profiles/wms_writer/project-skills")
    rows = {s["name"]: s for s in r.json()["skills"]}
    assert rows["x-post"]["installed"] is False


def test_install_missing_skill_404(client):
    r = client.post("/api/profiles/wms_writer/project-skills/nope")
    assert r.status_code == 404


def test_install_default_profile_403(client):
    r = client.post("/api/profiles/default/project-skills/x-post")
    assert r.status_code == 403
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && conda run -n wems python -m pytest tests/test_skills_router.py -v`
Expected: FAIL（`404` on `/api/skills` — router 未注册）

- [ ] **Step 3: 创建 skills router**

Create `backend/routers/skills.py`:

```python
from fastapi import APIRouter

import profile_manager as pm

router = APIRouter(prefix="/skills", tags=["skills"])


@router.get("")
def list_skills():
    """All project skills available to install (metadata only)."""
    return {"skills": pm.list_project_skills()}
```

- [ ] **Step 4: 扩展 profiles router**

在 `backend/routers/profiles.py` 末尾（`post_mcp` 函数之后）追加：

```python
@router.get("/{name}/project-skills")
def get_project_skills(name: str):
    try:
        return {"skills": pm.list_project_skills_for_profile(name)}
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/{name}/project-skills/{skill}")
def post_project_skill(name: str, skill: str):
    try:
        pm.install_project_skill(name, skill)
        return {"ok": True}
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except RuntimeError as e:
        raise HTTPException(409, str(e))


@router.delete("/{name}/project-skills/{skill}", status_code=204)
def delete_project_skill(name: str, skill: str):
    try:
        pm.uninstall_project_skill(name, skill)
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except RuntimeError as e:
        raise HTTPException(409, str(e))
```

- [ ] **Step 5: 注册 router**

`backend/main.py:13` 在 import 行末尾追加 `, skills`：

```python
from routers import accounts, collect, settings, github, x, papers, personas, upload, drafts, writing_plans, synthesize, youtube, producthunt, wechat, v2ex, kr, juejin, studio, publish_accounts, profiles, reddit, topic_generator, retro, materials, skills
```

在 `backend/main.py` 的 `app.include_router(materials.router, prefix="/api")` 之后追加：

```python
app.include_router(skills.router, prefix="/api")
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd backend && conda run -n wems python -m pytest tests/test_skills_router.py -v`
Expected: 5 passed

- [ ] **Step 7: 全后端测试回归**

Run: `cd backend && conda run -n wems python -m pytest tests/test_project_skills.py tests/test_skills_router.py tests/test_profile_manager.py tests/test_profiles_router.py -v`
Expected: 全部 passed

- [ ] **Step 8: Commit**

```bash
git add backend/routers/skills.py backend/routers/profiles.py backend/main.py backend/tests/test_skills_router.py
git commit -m "feat(skills): skills router + profiles 项目技能端点"
```

---

## Task 5: 前端 — API 封装

**Files:**
- Create: `wemedia-studio/lib/api/skills.ts`

- [ ] **Step 1: 创建 API 封装**

Create `wemedia-studio/lib/api/skills.ts`:

```typescript
import { apiFetch } from './client'

export interface ProjectSkill {
  name: string
  description: string
  version: string
  tags: string[]
  installed: boolean
}

export const listProjectSkills = (profile: string) =>
  apiFetch<{ skills: ProjectSkill[] }>(
    `/profiles/${encodeURIComponent(profile)}/project-skills`,
  ).then(r => r.skills)

export const installProjectSkill = (profile: string, skill: string) =>
  apiFetch<{ ok: boolean }>(
    `/profiles/${encodeURIComponent(profile)}/project-skills/${encodeURIComponent(skill)}`,
    { method: 'POST' },
  )

export const uninstallProjectSkill = (profile: string, skill: string) =>
  apiFetch<void>(
    `/profiles/${encodeURIComponent(profile)}/project-skills/${encodeURIComponent(skill)}`,
    { method: 'DELETE' },
  )
```

- [ ] **Step 2: 类型检查**

Run: `cd wemedia-studio && npx tsc --noEmit`
Expected: 无错误（无输出）

- [ ] **Step 3: Commit**

```bash
git add wemedia-studio/lib/api/skills.ts
git commit -m "feat(skills): 前端项目技能 API 封装"
```

---

## Task 6: 前端 — ProjectSkillsPanel + tab 集成

**Files:**
- Create: `wemedia-studio/app/profiles/ProjectSkillsPanel.tsx`
- Modify: `wemedia-studio/app/profiles/ProfilesClient.tsx`

- [ ] **Step 1: 创建 ProjectSkillsPanel 组件**

Create `wemedia-studio/app/profiles/ProjectSkillsPanel.tsx`:

```tsx
'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Switch } from '@/components/ui/switch'
import {
  type ProjectSkill,
  listProjectSkills,
  installProjectSkill,
  uninstallProjectSkill,
} from '@/lib/api/skills'

interface Props {
  profile: string
  readonly: boolean
}

export function ProjectSkillsPanel({ profile, readonly }: Props) {
  const [skills, setSkills] = useState<ProjectSkill[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let ignore = false
    setLoading(true)
    listProjectSkills(profile)
      .then(rows => { if (!ignore) setSkills(rows) })
      .catch(e => { if (!ignore) toast.error(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (!ignore) setLoading(false) })
    return () => { ignore = true }
  }, [profile])

  async function flip(s: ProjectSkill) {
    setBusy(s.name)
    const next = !s.installed
    try {
      if (next) await installProjectSkill(profile, s.name)
      else await uninstallProjectSkill(profile, s.name)
      setSkills(prev => prev.map(x => (x.name === s.name ? { ...x, installed: next } : x)))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  if (loading) return <p className="text-sm text-muted-foreground">加载中…</p>
  if (skills.length === 0)
    return <p className="text-sm text-muted-foreground">项目暂无可安装技能（WeMediaStudio/skills/）</p>

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        来自 WeMediaStudio/skills/ · 安装后 symlink 到该 profile 的 skills/wemedia/
      </p>
      <ul className="space-y-2">
        {skills.map(s => (
          <li
            key={s.name}
            className="flex items-start justify-between gap-4 border rounded px-4 py-3"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm font-medium">{s.name}</span>
                {s.version && <span className="text-xs text-muted-foreground">v{s.version}</span>}
              </div>
              {s.description && (
                <p className="text-sm text-muted-foreground mt-0.5">{s.description}</p>
              )}
              {s.tags.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {s.tags.map(t => (
                    <span key={t} className="text-xs bg-muted px-1.5 py-0.5 rounded">
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <Switch
              checked={s.installed}
              disabled={readonly || busy === s.name}
              onCheckedChange={() => flip(s)}
            />
          </li>
        ))}
      </ul>
    </div>
  )
}
```

- [ ] **Step 2: 在 ProfilesClient 集成 tab**

`wemedia-studio/app/profiles/ProfilesClient.tsx` 改动：

(a) import 段（`:15` `import { SkillsPanel }` 之后）加：
```tsx
import { ProjectSkillsPanel } from './ProjectSkillsPanel'
```

(b) tab state 类型（`:23`）扩展：
```tsx
  const [tab, setTab] = useState<'soul' | 'tools' | 'skills' | 'project'>('soul')
```

(c) 在 `:101` 的 `<div className="border-b mb-4 flex gap-4">` 之前插入 label map：
```tsx
            {/* tab labels: 内置 toolset 用英文，项目技能用中文 */}
```
并把 tab 渲染块（`:102-116`）替换为：
```tsx
            <div className="border-b mb-4 flex gap-4">
              {(['soul', 'tools', 'skills', 'project'] as const).map(t => (
                <button
                  key={t}
                  className={`pb-2 text-sm ${
                    tab === t
                      ? 'border-b-2 border-primary font-medium'
                      : 'text-muted-foreground'
                  }`}
                  onClick={() => setTab(t)}
                >
                  {t === 'project' ? '项目技能' : t.toUpperCase()}
                </button>
              ))}
            </div>
```

(d) 在 `:134-141` 的 `{tab === 'skills' && (...)}` 块之后插入：
```tsx
            {tab === 'project' && (
              <ProjectSkillsPanel profile={detail.name} readonly={readonly} />
            )}
```

- [ ] **Step 3: 类型检查**

Run: `cd wemedia-studio && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 4: 手动验证**

启动后端与前端（按项目 `dev.sh` 或既有方式），打开 Profiles 页面：
1. 选一个非 default profile（如 wms_writer）
2. 点「项目技能」tab → 看到 5 个技能列表，开关均为 off
3. 打开 `x-post` 开关 → toast 无错误；终端验证：
   ```bash
   ls -la "$HOME/.hermes/profiles/wms_writer/skills/wemedia/"
   ```
   应看到 `x-post -> /workspace/projects/WeMediaStudio/skills/x-post`
4. 切到 SKILLS tab → `wemedia` category 下出现 `x-post`（可 enable/disable）
5. 回「项目技能」tab，关闭 `x-post` 开关 → symlink 消失

- [ ] **Step 5: Commit**

```bash
git add wemedia-studio/app/profiles/ProjectSkillsPanel.tsx wemedia-studio/app/profiles/ProfilesClient.tsx
git commit -m "feat(skills): Profiles 页面项目技能安装 tab"
```

---

## Self-Review

**Spec coverage:**
- 目录结构（项目侧 + Hermes 侧 wemedia 命名空间）→ Task 1 + Task 3 ✅
- `GET /skills/` → Task 4 ✅
- `GET/POST/DELETE /profiles/{name}/project-skills` → Task 4 ✅
- frontmatter 解析（name/description/version/tags）→ Task 2 ✅
- symlink 安装逻辑 + 不覆盖非 symlink → Task 3 ✅
- 前端集成到 Profiles 页面 → Task 6 ✅
- 迁移 5 个技能 → Task 1 ✅
- Out of scope（全局 wems/ 分类、SKILL.md 编辑器、新建向导）→ 未触及 ✅

**Type consistency:** `install_project_skill`/`uninstall_project_skill`/`list_project_skills_for_profile`/`list_project_skills`/`parse_skill_frontmatter`/`_project_skills_root` 在 Task 2/3 定义，Task 4 router 与测试一致引用。前端 `ProjectSkill`、`listProjectSkills`、`installProjectSkill`、`uninstallProjectSkill` 在 Task 5 定义，Task 6 一致引用。HTTP 状态码：安装冲突用 409（非 spec 明示，但比 502 更准确，已在 router 与测试对齐）。

**Placeholder scan:** 无 TBD/TODO；所有步骤含完整代码与可运行命令。

**已知注意点（非阻塞）：** `codex_imagegen` 同时存在于 `~/.hermes/skills/custom/`（被 `profile_manager.py:328` avatar 逻辑引用）和新的项目目录；本次保留旧路径不动。若后续清理 custom，需先把该引用改指向项目目录或已安装的 profile 路径。
