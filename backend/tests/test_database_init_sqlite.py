import asyncio
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
from types import SimpleNamespace


BACKEND_ROOT = Path(__file__).resolve().parents[1]


def _run_init_db_twice(database_path: Path) -> subprocess.CompletedProcess[str]:
    environment = os.environ.copy()
    environment["WMS_DATABASE_URL"] = (
        f"sqlite+aiosqlite:///{database_path}"
    )
    return subprocess.run(
        [
            sys.executable,
            "-c",
            (
                "import asyncio\n"
                "import models\n"
                "from database import engine, init_db\n"
                "async def main():\n"
                "    await init_db()\n"
                "    await init_db()\n"
                "    await engine.dispose()\n"
                "asyncio.run(main())\n"
            ),
        ],
        cwd=BACKEND_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )


def _columns(connection: sqlite3.Connection, table_name: str) -> set[str]:
    return {
        row[1]
        for row in connection.execute(f'PRAGMA table_info("{table_name}")')
    }


def test_retired_table_drop_keeps_postgresql_cascade():
    from database import _drop_tables

    class RecordingConnection:
        dialect = SimpleNamespace(name="postgresql")

        def __init__(self):
            self.statements = []

        async def execute(self, statement):
            self.statements.append(str(statement))

    connection = RecordingConnection()

    asyncio.run(_drop_tables(connection, ("legacy_one", "legacy_two")))

    assert connection.statements == [
        'DROP TABLE IF EXISTS "legacy_one" CASCADE',
        'DROP TABLE IF EXISTS "legacy_two" CASCADE',
    ]


def test_init_db_twice_creates_fresh_sqlite_core_and_text_video_tables(
    tmp_path,
):
    database_path = tmp_path / "fresh.db"

    result = _run_init_db_twice(database_path)

    assert result.returncode == 0, result.stderr
    with sqlite3.connect(database_path) as connection:
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        assert {
            "app_settings",
            "content_jobs",
            "text_video_projects",
            "text_video_speech_assets",
        } <= tables
        assert {
            "script",
            "paragraphs",
            "master_audio",
            "scene_plan",
            "render_input",
        } <= _columns(connection, "text_video_projects")
        assert {
            "sample_count",
            "sample_rate",
        } <= _columns(connection, "text_video_speech_assets")


def test_init_db_migrates_legacy_sqlite_columns_and_drops_ref_tables(
    tmp_path,
):
    database_path = tmp_path / "legacy.db"
    with sqlite3.connect(database_path) as connection:
        connection.executescript(
            """
            CREATE TABLE creative_assets (
                id INTEGER PRIMARY KEY
            );
            CREATE TABLE creative_asset_directories (
                id INTEGER PRIMARY KEY
            );
            CREATE TABLE x_posts (
                id INTEGER PRIMARY KEY
            );
            CREATE TABLE wechat_articles (
                id INTEGER PRIMARY KEY
            );
            CREATE TABLE publish_accounts (
                id INTEGER PRIMARY KEY
            );
            CREATE TABLE ref_seen (
                id INTEGER PRIMARY KEY
            );
            CREATE TABLE ref_collect_rules (
                id INTEGER PRIMARY KEY
            );
            CREATE TABLE ref_materials (
                id INTEGER PRIMARY KEY
            );
            """
        )

    result = _run_init_db_twice(database_path)

    assert result.returncode == 0, result.stderr
    with sqlite3.connect(database_path) as connection:
        assert {
            "media_kind",
            "directory",
            "last_selected_at",
        } <= _columns(connection, "creative_assets")
        assert {
            "asset_type",
            "parent_id",
            "system_key",
        } <= _columns(connection, "creative_asset_directories")
        assert {
            "author_avatar",
            "cover_image",
        } <= _columns(connection, "x_posts")
        assert {"content"} <= _columns(connection, "wechat_articles")
        assert {
            "voice_samples",
            "style_rules",
            "cover_style",
            "daily_quota",
        } <= _columns(connection, "publish_accounts")
        connection.execute(
            "INSERT INTO publish_accounts (id) VALUES (1)"
        )
        json_defaults = connection.execute(
            "SELECT voice_samples, style_rules, cover_style, daily_quota "
            "FROM publish_accounts WHERE id = 1"
        ).fetchone()
        assert json_defaults == ("[]", "[]", "{}", "{}")
        remaining_ref_tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master "
                "WHERE type = 'table' AND name LIKE 'ref_%'"
            )
        }
        assert remaining_ref_tables == set()
