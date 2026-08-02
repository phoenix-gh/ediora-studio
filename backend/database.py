import asyncio
import math
import os
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.orm import DeclarativeBase

_MAX_DATABASE_TIMEOUT_SECONDS = 300.0
_DEFERRED_SESSION_TASKS_KEY = "wms_deferred_session_tasks"
_BACKGROUND_DATABASE_TASKS: set[asyncio.Task] = set()


def _parse_database_timeout_seconds(value: str) -> float:
    try:
        timeout = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(
            "WMS_DATABASE_COMMAND_TIMEOUT_SECONDS must be a finite number "
            "between 0 and 300",
        ) from error
    if (
        not math.isfinite(timeout)
        or timeout <= 0
        or timeout > _MAX_DATABASE_TIMEOUT_SECONDS
    ):
        raise ValueError(
            "WMS_DATABASE_COMMAND_TIMEOUT_SECONDS must be a finite number "
            "between 0 and 300",
        )
    return timeout


def _database_engine_kwargs(
    database_url: str,
    command_timeout_seconds: float,
) -> dict:
    options: dict = {"echo": False, "pool_pre_ping": True}
    if database_url.startswith("sqlite"):
        options["connect_args"] = {"timeout": command_timeout_seconds}
    else:
        options.update(pool_size=10, max_overflow=20)
        if database_url.startswith("postgresql+asyncpg"):
            options["connect_args"] = {
                "command_timeout": command_timeout_seconds,
            }
    return options


def _consume_background_database_task(task: asyncio.Task) -> None:
    _BACKGROUND_DATABASE_TASKS.discard(task)
    try:
        task.result()
    except BaseException:
        pass


def defer_session_close_until_task_terminal(
    session: AsyncSession,
    task: asyncio.Task,
) -> None:
    tasks = session.info.setdefault(_DEFERRED_SESSION_TASKS_KEY, set())
    tasks.add(task)
    _BACKGROUND_DATABASE_TASKS.add(task)
    task.add_done_callback(_consume_background_database_task)


async def _close_session_after_tasks(
    session: AsyncSession,
    tasks: tuple[asyncio.Task, ...],
) -> None:
    await asyncio.gather(*tasks, return_exceptions=True)
    await session.close()


def _track_background_database_task(task: asyncio.Task) -> None:
    _BACKGROUND_DATABASE_TASKS.add(task)
    task.add_done_callback(_consume_background_database_task)


DATABASE_URL = os.getenv(
    "WMS_DATABASE_URL",
    "postgresql+asyncpg://postgres:123456@127.0.0.1:5432/wemedia",
)
DATABASE_COMMAND_TIMEOUT_SECONDS = _parse_database_timeout_seconds(
    os.getenv("WMS_DATABASE_COMMAND_TIMEOUT_SECONDS", "30"),
)

_engine_kwargs = _database_engine_kwargs(
    DATABASE_URL,
    DATABASE_COMMAND_TIMEOUT_SECONDS,
)
engine = create_async_engine(DATABASE_URL, **_engine_kwargs)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)

class Base(DeclarativeBase):
    pass

async def get_db() -> AsyncSession:
    session = SessionLocal()
    try:
        yield session
    finally:
        deferred = tuple(
            session.info.pop(_DEFERRED_SESSION_TASKS_KEY, set()),
        )
        pending = tuple(task for task in deferred if not task.done())
        if pending:
            cleanup = asyncio.create_task(
                _close_session_after_tasks(session, pending),
                name="deferred-database-session-close",
            )
            _track_background_database_task(cleanup)
        else:
            await session.close()

async def migrate_x_response_claim_schema(conn) -> None:
    """Add the delivery-claim column/index on both SQLite and PostgreSQL."""
    from sqlalchemy import text

    if conn.dialect.name == "sqlite":
        rows = (
            await conn.execute(text("PRAGMA table_info(x_response_decisions)"))
        ).all()
        if not rows:
            return
        columns = {row[1] for row in rows}
        if "telegram_claim_token" not in columns:
            await conn.execute(text(
                "ALTER TABLE x_response_decisions "
                "ADD COLUMN telegram_claim_token VARCHAR"
            ))
    else:
        await conn.execute(text(
            "ALTER TABLE x_response_decisions "
            "ADD COLUMN IF NOT EXISTS telegram_claim_token VARCHAR"
        ))
    await conn.execute(text(
        "CREATE INDEX IF NOT EXISTS "
        "ix_x_response_decisions_telegram_claim_token "
        "ON x_response_decisions (telegram_claim_token)"
    ))


async def migrate_removed_hot_topic_schema(conn) -> None:
    """Remove the retired topic generator while preserving processed history."""
    from sqlalchemy import inspect, text

    tables = set(await conn.run_sync(
        lambda sync_connection: inspect(sync_connection).get_table_names()
    ))
    if "x_response_decisions" in tables:
        await conn.execute(text(
            "UPDATE x_response_decisions "
            "SET workflow_status = 'used' "
            "WHERE workflow_status = 'converted'"
        ))
    await conn.execute(text("DROP TABLE IF EXISTS topic_generator_cache"))


async def migrate_removed_publication_schema(conn) -> None:
    """Remove the retired publication-record and statistics store."""
    from sqlalchemy import text

    await conn.execute(text("DROP TABLE IF EXISTS publications"))


async def migrate_content_job_idempotency_schema(conn) -> None:
    """Make every non-empty durable-job key unique without losing history."""
    from sqlalchemy import inspect, text

    tables = set(await conn.run_sync(
        lambda sync_connection: inspect(sync_connection).get_table_names()
    ))
    if "content_jobs" not in tables:
        return
    rows = (
        await conn.execute(text(
            "SELECT id, idempotency_key FROM content_jobs "
            "WHERE idempotency_key <> '' ORDER BY id"
        ))
    ).mappings().all()
    reserved = {
        str(row["idempotency_key"])
        for row in rows
    }
    seen: set[str] = set()
    for row in rows:
        key = str(row["idempotency_key"])
        if key in seen:
            base = f"{key}:legacy:{row['id']}"
            replacement = base
            counter = 1
            while replacement in reserved:
                replacement = f"{base}:{counter}"
                counter += 1
            reserved.add(replacement)
            await conn.execute(
                text(
                    "UPDATE content_jobs SET idempotency_key = :replacement "
                    "WHERE id = :job_id"
                ),
                {
                    "replacement": replacement,
                    "job_id": row["id"],
                },
            )
        else:
            seen.add(key)
    await conn.execute(text(
        "CREATE UNIQUE INDEX IF NOT EXISTS "
        "uq_content_jobs_idempotency_nonempty "
        "ON content_jobs (idempotency_key) "
        "WHERE idempotency_key <> ''"
    ))


async def migrate_text_video_speech_asset_schema(conn) -> None:
    """Add sample-accurate metadata to speech assets created before this release."""
    await _add_columns(conn, "text_video_speech_assets", {
        "sample_count": "INTEGER NOT NULL DEFAULT 0",
        "sample_rate": "INTEGER NOT NULL DEFAULT 44100",
    })


async def _add_columns(conn, table_name: str, definitions: dict[str, str]) -> None:
    """Add missing columns on SQLite and PostgreSQL without rebuilding tables."""
    from sqlalchemy import inspect, text

    tables = set(await conn.run_sync(
        lambda sync_connection: inspect(sync_connection).get_table_names()
    ))
    if table_name not in tables:
        return
    columns = {
        column["name"]
        for column in await conn.run_sync(
            lambda sync_connection: inspect(sync_connection).get_columns(table_name)
        )
    }
    for name, definition in definitions.items():
        if name not in columns:
            await conn.execute(text(
                f'ALTER TABLE "{table_name}" ADD COLUMN "{name}" {definition}'
            ))


async def _drop_tables(conn, table_names: tuple[str, ...]) -> None:
    """Drop retired tables with CASCADE only where PostgreSQL supports it."""
    from sqlalchemy import text

    cascade = " CASCADE" if conn.dialect.name == "postgresql" else ""
    for table_name in table_names:
        await conn.execute(text(
            f'DROP TABLE IF EXISTS "{table_name}"{cascade}'
        ))


async def migrate_text_video_project_schema(conn) -> None:
    """Keep early text-video project tables compatible across SQLite and PostgreSQL."""
    from copy import deepcopy
    import json

    from sqlalchemy import JSON, bindparam, inspect, text

    json_object_default = "'{}'" if conn.dialect.name == "sqlite" else "'{}'::json"
    json_array_default = "'[]'" if conn.dialect.name == "sqlite" else "'[]'::json"
    timestamp_definition = (
        "TIMESTAMP"
        if conn.dialect.name == "sqlite"
        else "TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP"
    )
    tables = set(await conn.run_sync(
        lambda sync_connection: inspect(sync_connection).get_table_names()
    ))
    if "text_video_projects" not in tables:
        return
    existing_columns = {
        column["name"]
        for column in await conn.run_sync(
            lambda sync_connection: inspect(sync_connection)
            .get_columns("text_video_projects")
        )
    }
    had_split_mode = "speech_split_mode" in existing_columns
    had_master_audio = "master_audio" in existing_columns
    had_scene_plan = "scene_plan" in existing_columns
    had_render_state = "render_state" in existing_columns

    await _add_columns(conn, "text_video_projects", {
        "status": "VARCHAR NOT NULL DEFAULT 'draft'",
        "stage": "VARCHAR NOT NULL DEFAULT 'script'",
        "script": "TEXT NOT NULL DEFAULT ''",
        "voice_settings": f"JSON NOT NULL DEFAULT {json_object_default}",
        "paragraphs": f"JSON NOT NULL DEFAULT {json_array_default}",
        "speech_split_mode": "VARCHAR NOT NULL DEFAULT 'single'",
        "master_audio": f"JSON NOT NULL DEFAULT {json_object_default}",
        "scene_plan": f"JSON NOT NULL DEFAULT {json_object_default}",
        "render_input": f"JSON NOT NULL DEFAULT {json_object_default}",
        "render_state": f"JSON NOT NULL DEFAULT {json_object_default}",
        "cover_asset_url": "VARCHAR NOT NULL DEFAULT ''",
        "output_asset_url": "VARCHAR NOT NULL DEFAULT ''",
        "output_stale": "BOOLEAN NOT NULL DEFAULT FALSE",
        "revision": "INTEGER NOT NULL DEFAULT 1",
        "created_at": timestamp_definition,
        "updated_at": timestamp_definition,
    })

    if conn.dialect.name == "sqlite":
        await conn.execute(text(
            "UPDATE text_video_projects "
            "SET created_at = COALESCE(created_at, CURRENT_TIMESTAMP), "
            "updated_at = COALESCE(updated_at, CURRENT_TIMESTAMP)"
        ))

    from text_video_domain import (
        empty_master_audio,
        empty_render_state,
        empty_scene_plan,
        normalize_speech_segments,
    )
    from text_video_templates import (
        get_text_video_template,
        normalize_text_video_template_props,
    )

    rows = (
        await conn.execute(text(
            "SELECT id, script, paragraphs, speech_split_mode, "
            "master_audio, scene_plan, render_input, output_asset_url, "
            "output_stale, render_state FROM text_video_projects"
        ))
    ).mappings().all()

    def decode_json(value, fallback):
        if isinstance(value, str):
            try:
                return json.loads(value)
            except json.JSONDecodeError:
                return fallback
        return value if value is not None else fallback

    update_statement = text(
        "UPDATE text_video_projects SET "
        "paragraphs = :paragraphs, "
        "speech_split_mode = :speech_split_mode, "
        "master_audio = :master_audio, "
        "scene_plan = :scene_plan, "
        "render_state = :render_state "
        "WHERE id = :id"
    ).bindparams(
        bindparam("paragraphs", type_=JSON),
        bindparam("master_audio", type_=JSON),
        bindparam("scene_plan", type_=JSON),
        bindparam("render_state", type_=JSON),
    )
    for row in rows:
        script = str(row["script"] or "")
        paragraphs = normalize_speech_segments(
            script,
            decode_json(row["paragraphs"], []),
        )
        split_mode = row["speech_split_mode"] if had_split_mode else ""
        if split_mode not in {"single", "auto", "manual"}:
            split_mode = "manual" if len(paragraphs) > 1 else "single"
        master_audio = (
            empty_master_audio()
            | decode_json(row["master_audio"], {})
            if had_master_audio
            else empty_master_audio()
        )
        scene_plan = (
            empty_scene_plan()
            | decode_json(row["scene_plan"], {})
            if had_scene_plan
            else empty_scene_plan()
        )
        render_state = (
            empty_render_state()
            | decode_json(row["render_state"], {})
            if had_render_state
            else empty_render_state()
        )
        if not had_render_state and row["output_asset_url"]:
            render_state["status"] = "stale"
        await conn.execute(update_statement, {
            "id": row["id"],
            "paragraphs": paragraphs,
            "speech_split_mode": split_mode,
            "master_audio": master_audio,
            "scene_plan": scene_plan,
            "render_state": render_state,
        })

        render_input = decode_json(row["render_input"], {})
        if (
            not isinstance(render_input, dict)
            or render_input.get("templateId") != "tech-text-v1"
            or render_input.get("templateVersion") != 1
        ):
            continue
        template_props = render_input.get("templateProps")
        if not isinstance(template_props, dict):
            continue
        manifest = get_text_video_template("tech-text-v1", 1)
        if not set(manifest["template_props"]) - set(template_props):
            continue
        try:
            normalized_props = normalize_text_video_template_props(
                manifest,
                template_props,
                fill_missing=True,
            )
        except ValueError:
            continue
        migrated_render_input = deepcopy(render_input)
        migrated_render_input["templateProps"] = normalized_props
        await conn.execute(
            text(
                "UPDATE text_video_projects SET "
                "render_input = :render_input, "
                "output_stale = :output_stale, "
                "render_state = :render_state "
                "WHERE id = :id"
            ).bindparams(
                bindparam("render_input", type_=JSON),
                bindparam("render_state", type_=JSON),
            ),
            {
                "id": row["id"],
                "render_input": migrated_render_input,
                "output_stale": bool(row["output_asset_url"]),
                "render_state": (
                    render_state
                    | (
                        {"status": "stale"}
                        if row["output_asset_url"]
                        else {}
                    )
                ),
            },
        )


async def migrate_content_response_schema(conn) -> None:
    """Add YouTube response fields and copy legacy X decisions exactly once."""
    from sqlalchemy import inspect, select
    from models import (
        ContentAnalysisRun,
        ContentResponseItem,
        ContentResponseNotification,
        ContentResponseOutput,
        XPost,
        XResponseDecision,
    )

    json_default = "'[]'" if conn.dialect.name == "sqlite" else "'[]'::json"
    await _add_columns(conn, "youtube_channels", {
        "auto_analyze_new_videos": "BOOLEAN NOT NULL DEFAULT FALSE",
        "analysis_enabled_at": "TIMESTAMP",
    })
    await _add_columns(conn, "youtube_videos", {
        "transcript_status": "VARCHAR NOT NULL DEFAULT 'not_requested'",
        "transcript_source": "VARCHAR NOT NULL DEFAULT ''",
        "transcript_language": "VARCHAR NOT NULL DEFAULT ''",
        "transcript_text": "TEXT NOT NULL DEFAULT ''",
        "transcript_segments": f"JSON NOT NULL DEFAULT {json_default}",
        "transcript_content_hash": "VARCHAR NOT NULL DEFAULT ''",
        "transcript_fetched_at": "TIMESTAMP",
        "transcript_error_code": "VARCHAR NOT NULL DEFAULT ''",
        "transcript_error": "TEXT NOT NULL DEFAULT ''",
    })

    tables = set(await conn.run_sync(
        lambda sync_connection: inspect(sync_connection).get_table_names()
    ))
    if "x_response_decisions" not in tables:
        return

    decisions = (await conn.execute(select(XResponseDecision.__table__))).mappings().all()
    for decision in decisions:
        existing_item = (await conn.execute(
            select(ContentResponseItem.__table__.c.id).where(
                ContentResponseItem.__table__.c.source_type == "x_post",
                ContentResponseItem.__table__.c.source_id == decision["tweet_id"],
            )
        )).scalar_one_or_none()
        post = (await conn.execute(
            select(XPost.__table__).where(XPost.__table__.c.tweet_id == decision["tweet_id"])
        )).mappings().first()
        if existing_item is None:
            result = await conn.execute(ContentResponseItem.__table__.insert().values(
                source_type="x_post",
                source_id=decision["tweet_id"],
                source_url=(post or {}).get("url", ""),
                source_title=((post or {}).get("content", "") or "")[:500],
                source_author=(post or {}).get("username", ""),
                source_published_at=(post or {}).get("published_at"),
                workflow_status="ready",
                decision_status={
                    "used": "adopted",
                    "ignored": "rejected",
                }.get(decision["workflow_status"], "pending"),
                created_at=decision["created_at"],
                updated_at=decision["updated_at"],
            ))
            existing_item = result.inserted_primary_key[0]

        analysis_id = (await conn.execute(
            select(ContentAnalysisRun.__table__.c.id).where(
                ContentAnalysisRun.__table__.c.response_item_id == existing_item,
                ContentAnalysisRun.__table__.c.version == 1,
            )
        )).scalar_one_or_none()
        if analysis_id is None:
            result = await conn.execute(ContentAnalysisRun.__table__.insert().values(
                response_item_id=existing_item,
                version=1,
                status="succeeded",
                content_value_score=decision["score"],
                value_dimensions={"legacy_score": decision["score"]},
                summary_cn=decision["summary_cn"],
                core_thesis=decision["summary_cn"],
                evidence=decision["claims"] or [],
                recommended_action=decision["action"],
                recommendation_reason=decision["reason"],
                model_provider=decision["model_provider"],
                model_name=decision["model_name"],
                prompt_version=decision["prompt_version"],
                policy_version=decision["decision_policy_version"],
                source_snapshot={
                    "verification_status": decision["verification_status"],
                    "verified_urls": decision["verified_urls"] or [],
                },
                created_at=decision["created_at"],
                completed_at=decision["updated_at"],
            ))
            analysis_id = result.inserted_primary_key[0]
        await conn.execute(
            ContentAnalysisRun.__table__.update()
            .where(ContentAnalysisRun.__table__.c.id == analysis_id)
            .values(
                status="succeeded",
                content_value_score=decision["score"],
                value_dimensions={"legacy_score": decision["score"]},
                summary_cn=decision["summary_cn"],
                core_thesis=decision["summary_cn"],
                evidence=decision["claims"] or [],
                recommended_action=decision["action"],
                recommendation_reason=decision["reason"],
                model_provider=decision["model_provider"],
                model_name=decision["model_name"],
                prompt_version=decision["prompt_version"],
                policy_version=decision["decision_policy_version"],
                source_snapshot={
                    "x_response": {
                        "subscription_id": decision["subscription_id"],
                        "action": decision["action"],
                        "confidence": decision["confidence"],
                        "claims": decision["claims"] or [],
                        "verification_status": decision["verification_status"],
                        "verified_urls": decision["verified_urls"] or [],
                    },
                },
                completed_at=decision["updated_at"],
            )
        )

        await conn.execute(
            ContentResponseItem.__table__.update()
            .where(ContentResponseItem.__table__.c.id == existing_item)
            .values(current_analysis_run_id=analysis_id)
        )
        for output_type, content in (
            ("x_reply", decision["comment_draft"]),
            ("x_quote", decision["quote_draft"]),
        ):
            if not content:
                continue
            exists = (await conn.execute(
                select(ContentResponseOutput.__table__.c.id).where(
                    ContentResponseOutput.__table__.c.analysis_run_id == analysis_id,
                    ContentResponseOutput.__table__.c.output_type == output_type,
                )
            )).scalar_one_or_none()
            if exists is None:
                await conn.execute(ContentResponseOutput.__table__.insert().values(
                    response_item_id=existing_item,
                    analysis_run_id=analysis_id,
                    output_type=output_type,
                    status="draft_ready",
                    content=content,
                    source_attribution={"url": (post or {}).get("url", "")},
                    created_at=decision["created_at"],
                    updated_at=decision["updated_at"],
                ))
            else:
                await conn.execute(
                    ContentResponseOutput.__table__.update()
                    .where(ContentResponseOutput.__table__.c.id == exists)
                    .values(
                        status="draft_ready",
                        content=content,
                        source_attribution={"url": (post or {}).get("url", "")},
                        updated_at=decision["updated_at"],
                    )
                )

        notification = (await conn.execute(
            select(ContentResponseNotification.__table__.c.id).where(
                ContentResponseNotification.__table__.c.analysis_run_id == analysis_id,
                ContentResponseNotification.__table__.c.channel == "telegram",
            )
        )).scalar_one_or_none()
        if notification is None:
            await conn.execute(ContentResponseNotification.__table__.insert().values(
                response_item_id=existing_item,
                analysis_run_id=analysis_id,
                channel="telegram",
                notification_tier=decision["notification_tier"],
                status=decision["telegram_status"],
                message_ids=decision["telegram_message_ids"] or [],
                attempts=decision["telegram_attempts"],
                claim_token=decision["telegram_claim_token"],
                last_error=decision["telegram_last_error"],
                notified_at=decision["notified_at"],
                created_at=decision["created_at"],
                updated_at=decision["updated_at"],
            ))
        else:
            await conn.execute(
                ContentResponseNotification.__table__.update()
                .where(ContentResponseNotification.__table__.c.id == notification)
                .values(
                    notification_tier=decision["notification_tier"],
                    status=decision["telegram_status"],
                    message_ids=decision["telegram_message_ids"] or [],
                    attempts=decision["telegram_attempts"],
                    claim_token=decision["telegram_claim_token"],
                    last_error=decision["telegram_last_error"],
                    notified_at=decision["notified_at"],
                    updated_at=decision["updated_at"],
                )
            )


async def retire_x_response_decision_schema(conn) -> None:
    """Drop the legacy X decision table only after row-by-row parity checks."""
    from sqlalchemy import inspect, select, text
    from models import (
        ContentAnalysisRun,
        ContentResponseItem,
        ContentResponseNotification,
        ContentResponseOutput,
        XResponseDecision,
    )

    tables = set(await conn.run_sync(
        lambda sync_connection: inspect(sync_connection).get_table_names()
    ))
    if "x_response_decisions" not in tables:
        return

    decisions = (
        await conn.execute(select(XResponseDecision.__table__))
    ).mappings().all()
    for decision in decisions:
        item = (await conn.execute(
            select(ContentResponseItem.__table__).where(
                ContentResponseItem.__table__.c.source_type == "x_post",
                ContentResponseItem.__table__.c.source_id == decision["tweet_id"],
            )
        )).mappings().one_or_none()
        if item is None or item["current_analysis_run_id"] is None:
            raise RuntimeError(
                f"cannot retire x_response_decisions: missing unified item "
                f"for {decision['tweet_id']}"
            )
        run = (await conn.execute(
            select(ContentAnalysisRun.__table__).where(
                ContentAnalysisRun.__table__.c.id
                == item["current_analysis_run_id"]
            )
        )).mappings().one_or_none()
        snapshot = (run or {}).get("source_snapshot") or {}
        x_snapshot = snapshot.get("x_response") or {}
        expected_decision_status = {
            "used": "adopted",
            "ignored": "rejected",
        }.get(decision["workflow_status"], "pending")
        run_matches = bool(
            run
            and run["status"] == "succeeded"
            and run["content_value_score"] == decision["score"]
            and run["summary_cn"] == decision["summary_cn"]
            and run["recommended_action"] == decision["action"]
            and run["recommendation_reason"] == decision["reason"]
            and x_snapshot.get("confidence") == decision["confidence"]
            and (x_snapshot.get("claims") or []) == (decision["claims"] or [])
            and x_snapshot.get("verification_status")
            == decision["verification_status"]
            and (x_snapshot.get("verified_urls") or [])
            == (decision["verified_urls"] or [])
            and item["decision_status"] == expected_decision_status
        )
        if not run_matches:
            raise RuntimeError(
                f"cannot retire x_response_decisions: analysis mismatch "
                f"for {decision['tweet_id']}"
            )

        outputs = (await conn.execute(
            select(
                ContentResponseOutput.__table__.c.output_type,
                ContentResponseOutput.__table__.c.content,
            ).where(
                ContentResponseOutput.__table__.c.analysis_run_id == run["id"]
            )
        )).all()
        output_map = dict(outputs)
        if (
            (decision["comment_draft"] and output_map.get("x_reply")
             != decision["comment_draft"])
            or (decision["quote_draft"] and output_map.get("x_quote")
                != decision["quote_draft"])
        ):
            raise RuntimeError(
                f"cannot retire x_response_decisions: draft mismatch "
                f"for {decision['tweet_id']}"
            )

        notification = (await conn.execute(
            select(ContentResponseNotification.__table__).where(
                ContentResponseNotification.__table__.c.analysis_run_id
                == run["id"],
                ContentResponseNotification.__table__.c.channel == "telegram",
            )
        )).mappings().one_or_none()
        notification_matches = bool(
            notification
            and notification["notification_tier"]
            == decision["notification_tier"]
            and notification["status"] == decision["telegram_status"]
            and (notification["message_ids"] or [])
            == (decision["telegram_message_ids"] or [])
            and notification["attempts"] == decision["telegram_attempts"]
            and notification["claim_token"]
            == decision["telegram_claim_token"]
            and notification["last_error"] == decision["telegram_last_error"]
        )
        if not notification_matches:
            raise RuntimeError(
                f"cannot retire x_response_decisions: notification mismatch "
                f"for {decision['tweet_id']}"
            )

    await conn.execute(text("DROP TABLE x_response_decisions"))


async def init_db():
    from sqlalchemy import text
    async with engine.begin() as conn:
        # Drop legacy X tables (replaced by new schema). Dev DB only.
        # NOTE: x_posts is no longer dropped here — we keep collected data
        # across restarts and migrate the schema via ALTER TABLE below.
        await _drop_tables(conn, (
            "x_post_metrics",
            "x_blogger_candidates",
            # GitHub issues 功能已整体移除（2026-06）：数据可随时从 GitHub 重新拉取
            "github_issues",
            "issue_pain_points",
            # 旧选题链路已整体移除（2026-06）：通用 collector/analyzer + Topic 聚类，产出无人消费
            "topics",
            "topic_clusters",
            "posts",
            "accounts",
        ))

        if not DATABASE_URL.startswith("sqlite"):
            # Rename tables (idempotent)
            await conn.execute(text("ALTER TABLE IF EXISTS content_topics RENAME TO writing_plans"))
            await conn.execute(text("ALTER TABLE IF EXISTS topic_tags RENAME TO plan_tags"))
            await conn.execute(text("ALTER TABLE IF EXISTS content_topic_tags RENAME TO writing_plan_tags"))
            await conn.execute(text("ALTER TABLE IF EXISTS topic_sources RENAME TO plan_sources"))
            await conn.execute(text("ALTER TABLE IF EXISTS topic_updates RENAME TO plan_updates"))

        await migrate_removed_hot_topic_schema(conn)
        await migrate_removed_publication_schema(conn)
        # Existing databases may contain duplicate keys, so repair them before
        # metadata.create_all attempts to create the unique partial index.
        await migrate_content_job_idempotency_schema(conn)
        await conn.run_sync(Base.metadata.create_all)
        await migrate_content_job_idempotency_schema(conn)
        await migrate_text_video_project_schema(conn)
        await migrate_text_video_speech_asset_schema(conn)
        await _add_columns(conn, "chat_messages", {
            "skill_run": "JSON",
        })
        await _add_columns(conn, "creative_assets", {
            "media_kind": "VARCHAR NOT NULL DEFAULT ''",
            "directory": "VARCHAR NOT NULL DEFAULT ''",
            "last_selected_at": "TIMESTAMP",
        })
        await _add_columns(conn, "creative_asset_directories", {
            "asset_type": "VARCHAR NOT NULL DEFAULT 'article'",
            "parent_id": "INTEGER",
            "system_key": "VARCHAR",
        })
        if not DATABASE_URL.startswith("sqlite"):
            # The first version used a globally unique name. Directories now
            # have independent article/media trees, so the same name is valid
            # once in each tree.
            await conn.execute(text("ALTER TABLE creative_asset_directories DROP CONSTRAINT IF EXISTS creative_asset_directories_name_key"))
            await conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS uq_creative_asset_directories_asset_type_name ON creative_asset_directories (asset_type, name)"))
            await conn.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS "
                "uq_creative_asset_directories_system_key "
                "ON creative_asset_directories (system_key) "
                "WHERE system_key IS NOT NULL"
            ))
        # x_posts column additions (idempotent)
        await _add_columns(conn, "x_posts", {
            "author_avatar": "VARCHAR NOT NULL DEFAULT ''",
            "cover_image": "VARCHAR NOT NULL DEFAULT ''",
        })
        if not DATABASE_URL.startswith("sqlite"):
            # X search-subscription + ref-consumer schema (idempotent, PG only)
            await conn.execute(text("ALTER TABLE x_posts ADD COLUMN IF NOT EXISTS possibly_sensitive BOOLEAN NOT NULL DEFAULT FALSE"))
            await conn.execute(text("ALTER TABLE x_subscriptions ADD COLUMN IF NOT EXISTS kind VARCHAR NOT NULL DEFAULT 'timeline'"))
            await conn.execute(text("ALTER TABLE x_subscriptions ADD COLUMN IF NOT EXISTS raw_query VARCHAR NOT NULL DEFAULT ''"))
            await conn.execute(text("ALTER TABLE x_subscriptions ADD COLUMN IF NOT EXISTS min_faves INTEGER NOT NULL DEFAULT 0"))
            await conn.execute(text("ALTER TABLE x_subscriptions ADD COLUMN IF NOT EXISTS min_retweets INTEGER NOT NULL DEFAULT 0"))
            await conn.execute(text("ALTER TABLE x_subscriptions ADD COLUMN IF NOT EXISTS lang VARCHAR NOT NULL DEFAULT ''"))
            await conn.execute(text("ALTER TABLE x_subscriptions ADD COLUMN IF NOT EXISTS days INTEGER NOT NULL DEFAULT 1"))
            await conn.execute(text("ALTER TABLE x_subscriptions ADD COLUMN IF NOT EXISTS extra_terms VARCHAR NOT NULL DEFAULT ''"))
            await conn.execute(text("ALTER TABLE x_subscriptions ADD COLUMN IF NOT EXISTS sort VARCHAR NOT NULL DEFAULT 'top'"))
            await conn.execute(text("ALTER TABLE x_subscriptions ADD COLUMN IF NOT EXISTS max_results INTEGER NOT NULL DEFAULT 100"))
            await conn.execute(text("ALTER TABLE x_subscriptions ALTER COLUMN url DROP NOT NULL"))
            await conn.execute(text("ALTER TABLE reddit_posts ADD COLUMN IF NOT EXISTS body TEXT NOT NULL DEFAULT ''"))
            await conn.execute(text("ALTER TABLE reddit_posts ADD COLUMN IF NOT EXISTS comments JSON NOT NULL DEFAULT '[]'::json"))
            await conn.execute(text("ALTER TABLE reddit_posts ADD COLUMN IF NOT EXISTS fetch_status VARCHAR NOT NULL DEFAULT 'ok'"))
        # Lightweight in-place migrations for columns added after the original
        # table creation.
        json_object_default = (
            "'{}'"
            if conn.dialect.name == "sqlite"
            else "'{}'::json"
        )
        json_array_default = (
            "'[]'"
            if conn.dialect.name == "sqlite"
            else "'[]'::json"
        )
        await _add_columns(conn, "wechat_articles", {
            "content": "TEXT NOT NULL DEFAULT ''",
        })
        await _add_columns(conn, "publish_accounts", {
            "voice_samples": (
                f"JSON NOT NULL DEFAULT {json_array_default}"
            ),
            "style_rules": (
                f"JSON NOT NULL DEFAULT {json_array_default}"
            ),
            "cover_style": (
                f"JSON NOT NULL DEFAULT {json_object_default}"
            ),
            "daily_quota": (
                f"JSON NOT NULL DEFAULT {json_object_default}"
            ),
        })
        await migrate_x_response_claim_schema(conn)
        await migrate_content_response_schema(conn)
        await retire_x_response_decision_schema(conn)

        if not DATABASE_URL.startswith("sqlite"):
            # Writing plans brief field (added in redesign; idempotent)
            await conn.execute(text(
                "ALTER TABLE writing_plans ADD COLUMN IF NOT EXISTS brief TEXT NOT NULL DEFAULT ''"
            ))
            # Copy description → brief for existing rows that have no brief yet
            await conn.execute(text(
                "UPDATE writing_plans SET brief = description WHERE brief = '' AND description <> ''"
            ))
            # Reset parent_id — tree hierarchy replaced by tag model
            await conn.execute(text(
                "UPDATE writing_plans SET parent_id = NULL WHERE parent_id IS NOT NULL"
            ))

            # Column renames (idempotent via DO blocks)
            await conn.execute(text("""
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='writing_plan_tags' AND column_name='topic_id') THEN
    ALTER TABLE writing_plan_tags RENAME COLUMN topic_id TO plan_id;
  END IF;
END $$
"""))
            await conn.execute(text("""
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='plan_sources' AND column_name='topic_id') THEN
    ALTER TABLE plan_sources RENAME COLUMN topic_id TO plan_id;
  END IF;
END $$
"""))
            await conn.execute(text("""
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='plan_updates' AND column_name='topic_id') THEN
    ALTER TABLE plan_updates RENAME COLUMN topic_id TO plan_id;
  END IF;
END $$
"""))
            await conn.execute(text("""
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='article_drafts' AND column_name='content_topic_id') THEN
    ALTER TABLE article_drafts RENAME COLUMN content_topic_id TO writing_plan_id;
  END IF;
END $$
"""))
            await conn.execute(text("""
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='quotes' AND column_name='content_topic_id') THEN
    ALTER TABLE quotes RENAME COLUMN content_topic_id TO writing_plan_id;
  END IF;
END $$
"""))
        # plan_updates: created by Base.metadata.create_all above (no raw DDL needed)

        await _drop_tables(conn, (
            "ref_seen",
            "ref_collect_rules",
            "ref_materials",
        ))
