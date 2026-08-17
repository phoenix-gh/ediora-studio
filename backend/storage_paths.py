"""Shared filesystem roots for persisted application assets."""

from __future__ import annotations

import os
from pathlib import Path


def _resolve_uploads_dir() -> Path:
    configured = os.getenv("UPLOADS_DIR", "").strip()
    root = (
        Path(configured).expanduser()
        if configured
        else Path(__file__).resolve().parent / "uploads"
    )
    return root.resolve()


UPLOADS_DIR = _resolve_uploads_dir()
