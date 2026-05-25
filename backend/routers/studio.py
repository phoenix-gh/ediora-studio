"""
Studio router — Hermes Kanban workshop visualization.

Exposes an aggregated agent-centric view of the Kanban board so the frontend
can render the "pixel newsroom" without knowing about Hermes internals.

Reads board state by shelling out to `hermes kanban list --json`. That's a few
hundred ms of overhead per call; we cache the snapshot for 1.5s so polling
from the UI is cheap.
"""

import asyncio
import json
import os
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/studio", tags=["studio"])

# (profile_name, display_name, role, accent_color)
AGENTS: list[tuple[str, str, str, str]] = [
    ("wms_scout",       "信号探子",   "scout",       "amber"),
    ("wms_editor",      "策划编辑",   "editor",      "indigo"),
    ("wms_writer",      "撰稿人",     "writer",      "emerald"),
    ("wms_illustrator", "封面设计师", "illustrator", "violet"),
    ("wms_critic",      "终审编辑",   "critic",      "rose"),
]

def _resolve_hermes_bin() -> str:
    """uvloop's subprocess_exec doesn't do PATH lookup, so resolve once."""
    found = shutil.which("hermes")
    if found:
        return found
    candidate = Path.home() / ".local" / "bin" / "hermes"
    if candidate.exists():
        return str(candidate)
    return "hermes"  # last resort; will surface FileNotFoundError to client


_HERMES_BIN = _resolve_hermes_bin()
# Pin the kanban board so /studio always reads the right data even if the user
# switches boards via CLI. Default: 'test'. Override with WMS_STUDIO_BOARD env.
_KANBAN_BOARD = os.environ.get("WMS_STUDIO_BOARD", "test")
_CACHE_TTL_S = 1.5
_cache: dict[str, object] = {"at": 0.0, "data": None}


class TaskBrief(BaseModel):
    id: str
    title: str
    status: str
    assignee: str
    created_at: int
    started_at: Optional[int] = None
    completed_at: Optional[int] = None
    workspace_path: Optional[str] = None


class TaskComment(BaseModel):
    author: str
    body: str
    created_at: int


class TaskEvent(BaseModel):
    kind: str
    payload: Optional[dict] = None
    created_at: int
    run_id: Optional[int] = None


class TaskRun(BaseModel):
    run_id: Optional[int] = None
    outcome: Optional[str] = None
    summary: Optional[str] = None
    started_at: Optional[int] = None
    completed_at: Optional[int] = None
    elapsed_seconds: Optional[int] = None


class TaskDetail(BaseModel):
    task: dict
    latest_summary: Optional[str] = None
    parents: list[str] = []
    children: list[str] = []
    comments: list[TaskComment] = []
    events: list[TaskEvent] = []
    runs: list[TaskRun] = []


AgentStatus = Literal["idle", "working", "waiting", "blocked"]


class AgentState(BaseModel):
    name: str
    display_name: str
    role: str
    accent: str
    status: AgentStatus
    current_task: Optional[TaskBrief] = None
    waiting_count: int = 0
    completed_today: int = 0
    elapsed_seconds: Optional[int] = None  # since current_task.started_at


class BoardSnapshot(BaseModel):
    agents: list[AgentState]
    counts: dict[str, int]
    recent_tasks: list[TaskBrief]
    server_time: int


async def _fetch_task_detail(task_id: str) -> dict:
    env = {**os.environ, "HERMES_KANBAN_BOARD": _KANBAN_BOARD}
    proc = await asyncio.create_subprocess_exec(
        _HERMES_BIN, "kanban", "show", task_id, "--json",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )
    out, err = await proc.communicate()
    if proc.returncode != 0:
        msg = (err.decode() or "").strip()[:200]
        if "not found" in msg.lower() or "no such" in msg.lower():
            raise HTTPException(404, f"task {task_id} not found")
        raise HTTPException(503, f"hermes kanban show failed: {msg}")
    raw = out.decode().strip() or "{}"
    return json.loads(raw)


async def _fetch_board() -> list[dict]:
    env = {**os.environ, "HERMES_KANBAN_BOARD": _KANBAN_BOARD}
    proc = await asyncio.create_subprocess_exec(
        _HERMES_BIN, "kanban", "list",
        "--archived", "--json", "--sort", "created-desc",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )
    out, err = await proc.communicate()
    if proc.returncode != 0:
        raise HTTPException(503, f"hermes kanban list failed: {err.decode()[:200]}")
    raw = out.decode().strip() or "[]"
    return json.loads(raw)


def _to_brief(task: dict) -> TaskBrief:
    return TaskBrief(
        id=task["id"],
        title=task.get("title", "(untitled)"),
        status=task.get("status", "unknown"),
        assignee=task.get("assignee") or "",
        created_at=task.get("created_at", 0),
        started_at=task.get("started_at"),
        completed_at=task.get("completed_at"),
        workspace_path=task.get("workspace_path"),
    )


@router.get("/board", response_model=BoardSnapshot)
async def get_board():
    now_ts = time.time()
    if _cache["data"] is not None and now_ts - float(_cache["at"]) < _CACHE_TTL_S:
        return _cache["data"]  # type: ignore[return-value]

    tasks = await _fetch_board()

    by_assignee: dict[str, list[dict]] = {}
    for t in tasks:
        by_assignee.setdefault(t.get("assignee") or "", []).append(t)

    counts: dict[str, int] = {"triage": 0, "todo": 0, "ready": 0,
                              "running": 0, "blocked": 0, "done": 0,
                              "scheduled": 0, "archived": 0, "review": 0}
    for t in tasks:
        s = t.get("status", "")
        counts[s] = counts.get(s, 0) + 1

    now_utc = datetime.now(timezone.utc)
    today_start = int(datetime(
        now_utc.year, now_utc.month, now_utc.day, tzinfo=timezone.utc
    ).timestamp())

    agents: list[AgentState] = []
    for name, display, role, accent in AGENTS:
        owned = by_assignee.get(name, [])

        running = next((t for t in owned if t.get("status") == "running"), None)
        blocked = next((t for t in owned if t.get("status") == "blocked"), None)
        ready   = next((t for t in owned if t.get("status") == "ready"), None)
        todo    = next((t for t in owned if t.get("status") == "todo"), None)

        waiting_count = sum(1 for t in owned if t.get("status") in ("ready", "todo"))
        completed_today = sum(
            1 for t in owned
            if t.get("completed_at") and t["completed_at"] >= today_start
        )

        if running:
            current = running
            status: AgentStatus = "working"
        elif blocked:
            current = blocked
            status = "blocked"
        elif ready or todo:
            current = ready or todo
            status = "waiting"
        else:
            current = None
            status = "idle"

        elapsed = None
        if current and current.get("started_at"):
            elapsed = max(0, int(now_ts) - int(current["started_at"]))

        agents.append(AgentState(
            name=name,
            display_name=display,
            role=role,
            accent=accent,
            status=status,
            current_task=_to_brief(current) if current else None,
            waiting_count=waiting_count,
            completed_today=completed_today,
            elapsed_seconds=elapsed,
        ))

    recent_briefs = [_to_brief(t) for t in tasks[:25]]

    snapshot = BoardSnapshot(
        agents=agents,
        counts=counts,
        recent_tasks=recent_briefs,
        server_time=int(now_ts),
    )
    _cache["at"] = now_ts
    _cache["data"] = snapshot
    return snapshot


class EnqueueIn(BaseModel):
    account_id: str
    title: str
    source_url: str
    platform: str = ""
    summary: str = ""
    note: str = ""
    content: str = ""


_ENQUEUE_CONTENT_CAP = 30000


class EnqueueOut(BaseModel):
    task_id: str
    task_ids: list[str] = []


async def _kanban_create(title: str, assignee: str, body: str,
                         parent: Optional[str], env: dict) -> str:
    cmd = [
        _HERMES_BIN, "kanban", "create", title,
        "--assignee", assignee,
        "--body", body,
        "--created-by", "studio-push",
        "--json",
    ]
    if parent:
        cmd += ["--parent", parent]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )
    out, err = await proc.communicate()
    if proc.returncode != 0:
        raise HTTPException(503, f"hermes kanban create ({assignee}) failed: {err.decode()[:300]}")
    try:
        data = json.loads(out.decode().strip() or "{}")
    except json.JSONDecodeError:
        raise HTTPException(503, f"hermes returned non-JSON for {assignee}")
    tid = data.get("id") or data.get("task_id") or (data.get("task") or {}).get("id")
    if not tid:
        raise HTTPException(503, f"hermes returned no task id for {assignee}")
    return tid


@router.post("/enqueue", response_model=EnqueueOut)
async def enqueue_scout_task(payload: EnqueueIn):
    """Create the full scout→editor→writer→illustrator task chain on the kanban
    board. Each step is linked to the previous via --parent so the dispatcher
    auto-promotes downstream tasks as each step completes.
    """
    if not payload.account_id.strip():
        raise HTTPException(400, "account_id is required")
    if not payload.source_url.strip() or not payload.title.strip():
        raise HTTPException(400, "title and source_url are required")

    from database import SessionLocal
    from models import PublishAccount, PipelineTask
    from pipeline_template import get_pipeline

    async with SessionLocal() as db:
        acc = await db.get(PublishAccount, payload.account_id)
    if acc is None:
        raise HTTPException(400, f"account '{payload.account_id}' not found")

    account_profile = {
        "name": acc.name,
        "platform": acc.platform,
        "positioning": acc.positioning,
        "audience": acc.audience,
        "tone": acc.tone,
        "topic_focus": acc.topic_focus or [],
        "taboo": acc.taboo or [],
        "word_range": acc.word_range or {},
        "image_style": acc.image_style,
        "cover_style": acc.cover_style or {},
        "voice_samples": acc.voice_samples or [],
        "style_rules": acc.style_rules or [],
    }

    content = (payload.content or "").strip()
    truncated = len(content) > _ENQUEUE_CONTENT_CAP
    if truncated:
        content = content[:_ENQUEUE_CONTENT_CAP]

    # Create PipelineTask record first to get an ID for the writer to reference.
    async with SessionLocal() as db:
        pt = PipelineTask(
            account_id=payload.account_id,
            title=payload.title,
            source_url=payload.source_url,
            task_ids={},
        )
        db.add(pt)
        await db.commit()
        await db.refresh(pt)
        pipeline_task_id = pt.id

    ctx = {
        "title": payload.title,
        "account_id": payload.account_id,
        "account_profile": account_profile,
        "platform": payload.platform or "unknown",
        "source_url": payload.source_url,
        "summary": payload.summary or "",
        "content": content,
        "content_truncated": truncated,
        "note": payload.note or "",
        "draft_id": 0,
        "pipeline_task_id": pipeline_task_id,
    }

    steps = get_pipeline("full")
    env = {**os.environ, "HERMES_KANBAN_BOARD": _KANBAN_BOARD}
    task_id_list: list[str] = []

    for step in steps:
        tid = await _kanban_create(
            title=step.title(ctx),
            assignee=step.assignee,
            body=step.body(ctx),
            parent=task_id_list[-1] if task_id_list else None,
            env=env,
        )
        task_id_list.append(tid)

    # Back-fill task_ids JSON into the PipelineTask record.
    task_ids_map = {steps[i].role: task_id_list[i] for i in range(len(task_id_list))}
    async with SessionLocal() as db:
        pt2 = await db.get(PipelineTask, pipeline_task_id)
        if pt2 is not None:
            pt2.task_ids = task_ids_map
            await db.commit()

    _cache["data"] = None
    return EnqueueOut(task_id=task_id_list[0], task_ids=task_id_list)


class RegenerateCoverIn(BaseModel):
    draft_id: int
    account_id: str
    note: str = ""
    cover_style: dict | None = None


@router.post("/regenerate-cover", response_model=EnqueueOut)
async def regenerate_cover(payload: RegenerateCoverIn):
    """Spawn a wms_illustrator task to (re)generate a cover image for an
    existing draft. The illustrator reads the draft + account profile and
    uploads a new cover.* image to the draft's image library.
    """
    if not payload.account_id.strip():
        raise HTTPException(400, "account_id is required")
    if payload.draft_id <= 0:
        raise HTTPException(400, "draft_id is required")

    # Look up account + pipeline lineage:
    #   - parent = writer (preferred) / editor / scout → illustrator inherits
    #     brief and draft metadata via `worker_context.parents[0]`.
    #   - diff payload.cover_style against account default so the body
    #     template only sees keys the user actually overrode.
    from database import SessionLocal
    from models import PipelineTask, PublishAccount
    from pipeline_template import get_pipeline
    from sqlalchemy import select as sa_select
    async with SessionLocal() as db:
        acc = await db.get(PublishAccount, payload.account_id)
        res = await db.execute(
            sa_select(PipelineTask).where(PipelineTask.draft_id == payload.draft_id).limit(1)
        )
        pt = res.scalar_one_or_none()
    if acc is None:
        raise HTTPException(400, f"account '{payload.account_id}' not found")
    parent_task_id: Optional[str] = None
    if pt is not None:
        ids = pt.task_ids or {}
        parent_task_id = ids.get("writer") or ids.get("editor") or ids.get("scout")

    cover_style_diff: dict = {}
    if payload.cover_style:
        acc_style = acc.cover_style or {}
        cover_style_diff = {
            k: v for k, v in payload.cover_style.items() if v != acc_style.get(k)
        }

    account_profile = {
        "name": acc.name,
        "platform": acc.platform,
        "image_style": acc.image_style,
        "cover_style": acc.cover_style or {},
    }
    ctx = {
        "draft_id": payload.draft_id,
        "account_id": payload.account_id,
        "account_profile": account_profile,
        "run_id": None,
        "note": payload.note or "",
        "cover_style_override": cover_style_diff or None,
    }
    step = get_pipeline("cover_only")[0]
    env = {**os.environ, "HERMES_KANBAN_BOARD": _KANBAN_BOARD}
    task_id = await _kanban_create(
        title=step.title(ctx),
        assignee=step.assignee,
        body=step.body(ctx),
        parent=parent_task_id,
        env=env,
    )
    await _append_pipeline_extra(payload.draft_id, "illustrator", task_id)
    _cache["data"] = None
    return EnqueueOut(task_id=task_id)


class RewriteDraftIn(BaseModel):
    draft_id: int
    note: str = ""


@router.post("/rewrite-draft", response_model=EnqueueOut)
async def rewrite_draft(payload: RewriteDraftIn):
    """Spawn a wms_writer task to rewrite an existing draft, inheriting the
    original editor task as parent so brief_md / core_point are reused.
    """
    if payload.draft_id <= 0:
        raise HTTPException(400, "draft_id is required")

    from database import SessionLocal
    from models import ArticleDraft, PipelineTask, PublishAccount
    from pipeline_template import get_pipeline
    from sqlalchemy import select as sa_select

    async with SessionLocal() as db:
        draft = await db.get(ArticleDraft, payload.draft_id)
        if draft is None:
            raise HTTPException(404, f"draft #{payload.draft_id} not found")
        res = await db.execute(
            sa_select(PipelineTask).where(PipelineTask.draft_id == payload.draft_id).limit(1)
        )
        pt = res.scalar_one_or_none()
        if pt is None:
            raise HTTPException(400, "this draft has no pipeline run; can't rewrite via pipeline")
        editor_task_id = (pt.task_ids or {}).get("editor")
        if not editor_task_id:
            raise HTTPException(400, "original editor task not found; can't inherit brief context")
        account_id = pt.account_id
        acc = await db.get(PublishAccount, account_id)
    if acc is None:
        raise HTTPException(400, f"account '{account_id}' not found")

    account_profile = {
        "name": acc.name,
        "platform": acc.platform,
        "positioning": acc.positioning,
        "audience": acc.audience,
        "tone": acc.tone,
        "topic_focus": acc.topic_focus or [],
        "taboo": acc.taboo or [],
        "word_range": acc.word_range or {},
        "image_style": acc.image_style,
        "cover_style": acc.cover_style or {},
        "voice_samples": acc.voice_samples or [],
        "style_rules": acc.style_rules or [],
    }

    ctx = {
        "draft_id": payload.draft_id,
        "account_id": account_id,
        "account_profile": account_profile,
        "title": draft.title or pt.title or f"draft #{payload.draft_id}",
        "note": payload.note or "",
    }

    step = get_pipeline("rewrite_only")[0]
    env = {**os.environ, "HERMES_KANBAN_BOARD": _KANBAN_BOARD}
    tid = await _kanban_create(
        title=step.title(ctx),
        assignee=step.assignee,
        body=step.body(ctx),
        parent=editor_task_id,
        env=env,
    )
    await _append_pipeline_extra(payload.draft_id, "writer", tid)
    _cache["data"] = None
    return EnqueueOut(task_id=tid)


@router.delete("/tasks/{task_id}")
async def delete_task(task_id: str):
    """Archive a kanban task (hermes has no hard-delete; archive is permanent removal from active views)."""
    env = {**os.environ, "HERMES_KANBAN_BOARD": _KANBAN_BOARD}
    proc = await asyncio.create_subprocess_exec(
        _HERMES_BIN, "kanban", "archive", task_id,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )
    _, err = await proc.communicate()
    if proc.returncode != 0:
        raise HTTPException(503, f"hermes archive failed: {err.decode()[:200]}")
    _cache["data"] = None
    return {"ok": True}


class UnblockIn(BaseModel):
    note: str = ""


@router.post("/tasks/{task_id}/unblock")
async def unblock_task(task_id: str, payload: UnblockIn):
    """Manually unblock a kanban task. Optionally leaves a comment first
    explaining what the user did before retrying."""
    env = {**os.environ, "HERMES_KANBAN_BOARD": _KANBAN_BOARD}

    if payload.note.strip():
        proc = await asyncio.create_subprocess_exec(
            _HERMES_BIN, "kanban", "comment", task_id, payload.note.strip(),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        _, err = await proc.communicate()
        if proc.returncode != 0:
            raise HTTPException(503, f"hermes comment failed: {err.decode()[:200]}")

    proc = await asyncio.create_subprocess_exec(
        _HERMES_BIN, "kanban", "unblock", task_id,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )
    _, err = await proc.communicate()
    if proc.returncode != 0:
        raise HTTPException(503, f"hermes unblock failed: {err.decode()[:200]}")
    _cache["data"] = None
    return {"ok": True}


class CompleteIn(BaseModel):
    note: str = ""
    summary: str = "用户手动结束"


@router.post("/tasks/{task_id}/complete")
async def complete_task(task_id: str, payload: CompleteIn):
    """Manually mark a task as done (no rework). Useful for closing a blocked
    critic loop when the user accepts the current draft as-is."""
    env = {**os.environ, "HERMES_KANBAN_BOARD": _KANBAN_BOARD}

    if payload.note.strip():
        proc = await asyncio.create_subprocess_exec(
            _HERMES_BIN, "kanban", "comment", task_id, payload.note.strip(),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        _, err = await proc.communicate()
        if proc.returncode != 0:
            raise HTTPException(503, f"hermes comment failed: {err.decode()[:200]}")

    proc = await asyncio.create_subprocess_exec(
        _HERMES_BIN, "kanban", "complete", task_id,
        "--summary", payload.summary or "用户手动结束",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )
    _, err = await proc.communicate()
    if proc.returncode != 0:
        raise HTTPException(503, f"hermes complete failed: {err.decode()[:200]}")
    _cache["data"] = None
    return {"ok": True}


_WMS_AGENTS = ("wms_scout", "wms_editor", "wms_writer", "wms_illustrator", "wms_critic")
_ROLE_ORDER = {n: i for i, n in enumerate(_WMS_AGENTS)}


async def _append_pipeline_extra(draft_id: int, role: str, task_id: str) -> None:
    """Record a follow-up task (rewrite / cover-regen) on the draft's PipelineTask
    so it shows up in the workflow timeline. Silently skips if the draft has no
    PipelineTask (e.g. cover regen on a legacy draft)."""
    from database import SessionLocal
    from models import PipelineTask
    from sqlalchemy import select as sa_select
    from sqlalchemy.orm.attributes import flag_modified

    async with SessionLocal() as db:
        row = (await db.execute(
            sa_select(PipelineTask).where(PipelineTask.draft_id == draft_id).limit(1)
        )).scalar_one_or_none()
        if row is None:
            return
        tids = dict(row.task_ids or {})
        extras = list(tids.get("extras") or [])
        extras.append({"role": role, "task_id": task_id})
        tids["extras"] = extras
        row.task_ids = tids
        flag_modified(row, "task_ids")
        await db.commit()


def _task_matches_draft(detail: dict, draft_id: int) -> tuple[bool, Optional[str]]:
    """Return (matched, latest_summary).

    Checks (in order):
    1. Task body for legacy `draft_id: <N>` / `save_draft id=<N>` patterns.
    2. run.metadata.draft_id — where kanban_complete() stores structured output.
    3. event payload.draft_id — fallback for older event-level conventions.
    """
    body = (detail.get("task") or {}).get("body") or ""
    needles_text = (f"draft_id: {draft_id}", f"save_draft id={draft_id}")
    matched = any(n in body for n in needles_text)

    summary: Optional[str] = None

    # Primary: check run metadata (kanban_complete writes draft_id here)
    for run in detail.get("runs") or []:
        meta = run.get("metadata") or {}
        if meta.get("draft_id") == draft_id or str(meta.get("draft_id")) == str(draft_id):
            matched = True
        s = run.get("summary")
        if isinstance(s, str) and s:
            summary = s  # use latest run summary as fallback

    # Secondary: check event payloads
    for ev in detail.get("events") or []:
        payload = ev.get("payload")
        if not isinstance(payload, dict):
            continue
        if payload.get("draft_id") == draft_id or str(payload.get("draft_id")) == str(draft_id):
            matched = True
        s = payload.get("summary")
        if isinstance(s, str):
            if any(n in s for n in needles_text):
                matched = True
            if ev.get("kind") == "completed":
                summary = s

    return matched, summary


@router.get("/drafts/{draft_id}/tasks")
async def get_draft_tasks(draft_id: int):
    """Return the kanban task chain linked to a draft via pipeline_tasks table."""
    if draft_id <= 0:
        raise HTTPException(400, "draft_id must be positive")

    from database import SessionLocal
    from models import PipelineTask
    from sqlalchemy import select as sa_select

    async with SessionLocal() as db:
        row = (await db.execute(
            sa_select(PipelineTask).where(PipelineTask.draft_id == draft_id).limit(1)
        )).scalar_one_or_none()

    if row is None:
        return {"draft_id": draft_id, "tasks": []}

    # task_ids = {"scout": "t_xxx", "editor": "t_xxx", "writer": "t_xxx", "illustrator": "t_xxx"}
    role_to_assignee = {
        "scout": "wms_scout",
        "editor": "wms_editor",
        "writer": "wms_writer",
        "illustrator": "wms_illustrator",
    }
    raw_task_ids = row.task_ids or {}
    tid_pairs: list[tuple[str, str]] = [
        (role_to_assignee[role], tid)
        for role, tid in raw_task_ids.items()
        if tid and role in role_to_assignee
    ]
    for extra in (raw_task_ids.get("extras") or []):
        role = extra.get("role")
        tid = extra.get("task_id")
        if tid and role in role_to_assignee:
            tid_pairs.append((role_to_assignee[role], tid))

    async def _fetch(assignee: str, tid: str) -> Optional[dict]:
        try:
            d = await _fetch_task_detail(tid)
        except HTTPException:
            return None
        t = d.get("task") or {}
        return {
            "id": t.get("id"),
            "title": t.get("title", ""),
            "assignee": assignee,
            "status": t.get("status", ""),
            "created_at": t.get("created_at", 0),
            "started_at": t.get("started_at"),
            "completed_at": t.get("completed_at"),
            "result": t.get("result"),
            "latest_summary": d.get("latest_summary"),
        }

    results = await asyncio.gather(*[_fetch(a, tid) for a, tid in tid_pairs])
    out = [r for r in results if r is not None]
    out.sort(key=lambda t: t.get("created_at") or 0)
    return {"draft_id": draft_id, "tasks": out, "pipeline_task_id": row.id}


@router.get("/tasks/{task_id}", response_model=TaskDetail)
async def get_task_detail(task_id: str):
    if not task_id or not task_id.startswith("t_"):
        raise HTTPException(400, "task_id must look like t_xxxxxxxx")

    raw = await _fetch_task_detail(task_id)
    if "task" not in raw:
        raise HTTPException(404, f"task {task_id} not found")

    return TaskDetail(
        task=raw.get("task", {}),
        latest_summary=raw.get("latest_summary"),
        parents=raw.get("parents") or [],
        children=raw.get("children") or [],
        comments=[TaskComment(**c) for c in (raw.get("comments") or [])],
        events=[TaskEvent(**e) for e in (raw.get("events") or [])],
        runs=[TaskRun(**r) for r in (raw.get("runs") or [])],
    )


@router.get("/tasks/{task_id}/log")
async def get_task_log(task_id: str):
    """Return the raw agent execution log for a kanban task."""
    env = {**os.environ, "HERMES_KANBAN_BOARD": _KANBAN_BOARD}
    proc = await asyncio.create_subprocess_exec(
        _HERMES_BIN, "kanban", "log", task_id,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )
    out, err = await proc.communicate()
    if proc.returncode != 0:
        msg = err.decode().strip()
        if "not found" in msg.lower() or "no such" in msg.lower():
            raise HTTPException(404, f"task {task_id} not found")
        raise HTTPException(503, f"hermes kanban log failed: {msg[:200]}")
    return {"task_id": task_id, "log": out.decode()}


def _query_session_tokens(profile: Optional[str], session_id: Optional[str]) -> dict:
    """Read token/cost counters from the profile's SQLite state.db. Runs in a thread."""
    if not profile or not session_id:
        return {}
    import sqlite3
    from pathlib import Path as _Path
    db_path = _Path.home() / ".hermes" / "profiles" / profile / "state.db"
    if not db_path.exists():
        return {}
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5)
        con.row_factory = sqlite3.Row
        row = con.execute(
            "SELECT model, input_tokens, output_tokens, cache_read_tokens, "
            "cache_write_tokens, reasoning_tokens, actual_cost_usd, estimated_cost_usd "
            "FROM sessions WHERE id = ? LIMIT 1",
            (session_id,),
        ).fetchone()
        con.close()
        return dict(row) if row else {}
    except Exception:
        return {}


async def _fetch_session_tokens(profile: Optional[str], session_id: Optional[str]) -> dict:
    """Async wrapper — runs the SQLite read off the event loop."""
    return await asyncio.get_event_loop().run_in_executor(
        None, _query_session_tokens, profile, session_id
    )


@router.get("/tasks/{task_id}/usage")
async def get_task_usage(task_id: str):
    """Return per-run token/cost usage for a kanban task.

    Correlates kanban run records (via worker_session_id in run metadata)
    with hermes session token counters.
    """
    env = {**os.environ, "HERMES_KANBAN_BOARD": _KANBAN_BOARD}
    proc = await asyncio.create_subprocess_exec(
        _HERMES_BIN, "kanban", "runs", task_id, "--json",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )
    out, err = await proc.communicate()
    if proc.returncode != 0:
        raise HTTPException(503, f"hermes kanban runs failed: {err.decode()[:200]}")

    runs_raw: list[dict] = json.loads(out.decode().strip() or "[]")

    # Fetch all session records in parallel (each profile has its own state.db)
    session_ids = [(run.get("metadata") or {}).get("worker_session_id") for run in runs_raw]
    sessions = await asyncio.gather(*[
        _fetch_session_tokens(run.get("profile"), sid)
        for run, sid in zip(runs_raw, session_ids)
    ])

    run_usages = []
    total_input = total_output = total_cache_read = total_cache_write = total_reasoning = 0
    total_cost = 0.0

    for run, sess in zip(runs_raw, sessions):
        inp  = int(sess.get("input_tokens") or 0)
        outp = int(sess.get("output_tokens") or 0)
        cr   = int(sess.get("cache_read_tokens") or 0)
        cw   = int(sess.get("cache_write_tokens") or 0)
        reas = int(sess.get("reasoning_tokens") or 0)
        act  = sess.get("actual_cost_usd")
        est  = sess.get("estimated_cost_usd")

        total_input      += inp
        total_output     += outp
        total_cache_read += cr
        total_cache_write += cw
        total_reasoning  += reas
        total_cost       += float(act if act is not None else (est or 0.0))

        run_usages.append({
            "run_id":             run.get("id"),
            "profile":            run.get("profile"),
            "started_at":         run.get("started_at"),
            "outcome":            run.get("outcome"),
            "session_id":         session_ids[len(run_usages)],
            "input_tokens":       inp,
            "output_tokens":      outp,
            "cache_read_tokens":  cr,
            "cache_write_tokens": cw,
            "reasoning_tokens":   reas,
            "actual_cost_usd":    act,
            "estimated_cost_usd": est,
            "model":              sess.get("model"),
        })

    return {
        "task_id":           task_id,
        "total_input":       total_input,
        "total_output":      total_output,
        "total_cache_read":  total_cache_read,
        "total_cache_write": total_cache_write,
        "total_reasoning":   total_reasoning,
        "total_cost_usd":    total_cost,
        "runs":              run_usages,
    }
