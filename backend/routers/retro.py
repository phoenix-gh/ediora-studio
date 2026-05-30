"""
Retro router — "Agent 复盘室" (agent retrospective).

After an agent (writer / critic / …) finishes a kanban task, the user can
resume the exact Hermes session that executed it and talk to the agent about
how it did — then have the agent write the agreed lessons into its own
always-loaded memory (memories/MEMORY.md). Because the session is *resumed*,
the agent still carries its full working context; nothing is reconstructed.

Two surfaces:
  GET  /retro/sessions  — resolve a task_id → resumable session candidates
  WS   /retro/term      — PTY bridge running `hermes -p <profile> chat --tui --resume`

Session resolution reads the *profile's own* session store (via `hermes
sessions list`), not kanban.db, so it survives kanban corruption / reinit.
"""

from __future__ import annotations

import asyncio
import fcntl
import json
import os
import pty
import re
import shutil
import signal
import struct
import termios
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

router = APIRouter(prefix="/retro", tags=["retro"])

# Whitelist — only these profiles may be resumed from the web terminal. The WS
# bridge spawns a fixed retro-chat command, never a client-supplied one, so an
# unknown profile or malformed session id is rejected outright.
KNOWN_PROFILES: frozenset[str] = frozenset({
    "wms_scout", "wms_editor", "wms_writer",
    "wms_short_writer", "wms_illustrator", "wms_critic",
})

# Hermes session ids look like 20260530_113045_252a34
_SESSION_ID_RE = re.compile(r"\b(\d{8}_\d{6}_[0-9a-f]+)\b")
_SESSION_ID_FULL = re.compile(r"^\d{8}_\d{6}_[0-9a-f]+$")
_TASK_ID_RE = re.compile(r"^t_[0-9a-f]+$")


def _resolve_hermes_bin() -> str:
    """uvloop's subprocess_exec doesn't do PATH lookup, so resolve once."""
    found = shutil.which("hermes")
    if found:
        return found
    candidate = Path.home() / ".local" / "bin" / "hermes"
    if candidate.exists():
        return str(candidate)
    return "hermes"


_HERMES_BIN = _resolve_hermes_bin()


def parse_session_candidates(listing: str, task_id: str) -> list[dict[str, str]]:
    """Pull resumable sessions for ``task_id`` out of ``hermes sessions list`` text.

    Each kanban-run session is titled ``work kanban task t_xxxxxxxx``, so we keep
    rows that mention the task id and carry a session id. ``sessions list`` is
    already sorted newest-first and we preserve that order (newest = the run
    most worth reviewing). Duplicate session ids collapse to the first seen.

    Parsing is regex-based rather than column-based on purpose: the "Last
    Active" column is free-form ("2h ago", "yesterday", "just now"), so fixed
    column offsets would be brittle.
    """
    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for line in listing.splitlines():
        if task_id not in line:
            continue
        m = _SESSION_ID_RE.search(line)
        if not m:
            continue
        sid = m.group(1)
        if sid in seen:
            continue
        seen.add(sid)
        out.append({"session_id": sid, "label": line.strip()})
    return out


class SessionCandidate(BaseModel):
    session_id: str
    label: str


class ResolveOut(BaseModel):
    task_id: str
    profile: str
    candidates: list[SessionCandidate]


@router.get("/sessions", response_model=ResolveOut)
async def resolve_sessions(
    task_id: str = Query(..., description="kanban task id, e.g. t_a6b4d802"),
    profile: str = Query(..., description="agent profile that ran the task"),
):
    """List the Hermes sessions that executed ``task_id``, newest first."""
    if not _TASK_ID_RE.match(task_id):
        raise HTTPException(400, "task_id must look like t_xxxxxxxx")
    if profile not in KNOWN_PROFILES:
        raise HTTPException(400, f"unknown profile {profile!r}")

    proc = await asyncio.create_subprocess_exec(
        _HERMES_BIN, "-p", profile, "sessions", "list", "--limit", "200",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate()
    if proc.returncode != 0:
        raise HTTPException(503, f"hermes sessions list failed: {err.decode()[:200]}")

    candidates = [
        SessionCandidate(**c) for c in parse_session_candidates(out.decode(), task_id)
    ]
    return ResolveOut(task_id=task_id, profile=profile, candidates=candidates)


# ── PTY ⇄ WebSocket bridge ────────────────────────────────────────────────


def _set_winsize(fd: int, rows: int, cols: int) -> None:
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except OSError:
        pass


async def _reap(pid: int) -> None:
    """Wait for the child to exit without blocking the event loop; escalate to
    SIGKILL if it lingers."""
    for _ in range(20):  # up to ~1s
        try:
            done_pid, _ = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            return
        if done_pid:
            return
        await asyncio.sleep(0.05)
    try:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    except (ProcessLookupError, ChildProcessError):
        pass


@router.websocket("/term")
async def retro_terminal(ws: WebSocket):
    """Bridge a browser xterm.js to ``hermes -p <profile> chat --tui --resume <sid>``.

    Protocol: server→client frames are raw PTY output (binary). client→server
    binary frames are stdin keystrokes; client→server text frames are JSON
    control messages — currently only ``{"type":"resize","rows":R,"cols":C}``.
    """
    await ws.accept()
    profile = ws.query_params.get("profile", "")
    session_id = ws.query_params.get("session_id", "")
    if profile not in KNOWN_PROFILES or not _SESSION_ID_FULL.match(session_id):
        await ws.close(code=4400)
        return

    pid, master_fd = pty.fork()
    if pid == 0:  # ── child: become the agent TUI ──
        os.environ["TERM"] = "xterm-256color"
        os.environ["COLORTERM"] = "truecolor"
        try:
            # --tui = Hermes' modern full-screen UI: replays the resumed
            # conversation history on open and has no classic ASCII banner.
            os.execvp(_HERMES_BIN,
                      [_HERMES_BIN, "-p", profile, "chat", "--tui", "--resume", session_id])
        except Exception:
            os._exit(127)
        os._exit(127)

    # ── parent: bridge master_fd ⇄ websocket ──
    _set_winsize(master_fd, 40, 120)
    fcntl.fcntl(master_fd, fcntl.F_SETFL,
                fcntl.fcntl(master_fd, fcntl.F_GETFL) | os.O_NONBLOCK)

    loop = asyncio.get_event_loop()
    out_q: asyncio.Queue = asyncio.Queue()

    def _on_readable() -> None:
        try:
            data = os.read(master_fd, 65536)
        except (BlockingIOError, InterruptedError):
            return
        except OSError:
            out_q.put_nowait(None)
            return
        out_q.put_nowait(data or None)  # b"" (EOF) → None sentinel

    loop.add_reader(master_fd, _on_readable)

    async def _sender() -> None:
        while True:
            data = await out_q.get()
            if data is None:
                break
            await ws.send_bytes(data)

    async def _receiver() -> None:
        while True:
            msg = await ws.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            data = msg.get("bytes")
            if data is not None:
                try:
                    os.write(master_fd, data)
                except OSError:
                    break
                continue
            text = msg.get("text")
            if text:
                try:
                    ctrl = json.loads(text)
                except ValueError:
                    continue
                if ctrl.get("type") == "resize":
                    _set_winsize(master_fd, int(ctrl.get("rows", 40)),
                                 int(ctrl.get("cols", 120)))

    sender = asyncio.create_task(_sender())
    receiver = asyncio.create_task(_receiver())
    try:
        await asyncio.wait({sender, receiver}, return_when=asyncio.FIRST_COMPLETED)
    except WebSocketDisconnect:
        pass
    finally:
        loop.remove_reader(master_fd)
        sender.cancel()
        receiver.cancel()
        try:
            os.close(master_fd)
        except OSError:
            pass
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        await _reap(pid)
        try:
            await ws.close()
        except Exception:
            pass
