from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys


def test_text_video_and_static_upload_paths_follow_environment(
    tmp_path: Path,
) -> None:
    uploads = tmp_path / "isolated uploads"
    environment = {
        **os.environ,
        "UPLOADS_DIR": str(uploads),
        "DISABLE_SCHEDULER": "1",
    }
    script = """
import json

import main
import text_video_audio
import text_video_jobs
import text_video_master
from routers import text_videos

mount = next(
    route for route in main.app.routes
    if getattr(route, "path", None) == "/api/uploads"
)
print(json.dumps({
    "audio": str(text_video_audio.UPLOADS_DIR),
    "jobs": str(text_video_jobs.UPLOADS_DIR),
    "master": str(text_video_master.UPLOADS_DIR),
    "router": str(text_videos.UPLOADS_DIR),
    "static": str(mount.app.directory),
}))
"""

    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=Path(__file__).resolve().parents[1],
        env=environment,
        check=True,
        capture_output=True,
        text=True,
    )

    paths = json.loads(result.stdout.strip().splitlines()[-1])
    assert set(paths.values()) == {str(uploads.resolve())}
    assert uploads.is_dir()
