"""
Hermes Kanban CLI client.

Wraps `hermes kanban ...` CLI subcommands so the backend can manage kanban
tasks without talking to the dashboard HTTP API.

All commands are scoped to the board via the HERMES_KANBAN_BOARD env var,
matching the same pattern used in routers/studio.py.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
from pathlib import Path
from typing import Any, Optional


_BOARD = os.environ.get("WMS_STUDIO_BOARD", "test")


def _resolve_hermes_bin() -> str:
    found = shutil.which("hermes")
    if found:
        return found
    candidate = Path.home() / ".local" / "bin" / "hermes"
    if candidate.exists():
        return str(candidate)
    return "hermes"


_HERMES_BIN = _resolve_hermes_bin()


class HermesKanbanError(RuntimeError):
    def __init__(self, returncode: int, stderr: str):
        super().__init__(f"hermes kanban rc={returncode}: {stderr[:300]}")
        self.returncode = returncode
        self.stderr = stderr


class HermesKanbanClient:
    def __init__(self, board: str = _BOARD):
        self.board = board

    def _env(self) -> dict[str, str]:
        return {**os.environ, "HERMES_KANBAN_BOARD": self.board}

    async def _run(self, *args: str, capture_json: bool = True) -> Any:
        proc = await asyncio.create_subprocess_exec(
            _HERMES_BIN, *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=self._env(),
        )
        out, err = await proc.communicate()
        if proc.returncode != 0:
            raise HermesKanbanError(proc.returncode, err.decode())
        if not capture_json:
            return out.decode()
        raw = out.decode().strip() or "null"
        return json.loads(raw)

    # ── reads ────────────────────────────────────────────────────────────

    async def list_tasks(self, include_archived: bool = True) -> list[dict]:
        args = ["kanban", "list", "--json", "--sort", "created-desc"]
        if include_archived:
            args.append("--archived")
        data = await self._run(*args)
        return data if isinstance(data, list) else []

    async def get_task(self, task_id: str) -> dict:
        return await self._run("kanban", "show", task_id, "--json")

    async def get_log(self, task_id: str, tail_bytes: Optional[int] = None) -> dict:
        args = ["kanban", "log", task_id]
        if tail_bytes:
            args += ["--tail", str(tail_bytes)]
        text = await self._run(*args, capture_json=False)
        return {"log": text}

    async def get_session(self, session_id: str) -> Optional[dict]:
        """Not available via CLI; always returns None."""
        return None

    # ── writes ───────────────────────────────────────────────────────────

    async def create_task(self, *, title: str, body: str, assignee: str,
                          parents: Optional[list[str]] = None) -> str:
        args = ["kanban", "create", title,
                "--assignee", assignee,
                "--body", body,
                "--json"]
        for p in (parents or []):
            args += ["--parent", p]
        data = await self._run(*args)
        tid = (
            (data or {}).get("id")
            or (data or {}).get("task_id")
            or ((data or {}).get("task") or {}).get("id")
        )
        if not tid:
            raise HermesKanbanError(0, f"create returned no task id: {data}")
        return tid

    async def add_comment(self, task_id: str, body: str, author: str = "wms-studio") -> None:
        await self._run("kanban", "comment", task_id, body, capture_json=False)

    async def add_link(self, parent_id: str, child_id: str) -> None:
        await self._run("kanban", "link", parent_id, child_id, capture_json=False)

    async def archive_task(self, task_id: str) -> None:
        await self._run("kanban", "archive", task_id, capture_json=False)

    async def unblock_task(self, task_id: str) -> None:
        await self._run("kanban", "unblock", task_id, capture_json=False)

    async def complete_task(self, task_id: str, summary: str = "") -> None:
        args = ["kanban", "complete", task_id]
        if summary:
            args += ["--summary", summary]
        await self._run(*args, capture_json=False)

    async def patch_task(self, task_id: str, **fields: Any) -> dict:
        """Route a patch to the matching CLI subcommand based on the status field."""
        status = fields.get("status")
        if status == "archived":
            await self.archive_task(task_id)
        elif status == "ready":
            await self.unblock_task(task_id)
        elif status == "done":
            await self.complete_task(task_id, summary=str(fields.get("summary") or ""))
        elif status == "blocked":
            reason = str(fields.get("block_reason") or fields.get("reason") or "")
            await self._run("kanban", "block", task_id, "--reason", reason, capture_json=False)
        return {}

    async def aclose(self) -> None:
        pass


# Module-level singleton — created on first use, no lifecycle needed.
_client: Optional[HermesKanbanClient] = None


def get_client() -> HermesKanbanClient:
    global _client
    if _client is None:
        _client = HermesKanbanClient()
    return _client


async def shutdown_client() -> None:
    global _client
    _client = None
