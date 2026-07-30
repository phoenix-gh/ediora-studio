import asyncio
import json

from sqlalchemy import inspect, text
from sqlalchemy.ext.asyncio import create_async_engine


def test_text_video_project_migration_is_idempotent(tmp_path):
    from database import migrate_text_video_project_schema

    engine = create_async_engine(
        f"sqlite+aiosqlite:///{tmp_path / 'text-video-migration.db'}",
    )

    async def run():
        async with engine.begin() as connection:
            await connection.execute(text(
                "CREATE TABLE text_video_projects "
                "(id INTEGER PRIMARY KEY, title VARCHAR NOT NULL)"
            ))
            await migrate_text_video_project_schema(connection)
            await migrate_text_video_project_schema(connection)
            columns = {
                column["name"]
                for column in await connection.run_sync(
                    lambda sync_connection: inspect(sync_connection)
                    .get_columns("text_video_projects")
                )
            }
        await engine.dispose()
        return columns

    columns = asyncio.run(run())

    assert {
        "id",
        "title",
        "status",
        "stage",
        "script",
        "voice_settings",
        "paragraphs",
        "speech_split_mode",
        "master_audio",
        "scene_plan",
        "render_input",
        "render_state",
        "cover_asset_url",
        "output_asset_url",
        "output_stale",
        "revision",
        "created_at",
        "updated_at",
    } <= columns


def test_text_video_project_migration_normalizes_legacy_speech_documents(tmp_path):
    from database import migrate_text_video_project_schema

    engine = create_async_engine(
        f"sqlite+aiosqlite:///{tmp_path / 'text-video-documents.db'}",
    )

    async def run():
        async with engine.begin() as connection:
            await connection.execute(text(
                "CREATE TABLE text_video_projects ("
                "id INTEGER PRIMARY KEY, "
                "title VARCHAR NOT NULL, "
                "script TEXT NOT NULL, "
                "paragraphs JSON NOT NULL"
                ")"
            ))
            await connection.execute(
                text(
                    "INSERT INTO text_video_projects "
                    "(id, title, script, paragraphs) "
                    "VALUES (:id, :title, :script, :paragraphs)"
                ),
                [
                    {
                        "id": 1,
                        "title": "单段",
                        "script": "第一句。\n第二句。",
                        "paragraphs": json.dumps([], ensure_ascii=False),
                    },
                    {
                        "id": 2,
                        "title": "多段",
                        "script": "甲。乙。",
                        "paragraphs": json.dumps([
                            {"id": "a", "text": "甲。", "status": "confirmed"},
                            {"id": "b", "text": "乙。", "status": "ready"},
                        ], ensure_ascii=False),
                    },
                ],
            )
            await migrate_text_video_project_schema(connection)
            await migrate_text_video_project_schema(connection)
            rows = (
                await connection.execute(text(
                    "SELECT id, paragraphs, speech_split_mode, master_audio "
                    "FROM text_video_projects ORDER BY id"
                ))
            ).mappings().all()
        await engine.dispose()
        return rows

    rows = asyncio.run(run())

    first_paragraphs = json.loads(rows[0]["paragraphs"])
    second_paragraphs = json.loads(rows[1]["paragraphs"])
    first_master = json.loads(rows[0]["master_audio"])
    second_master = json.loads(rows[1]["master_audio"])
    assert rows[0]["speech_split_mode"] == "single"
    assert [item["text"] for item in first_paragraphs] == ["第一句。\n第二句。"]
    assert rows[1]["speech_split_mode"] == "manual"
    assert [item["text"] for item in second_paragraphs] == ["甲。", "乙。"]
    assert first_master["status"] == "missing"
    assert second_master["status"] == "missing"


def test_text_video_project_migration_preserves_authoritative_state_on_restart(tmp_path):
    from database import migrate_text_video_project_schema

    engine = create_async_engine(
        f"sqlite+aiosqlite:///{tmp_path / 'text-video-restart.db'}",
    )

    async def run():
        async with engine.begin() as connection:
            await connection.execute(text(
                "CREATE TABLE text_video_projects "
                "(id INTEGER PRIMARY KEY, title VARCHAR NOT NULL)"
            ))
            await connection.execute(text(
                "INSERT INTO text_video_projects (id, title) VALUES (1, '重启保护')"
            ))
            await migrate_text_video_project_schema(connection)
            await connection.execute(
                text(
                    "UPDATE text_video_projects SET "
                    "speech_split_mode = 'auto', "
                    "master_audio = :master_audio, "
                    "scene_plan = :scene_plan "
                    "WHERE id = 1"
                ),
                {
                    "master_audio": json.dumps({
                        "status": "ready",
                        "timeline_status": "ready",
                        "audio_url": "/api/uploads/master.mp3",
                    }),
                    "scene_plan": json.dumps({
                        "status": "ready",
                        "scenes": [{"id": "scene-1"}],
                    }),
                },
            )
            await migrate_text_video_project_schema(connection)
            row = (
                await connection.execute(text(
                    "SELECT speech_split_mode, master_audio, scene_plan, "
                    "render_state "
                    "FROM text_video_projects WHERE id = 1"
                ))
            ).mappings().one()
        await engine.dispose()
        return row

    row = asyncio.run(run())

    assert row["speech_split_mode"] == "auto"
    assert json.loads(row["master_audio"])["status"] == "ready"
    assert json.loads(row["scene_plan"])["status"] == "ready"
    assert json.loads(row["render_state"]) == {
        "status": "missing",
        "generation": 0,
        "source_hash": "",
        "job_id": None,
        "applied_job_id": None,
        "asset_id": None,
        "progress": 0,
        "error": "",
    }


def test_text_video_project_migration_normalizes_legacy_template_props_once(
    tmp_path,
):
    from database import migrate_text_video_project_schema

    engine = create_async_engine(
        f"sqlite+aiosqlite:///{tmp_path / 'text-video-template-props.db'}",
    )
    legacy_render_input = {
        "templateId": "tech-text-v1",
        "templateVersion": 1,
        "templateProps": {
            "theme": "tech-blue",
            "font": "source-han-sans",
            "background": "dark-grid",
            "transition": "soft-push",
            "textDensity": "standard",
        },
    }
    complete_render_input = {
        **legacy_render_input,
        "templateProps": {
            **legacy_render_input["templateProps"],
            "brandTitle": "已完成",
            "brandSubtitle": "无需迁移",
            "showBrand": True,
            "accentColor": "#FF3366",
            "showProgress": False,
            "showSceneNumber": False,
        },
    }

    async def run():
        async with engine.begin() as connection:
            await connection.execute(text(
                "CREATE TABLE text_video_projects ("
                "id INTEGER PRIMARY KEY, "
                "title VARCHAR NOT NULL, "
                "render_input JSON NOT NULL, "
                "output_asset_url VARCHAR NOT NULL DEFAULT ''"
                ")"
            ))
            await connection.execute(
                text(
                    "INSERT INTO text_video_projects "
                    "(id, title, render_input, output_asset_url) "
                    "VALUES (:id, :title, :render_input, :output_asset_url)"
                ),
                [
                    {
                        "id": 1,
                        "title": "旧成片",
                        "render_input": json.dumps(legacy_render_input),
                        "output_asset_url": "/api/uploads/old.mp4",
                    },
                    {
                        "id": 2,
                        "title": "旧草稿",
                        "render_input": json.dumps(legacy_render_input),
                        "output_asset_url": "",
                    },
                    {
                        "id": 3,
                        "title": "完整项目",
                        "render_input": json.dumps(complete_render_input),
                        "output_asset_url": "/api/uploads/current.mp4",
                    },
                ],
            )
            await migrate_text_video_project_schema(connection)
            first_rows = (
                await connection.execute(text(
                    "SELECT id, render_input, output_asset_url, output_stale "
                    "FROM text_video_projects ORDER BY id"
                ))
            ).mappings().all()
            await migrate_text_video_project_schema(connection)
            second_rows = (
                await connection.execute(text(
                    "SELECT id, render_input, output_asset_url, output_stale "
                    "FROM text_video_projects ORDER BY id"
                ))
            ).mappings().all()
        await engine.dispose()
        return first_rows, second_rows

    first_rows, second_rows = asyncio.run(run())
    assert [dict(row) for row in second_rows] == [dict(row) for row in first_rows]

    legacy_with_output, legacy_without_output, complete_project = second_rows
    assert legacy_with_output["output_asset_url"] == "/api/uploads/old.mp4"
    assert legacy_with_output["output_stale"] == 1
    assert legacy_without_output["output_stale"] == 0
    assert json.loads(legacy_with_output["render_input"])["templateProps"][
        "brandTitle"
    ] == "EDIORA"
    assert complete_project["output_stale"] == 0
