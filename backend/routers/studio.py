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


@router.post("/enqueue", response_model=EnqueueOut)
async def enqueue_scout_task(payload: EnqueueIn):
    """Push a source (juejin article, wechat post, X post, ...) into the
    scout queue with a target publish account. Scout picks it up, reads the
    account profile, and fans out a brief to the editor.
    """
    if not payload.account_id.strip():
        raise HTTPException(400, "account_id is required")
    if not payload.source_url.strip() or not payload.title.strip():
        raise HTTPException(400, "title and source_url are required")

    body_lines = [
        "flow: full",
        f"account_id: {payload.account_id}",
        f"platform: {payload.platform or 'unknown'}",
        f"source_url: {payload.source_url}",
        "",
        f"# {payload.title}",
        "",
    ]
    if payload.summary:
        body_lines += [payload.summary, ""]
    if payload.content:
        content = payload.content.strip()
        truncated = len(content) > _ENQUEUE_CONTENT_CAP
        if truncated:
            content = content[:_ENQUEUE_CONTENT_CAP] + "\n…(truncated)"
        body_lines += [
            "---",
            f"# 原文内容{'（已截断，源更长）' if truncated else ''}",
            "",
            content,
            "",
        ]
    if payload.note:
        body_lines += ["---", "用户备注：", payload.note]
    body = "\n".join(body_lines)

    env = {**os.environ, "HERMES_KANBAN_BOARD": _KANBAN_BOARD}
    proc = await asyncio.create_subprocess_exec(
        _HERMES_BIN, "kanban", "create", payload.title,
        "--assignee", "wms_scout",
        "--body", body,
        "--created-by", "studio-push",
        "--json",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )
    out, err = await proc.communicate()
    if proc.returncode != 0:
        raise HTTPException(503, f"hermes kanban create failed: {err.decode()[:200]}")
    raw = out.decode().strip() or "{}"
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        raise HTTPException(503, f"hermes returned non-JSON: {raw[:200]}")
    task_id = data.get("id") or data.get("task_id") or data.get("task", {}).get("id")
    if not task_id:
        raise HTTPException(503, f"hermes returned no task id: {raw[:200]}")
    _cache["data"] = None  # bust board cache so next poll shows it
    return EnqueueOut(task_id=task_id)


class RegenerateCoverIn(BaseModel):
    draft_id: int
    account_id: str
    note: str = ""


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

    body_lines = [
        "flow: cover_only",
        f"draft_id: {payload.draft_id}",
        f"account_id: {payload.account_id}",
        "",
        "用户从草稿箱手动触发的封面重生成。flow: cover_only ── 完成后直接交付，不派 critic。",
        "按账号 cover_style 出一张 16:9 封面，filename 用 cover_<timestamp>.png 挂到 draft 图库。",
    ]
    if payload.note:
        body_lines += ["", "用户备注：", payload.note]
    body = "\n".join(body_lines)
    title = f"重画封面：draft #{payload.draft_id}"

    env = {**os.environ, "HERMES_KANBAN_BOARD": _KANBAN_BOARD}
    proc = await asyncio.create_subprocess_exec(
        _HERMES_BIN, "kanban", "create", title,
        "--assignee", "wms_illustrator",
        "--body", body,
        "--created-by", "studio-cover",
        "--json",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )
    out, err = await proc.communicate()
    if proc.returncode != 0:
        raise HTTPException(503, f"hermes kanban create failed: {err.decode()[:200]}")
    try:
        data = json.loads(out.decode().strip() or "{}")
    except json.JSONDecodeError:
        raise HTTPException(503, f"hermes returned non-JSON")
    task_id = data.get("id") or data.get("task_id") or data.get("task", {}).get("id")
    if not task_id:
        raise HTTPException(503, "hermes returned no task id")
    _cache["data"] = None
    return EnqueueOut(task_id=task_id)


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


def _task_matches_draft(detail: dict, draft_id: int) -> tuple[bool, Optional[str]]:
    """Return (matched, latest_summary). Looks at task body + every event
    payload for `draft_id == <X>`. Also tolerates the legacy free-text
    `save_draft id=<X>` summaries the writer used before the metadata convention.
    """
    body = (detail.get("task") or {}).get("body") or ""
    needles_text = (f"draft_id: {draft_id}", f"save_draft id={draft_id}")
    matched = any(n in body for n in needles_text)

    summary: Optional[str] = None
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
    """Return the kanban task chain linked to a draft.

    Strategy: list all WMS-owned tasks via the public CLI, then for each call
    `kanban show` to inspect body + event metadata for `draft_id == X`. Both
    steps go through `hermes kanban`, so we never touch Hermes internals.
    """
    if draft_id <= 0:
        raise HTTPException(400, "draft_id must be positive")

    tasks = await _fetch_board()
    candidates = [t for t in tasks if (t.get("assignee") or "") in _WMS_AGENTS]

    detail_cache: dict[str, dict] = {}

    async def _detail(task_id: str) -> Optional[dict]:
        if task_id in detail_cache:
            return detail_cache[task_id]
        try:
            d = await _fetch_task_detail(task_id)
        except HTTPException:
            return None
        detail_cache[task_id] = d
        return d

    def _summarize(detail: dict, summary_override: Optional[str] = None) -> dict:
        t = detail.get("task") or {}
        return {
            "id": t.get("id"),
            "title": t.get("title", ""),
            "assignee": t.get("assignee") or "",
            "status": t.get("status", ""),
            "created_at": t.get("created_at", 0),
            "started_at": t.get("started_at"),
            "completed_at": t.get("completed_at"),
            "result": t.get("result"),
            "latest_summary": summary_override or detail.get("latest_summary"),
        }

    # Pass 1: scan WMS-owned tasks for direct draft_id match.
    direct = await asyncio.gather(*[_detail(c["id"]) for c in candidates])
    matched_ids: dict[str, dict] = {}
    for d in direct:
        if not d:
            continue
        ok, summary = _task_matches_draft(d, draft_id)
        if ok:
            tid = (d.get("task") or {}).get("id")
            if tid:
                matched_ids[tid] = _summarize(d, summary)

    # Pass 2: walk parents up *and* children down from each matched task.
    # Parents pick up scout/editor (created before draft_id existed); children
    # pick up illustrator/critic (created via metadata-typed `kanban_create`).
    frontier = list(matched_ids.keys())
    while frontier:
        details = await asyncio.gather(*[_detail(tid) for tid in frontier])
        neighbors: list[str] = []
        for d in details:
            if not d:
                continue
            for nid in (d.get("parents") or []) + (d.get("children") or []):
                if nid not in matched_ids:
                    neighbors.append(nid)
        if not neighbors:
            break
        neighbor_details = await asyncio.gather(*[_detail(nid) for nid in neighbors])
        for d in neighbor_details:
            if not d:
                continue
            tid = (d.get("task") or {}).get("id")
            if tid and tid not in matched_ids:
                matched_ids[tid] = _summarize(d)
        frontier = neighbors

    out = list(matched_ids.values())
    out.sort(key=lambda t: (_ROLE_ORDER.get(t["assignee"], 99), t.get("created_at") or 0))
    return {"draft_id": draft_id, "tasks": out}


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
