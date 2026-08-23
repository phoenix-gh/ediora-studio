import asyncio
import logging
import math
import os
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.orm import DeclarativeBase

_MAX_DATABASE_TIMEOUT_SECONDS = 300.0
_DEFERRED_SESSION_TASKS_KEY = "wms_deferred_session_tasks"
_BACKGROUND_DATABASE_TASKS: set[asyncio.Task] = set()
logger = logging.getLogger(__name__)


def _parse_database_timeout_seconds(value: str) -> float:
    try:
        timeout = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(
            "DATABASE_COMMAND_TIMEOUT_SECONDS must be a finite number "
            "between 0 and 300",
        ) from error
    if (
        not math.isfinite(timeout)
        or timeout <= 0
        or timeout > _MAX_DATABASE_TIMEOUT_SECONDS
    ):
        raise ValueError(
            "DATABASE_COMMAND_TIMEOUT_SECONDS must be a finite number "
            "between 0 and 300",
        )
    return timeout


def _database_engine_kwargs(
    database_url: str,
    command_timeout_seconds: float,
) -> dict:
    if not database_url.startswith("postgresql+asyncpg://"):
        raise ValueError(
            "DATABASE_URL must use PostgreSQL with the asyncpg driver"
        )
    options: dict = {"echo": False, "pool_pre_ping": True}
    options.update(pool_size=10, max_overflow=20)
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
    "DATABASE_URL",
    "postgresql+asyncpg://postgres:123456@127.0.0.1:5432/wemedia",
)
DATABASE_COMMAND_TIMEOUT_SECONDS = _parse_database_timeout_seconds(
    os.getenv("DATABASE_COMMAND_TIMEOUT_SECONDS", "30"),
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
    """Add the delivery-claim column and index."""
    from sqlalchemy import text

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


async def migrate_removed_draft_adaptation_schema(conn) -> None:
    """Delete retired child adaptations and flatten draft ownership."""
    from sqlalchemy import inspect, text

    tables = set(await conn.run_sync(
        lambda sync_connection: inspect(sync_connection).get_table_names()
    ))
    if "article_drafts" in tables:
        columns = {
            column["name"]
            for column in await conn.run_sync(
                lambda sync_connection: inspect(sync_connection)
                .get_columns("article_drafts")
            )
        }
        if "linked_draft_id" in columns:
            child_ids = (
                "SELECT id FROM article_drafts "
                "WHERE linked_draft_id IS NOT NULL"
            )
            if "draft_chat_logs" in tables:
                await conn.execute(text(
                    f"DELETE FROM draft_chat_logs WHERE draft_id IN ({child_ids})"
                ))
            if "content_usage_ledger" in tables:
                await conn.execute(text(
                    "DELETE FROM content_usage_ledger "
                    "WHERE output_kind = 'draft' "
                    f"AND draft_id IN ({child_ids})"
                ))
            await conn.execute(text(
                "DELETE FROM article_drafts WHERE linked_draft_id IS NOT NULL"
            ))
        await conn.execute(text(
            "UPDATE article_drafts SET draft_type = 'x' "
            "WHERE draft_type = 'x_post'"
        ))
        if "linked_draft_id" in columns:
            drop_if_exists = (
                " IF EXISTS" if conn.dialect.name == "postgresql" else ""
            )
            await conn.execute(text(
                "ALTER TABLE article_drafts "
                f"DROP COLUMN{drop_if_exists} linked_draft_id"
            ))

    if "draft_images" not in tables:
        return
    image_columns = {
        column["name"]
        for column in await conn.run_sync(
            lambda sync_connection: inspect(sync_connection)
            .get_columns("draft_images")
        )
    }
    if "root_draft_id" in image_columns and "draft_id" not in image_columns:
        await conn.execute(text(
            "ALTER TABLE draft_images "
            "RENAME COLUMN root_draft_id TO draft_id"
        ))
        if conn.dialect.name == "postgresql":
            await conn.execute(text(
                "ALTER INDEX IF EXISTS ix_draft_images_root_draft_id "
                "RENAME TO ix_draft_images_draft_id"
            ))
        else:
            await conn.execute(text(
                "DROP INDEX IF EXISTS ix_draft_images_root_draft_id"
            ))
            await conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_draft_images_draft_id "
                "ON draft_images (draft_id)"
            ))


async def migrate_topic_source_rule_single_directory(conn) -> None:
    """Keep one active material directory per X subscription.

    Older UI versions appended a rule when the directory selection changed.
    Preserve those rows and their decision history, but retain only the newest
    active rule so future X posts cannot enter a stale directory.
    """
    from sqlalchemy import bindparam, inspect, text

    tables = set(await conn.run_sync(
        lambda sync_connection: inspect(sync_connection).get_table_names()
    ))
    if "topic_source_rules" not in tables:
        return
    rows = (await conn.execute(text(
        "SELECT id, subscription_id FROM topic_source_rules "
        "WHERE enabled = TRUE "
        "ORDER BY subscription_id ASC, updated_at DESC, id DESC"
    ))).mappings().all()
    retained_subscriptions: set[int] = set()
    stale_rule_ids: list[int] = []
    for row in rows:
        subscription_id = row["subscription_id"]
        if subscription_id in retained_subscriptions:
            stale_rule_ids.append(row["id"])
        else:
            retained_subscriptions.add(subscription_id)
    if stale_rule_ids:
        await conn.execute(
            text("UPDATE topic_source_rules SET enabled = FALSE WHERE id IN :ids")
            .bindparams(bindparam("ids", expanding=True)),
            {"ids": stale_rule_ids},
        )


async def migrate_asset_ingestion_schema(conn) -> None:
    """Move subscription rules into folder-owned AI ingestion settings."""
    from datetime import datetime, timezone
    import json
    from sqlalchemy import inspect, text

    tables = set(await conn.run_sync(
        lambda sync_connection: inspect(sync_connection).get_table_names()
    ))
    required = {
        "creative_asset_directories",
        "topic_source_rules",
        "topic_source_decisions",
        "x_subscription_ingestion_directories",
        "asset_ingestion_decisions",
    }
    if not required <= tables:
        return

    now = datetime.now(timezone.utc)
    directory_ids: dict[str, int] = {}
    rule_directory_ids: dict[int, int] = {}
    rule_subscriptions: dict[int, int] = {}
    configured_directory_ids: set[int] = set()

    rows = (await conn.execute(text(
        "SELECT id, subscription_id, directory, keywords, screening_prompt, "
        "enabled, updated_at FROM topic_source_rules "
        "ORDER BY updated_at DESC NULLS LAST, id DESC"
    ))).mappings().all()

    for row in rows:
        name = str(row["directory"] or "").strip()
        if not name:
            continue
        folder_id = directory_ids.get(name)
        if folder_id is None:
            existing = (await conn.execute(text(
                "SELECT id, ai_ingestion_enabled, ai_ingestion_prompt "
                "FROM creative_asset_directories "
                "WHERE asset_type = 'article' AND name = :name LIMIT 1"
            ), {"name": name})).mappings().first()
            if existing is None:
                inserted = await conn.execute(text(
                    "INSERT INTO creative_asset_directories "
                    "(name, asset_type, ai_ingestion_enabled, "
                    "ai_ingestion_keywords, ai_ingestion_prompt, created_at) "
                    "VALUES (:name, 'article', FALSE, '[]', '', :created_at) "
                    "RETURNING id"
                ), {"name": name, "created_at": now})
                folder_id = inserted.scalar_one()
                existing = {
                    "id": folder_id,
                    "ai_ingestion_enabled": False,
                    "ai_ingestion_prompt": "",
                }
            else:
                folder_id = existing["id"]
            directory_ids[name] = folder_id
            if existing["ai_ingestion_enabled"] and str(
                existing["ai_ingestion_prompt"] or ""
            ).strip():
                configured_directory_ids.add(folder_id)

        rule_id = row["id"]
        rule_directory_ids[rule_id] = folder_id
        rule_subscriptions[rule_id] = row["subscription_id"]

        if row["enabled"] and folder_id not in configured_directory_ids:
            keywords = [
                str(keyword).strip()
                for keyword in (row["keywords"] or [])
                if str(keyword).strip()
            ]
            prompt = str(row["screening_prompt"] or "").strip()
            if not prompt:
                prompt = f"只保留与“{name}”主题直接相关、适合后续创作的内容。"
            await conn.execute(text(
                "UPDATE creative_asset_directories SET "
                "ai_ingestion_enabled = TRUE, "
                "ai_ingestion_keywords = :keywords, "
                "ai_ingestion_prompt = :prompt WHERE id = :directory_id"
            ), {
                "directory_id": folder_id,
                "keywords": json.dumps(keywords, ensure_ascii=False),
                "prompt": prompt,
            })
            configured_directory_ids.add(folder_id)

        if row["enabled"] and folder_id in configured_directory_ids:
            await conn.execute(text(
                "INSERT INTO x_subscription_ingestion_directories "
                "(subscription_id, directory_id, created_at) "
                "VALUES (:subscription_id, :directory_id, :created_at) "
                "ON CONFLICT (subscription_id, directory_id) DO NOTHING"
            ), {
                "subscription_id": row["subscription_id"],
                "directory_id": folder_id,
                "created_at": now,
            })

    old_decisions = (await conn.execute(text(
        "SELECT rule_id, tweet_id, accepted, created_at "
        "FROM topic_source_decisions"
    ))).mappings().all()
    for decision in old_decisions:
        rule_id = decision["rule_id"]
        directory_id = rule_directory_ids.get(rule_id)
        subscription_id = rule_subscriptions.get(rule_id)
        if directory_id is None or subscription_id is None:
            continue
        await conn.execute(text(
            "INSERT INTO asset_ingestion_decisions "
            "(subscription_id, tweet_id, directory_id, created_at) "
            "VALUES (:subscription_id, :tweet_id, :directory_id, :created_at) "
            "ON CONFLICT (subscription_id, tweet_id) DO NOTHING"
        ), {
            "subscription_id": subscription_id,
            "tweet_id": decision["tweet_id"],
            "directory_id": directory_id if decision["accepted"] else None,
            "created_at": decision["created_at"] or now,
        })


async def migrate_x_subscription_collection_schema(conn) -> None:
    """Add per-subscription collection intervals and preserve the old default."""
    from sqlalchemy import inspect, text

    tables = set(await conn.run_sync(
        lambda sync_connection: inspect(sync_connection).get_table_names()
    ))
    if "x_subscriptions" not in tables:
        return
    columns = {
        column["name"]
        for column in await conn.run_sync(
            lambda sync_connection: inspect(sync_connection).get_columns("x_subscriptions")
        )
    }
    if "collect_interval_minutes" in columns:
        return
    await _add_columns(conn, "x_subscriptions", {
        "collect_interval_minutes": "INTEGER NOT NULL DEFAULT 15",
    })
    if "app_settings" not in tables:
        return
    raw_value = (await conn.execute(text(
        "SELECT value FROM app_settings WHERE key = 'x_collect_interval_minutes'"
    ))).scalar_one_or_none()
    try:
        interval = max(5, min(1440, int(raw_value)))
    except (TypeError, ValueError):
        return
    await conn.execute(text(
        "UPDATE x_subscriptions SET collect_interval_minutes = :interval"
    ), {"interval": interval})


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


async def migrate_skill_pipeline_schema(conn, *, assert_complete: bool = True) -> None:
    """Bring the additive Skill-pipeline schema to the current version."""
    from sqlalchemy import inspect, text

    table_names = set(await conn.run_sync(
        lambda sync_connection: inspect(sync_connection).get_table_names()
    ))
    target_tables = {"content_jobs", "agent_executions"}
    if not table_names.intersection(target_tables):
        if assert_complete:
            raise RuntimeError("skill pipeline schema is incomplete: target tables are absent")
        return

    if "content_jobs" in table_names:
        await _add_columns(conn, "content_jobs", {
            "plan_version": "INTEGER NOT NULL DEFAULT 1",
            "run_epoch": "INTEGER NOT NULL DEFAULT 1",
        })
        columns = await conn.run_sync(
            lambda sync_connection: {
                column["name"]
                for column in inspect(sync_connection).get_columns("content_jobs")
            }
        )
        if "updated_at" not in columns:
            await conn.execute(text(
                'ALTER TABLE "content_jobs" ADD COLUMN "updated_at" TIMESTAMP WITH TIME ZONE'
            ))
        if "created_at" in columns:
            await conn.execute(text(
                'UPDATE "content_jobs" SET "updated_at" = "created_at" '
                'WHERE "updated_at" IS NULL'
            ))
        else:
            await conn.execute(text(
                'UPDATE "content_jobs" SET "updated_at" = CURRENT_TIMESTAMP '
                'WHERE "updated_at" IS NULL'
            ))
        await conn.execute(text(
            'ALTER TABLE "content_jobs" ALTER COLUMN "updated_at" '
            'SET DEFAULT CURRENT_TIMESTAMP'
        ))
        await conn.execute(text(
            'ALTER TABLE "content_jobs" ALTER COLUMN "updated_at" SET NOT NULL'
        ))

    if "agent_executions" in table_names:
        await _add_columns(conn, "agent_executions", {
            "step_id": "INTEGER",
            "attempt": "INTEGER NOT NULL DEFAULT 1",
        })

        def inspect_agent_schema(sync_connection):
            inspector = inspect(sync_connection)
            return (
                inspector.get_unique_constraints("agent_executions"),
                inspector.get_indexes("agent_executions"),
                inspector.get_foreign_keys("agent_executions"),
            )

        unique_constraints, indexes, foreign_keys = await conn.run_sync(inspect_agent_schema)
        quote = conn.dialect.identifier_preparer.quote
        target_index_names = {
            "uq_agent_executions_legacy_job",
            "uq_agent_executions_stage_attempt",
        }
        dropped_constraint_names: set[str] = set()
        for constraint in unique_constraints:
            if (
                constraint.get("name")
                and constraint.get("column_names") == ["job_id"]
                and constraint["name"] not in target_index_names
            ):
                dropped_constraint_names.add(constraint["name"])
                await conn.execute(text(
                    f'ALTER TABLE "agent_executions" DROP CONSTRAINT {quote(constraint["name"])}'
                ))
        for index in indexes:
            if (
                index.get("name")
                and index.get("unique")
                and index.get("column_names") == ["job_id"]
                and index["name"] not in target_index_names
                and index["name"] not in dropped_constraint_names
            ):
                await conn.execute(text(f'DROP INDEX {quote(index["name"])}'))

        if "content_job_steps" in table_names and not any(
            foreign_key.get("constrained_columns") == ["step_id"]
            and foreign_key.get("referred_table") == "content_job_steps"
            for foreign_key in foreign_keys
        ):
            await conn.execute(text(
                'ALTER TABLE "agent_executions" '
                'ADD CONSTRAINT "fk_agent_executions_step_id" '
                'FOREIGN KEY ("step_id") REFERENCES "content_job_steps" ("id")'
            ))

        await conn.execute(text(
            'CREATE UNIQUE INDEX IF NOT EXISTS "uq_agent_executions_legacy_job" '
            'ON "agent_executions" ("job_id") WHERE "step_id" IS NULL'
        ))
        await conn.execute(text(
            'CREATE UNIQUE INDEX IF NOT EXISTS "uq_agent_executions_stage_attempt" '
            'ON "agent_executions" ("job_id", "step_id", "attempt") '
            'WHERE "step_id" IS NOT NULL'
        ))

    if not assert_complete:
        return

    final_tables = set(await conn.run_sync(
        lambda sync_connection: inspect(sync_connection).get_table_names()
    ))
    if "execution_artifacts" not in final_tables:
        raise RuntimeError(
            "skill pipeline schema is incomplete: execution_artifacts is absent"
        )
    final_content_columns = {
        column["name"]
        for column in await conn.run_sync(
            lambda sync_connection: inspect(sync_connection).get_columns("content_jobs")
        )
    }
    final_execution_columns = {
        column["name"]
        for column in await conn.run_sync(
            lambda sync_connection: inspect(sync_connection).get_columns("agent_executions")
        )
    }
    if not {"plan_version", "run_epoch", "updated_at"} <= final_content_columns:
        raise RuntimeError("skill pipeline schema is incomplete: content_jobs columns are absent")
    if not {"step_id", "attempt"} <= final_execution_columns:
        raise RuntimeError("skill pipeline schema is incomplete: Agent execution columns are absent")
    final_indexes = {
        index["name"]
        for index in await conn.run_sync(
            lambda sync_connection: inspect(sync_connection).get_indexes("agent_executions")
        )
    }
    if not target_index_names <= final_indexes:
        raise RuntimeError("skill pipeline schema is incomplete: Agent execution indexes are absent")


async def migrate_digital_human_comfyui_schema(conn) -> None:
    """Add ComfyUI role fields and allow roles without a cloned voice sample."""
    from sqlalchemy import text

    await _add_columns(conn, "digital_humans", {
        "provider": "VARCHAR(20) NOT NULL DEFAULT 'heygen'",
        "look_asset_id": "INTEGER",
        "look_prompt": "TEXT NOT NULL DEFAULT ''",
    })
    await conn.execute(text(
        "UPDATE digital_humans SET provider = 'heygen' "
        "WHERE provider IS NULL OR provider = ''"
    ))
    await conn.execute(text(
        "ALTER TABLE digital_humans "
        "ALTER COLUMN voice_sample_asset_id DROP NOT NULL"
    ))
    await _add_columns(conn, "talking_video_projects", {
        "look_asset_id": "INTEGER",
        "shots": "JSON NOT NULL DEFAULT '[]'::json",
    })
    await _add_columns(conn, "talking_video_renders", {
        "shots_snapshot": "JSON NOT NULL DEFAULT '[]'::json",
    })


async def migrate_talking_video_delivery_schema(conn) -> None:
    await _add_columns(conn, "talking_video_projects", {
        "delivery": "TEXT NOT NULL DEFAULT ''",
        "presence": "TEXT NOT NULL DEFAULT ''",
    })


async def migrate_text_video_speech_asset_schema(conn) -> None:
    """Add sample-accurate metadata to speech assets created before this release."""
    await _add_columns(conn, "text_video_speech_assets", {
        "sample_count": "INTEGER NOT NULL DEFAULT 0",
        "sample_rate": "INTEGER NOT NULL DEFAULT 44100",
    })


async def _add_columns(conn, table_name: str, definitions: dict[str, str]) -> None:
    """Add missing PostgreSQL columns without rebuilding tables."""
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


async def migrate_prompt_asset_schema(conn) -> None:
    """Add prompt metadata and the prompt-to-media generation history table."""
    await _add_columns(conn, "creative_assets", {
        "prompt_kind": "VARCHAR NOT NULL DEFAULT ''",
    })

    from models import PromptGeneration

    await conn.run_sync(
        lambda sync_connection: PromptGeneration.__table__.create(
            sync_connection,
            checkfirst=True,
        )
    )


async def migrate_daily_creation_prompt_schema(conn) -> None:
    """Add canonical prompts and safely backfill legacy creation rules."""
    from sqlalchemy import text

    from daily_creation_prompt import build_legacy_creation_prompt

    await _add_columns(conn, "daily_creation_rules", {
        "prompt": "TEXT NOT NULL DEFAULT ''",
    })
    rows = (
        await conn.execute(text(
            "SELECT id, asset_type, directory, directories, target_count, "
            "lookback_days, account_id, instructions, skill_mode, skill_name "
            "FROM daily_creation_rules WHERE trim(prompt) = ''"
        ))
    ).mappings().all()
    for row in rows:
        try:
            prompt = build_legacy_creation_prompt(row)
        except (TypeError, ValueError) as error:
            await conn.execute(text(
                "UPDATE daily_creation_rules SET enabled = FALSE, prompt = '' "
                "WHERE id = :rule_id"
            ), {"rule_id": row["id"]})
            logger.warning(
                "Disabled daily creation rule %s during prompt backfill (%s)",
                row["id"], type(error).__name__,
            )
            continue
        await conn.execute(text(
            "UPDATE daily_creation_rules SET prompt = :prompt WHERE id = :rule_id"
        ), {"prompt": prompt, "rule_id": row["id"]})


async def _drop_tables(conn, table_names: tuple[str, ...]) -> None:
    """Drop retired tables with CASCADE only where PostgreSQL supports it."""
    from sqlalchemy import text

    cascade = " CASCADE" if conn.dialect.name == "postgresql" else ""
    for table_name in table_names:
        await conn.execute(text(
            f'DROP TABLE IF EXISTS "{table_name}"{cascade}'
        ))


async def _drop_columns(conn, table_name: str, column_names: tuple[str, ...]) -> None:
    """Drop retired columns only when an existing table still has them."""
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
    suffix = " IF EXISTS" if conn.dialect.name == "postgresql" else ""
    for column_name in column_names:
        if column_name in columns:
            await conn.execute(text(
                f'ALTER TABLE "{table_name}" DROP COLUMN{suffix} "{column_name}"'
            ))


async def migrate_text_video_project_schema(conn) -> None:
    """Keep early text-video project tables compatible with current schema."""
    from copy import deepcopy
    import json

    from sqlalchemy import JSON, bindparam, inspect, text

    json_object_default = "'{}'::json"
    json_array_default = "'[]'::json"
    timestamp_definition = "TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP"
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

    json_default = "'[]'::json"
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
        "transcript_zh_source": "VARCHAR NOT NULL DEFAULT ''",
        "transcript_zh_language": "VARCHAR NOT NULL DEFAULT ''",
        "transcript_zh_text": "TEXT NOT NULL DEFAULT ''",
        "transcript_zh_segments": f"JSON NOT NULL DEFAULT {json_default}",
        "transcript_zh_content_hash": "VARCHAR NOT NULL DEFAULT ''",
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
                subscription_id=decision["subscription_id"],
                workflow_status="ready",
                decision_status={
                    "used": "worth_writing",
                    "ignored": "not_processed",
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


async def migrate_intelligence_station_schema(conn) -> None:
    """Add Intelligence Station fields and map old unified dispositions."""
    from sqlalchemy import text

    json_default = "'[]'::json"
    await _add_columns(conn, "content_response_items", {
        "content_types": f"JSON NOT NULL DEFAULT {json_default}",
        "destination_type": "VARCHAR",
        "destination_id": "INTEGER",
        "subscription_id": "INTEGER",
    })
    await _add_columns(conn, "content_analysis_runs", {
        "suggested_title": "TEXT NOT NULL DEFAULT ''",
        "suggested_angle": "TEXT NOT NULL DEFAULT ''",
        "target_reader": "TEXT NOT NULL DEFAULT ''",
        "suggested_structure": f"JSON NOT NULL DEFAULT {json_default}",
        "recommended_content_types": f"JSON NOT NULL DEFAULT {json_default}",
        "recommended_disposition": "VARCHAR NOT NULL DEFAULT 'pending'",
    })
    await conn.execute(text(
        "UPDATE content_response_items "
        "SET decision_status = CASE decision_status "
        "WHEN 'adopted' THEN 'worth_writing' "
        "WHEN 'rejected' THEN 'not_processed' "
        "WHEN 'later' THEN 'pending' "
        "ELSE decision_status END "
        "WHERE decision_status IN ('adopted', 'rejected', 'later')"
    ))


async def migrate_intelligence_subscription_schema(conn) -> None:
    """Replace the retired realtime-response subscription flags."""
    from sqlalchemy import inspect, text

    await _add_columns(conn, "x_subscriptions", {
        "intelligence_enabled": "BOOLEAN NOT NULL DEFAULT FALSE",
        "intelligence_enabled_at": "TIMESTAMP",
    })
    await _drop_columns(
        conn,
        "x_subscriptions",
        ("notify_new_posts", "notify_enabled_at"),
    )
    await _drop_columns(
        conn,
        "x_posts",
        ("x_reply_score", "x_reply_draft", "x_reply_notified_at"),
    )
    tables = set(await conn.run_sync(
        lambda sync_connection: inspect(sync_connection).get_table_names()
    ))
    if "app_settings" in tables:
        await conn.execute(text(
            "DELETE FROM app_settings "
            "WHERE key IN ('x_notify_enabled', 'x_response_account_id')"
        ))


async def migrate_daily_creation_output_batch_schema(conn) -> None:
    """Remove the retired daily-plan linkage from creation output batches."""
    await _drop_columns(
        conn,
        "daily_creation_output_batches",
        ("plan_item_ids",),
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
            "used": "worth_writing",
            "ignored": "not_processed",
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

        # Rename tables (idempotent)
        await conn.execute(text("ALTER TABLE IF EXISTS content_topics RENAME TO writing_plans"))
        await conn.execute(text("ALTER TABLE IF EXISTS topic_tags RENAME TO plan_tags"))
        await conn.execute(text("ALTER TABLE IF EXISTS content_topic_tags RENAME TO writing_plan_tags"))
        await conn.execute(text("ALTER TABLE IF EXISTS topic_sources RENAME TO plan_sources"))
        await conn.execute(text("ALTER TABLE IF EXISTS topic_updates RENAME TO plan_updates"))

        await migrate_removed_hot_topic_schema(conn)
        await migrate_removed_publication_schema(conn)
        await migrate_removed_draft_adaptation_schema(conn)
        # Existing databases may contain duplicate keys, so repair them before
        # metadata.create_all attempts to create the unique partial index.
        await migrate_content_job_idempotency_schema(conn)
        await migrate_skill_pipeline_schema(conn, assert_complete=False)
        await _drop_tables(conn, ("daily_plan_items", "daily_plans"))
        await conn.run_sync(Base.metadata.create_all)
        await migrate_skill_pipeline_schema(conn, assert_complete=True)
        await _drop_columns(conn, "publish_accounts", ("daily_quota",))
        await migrate_topic_source_rule_single_directory(conn)
        await migrate_x_subscription_collection_schema(conn)
        await _add_columns(conn, "topic_source_rules", {
            "screening_prompt": "TEXT NOT NULL DEFAULT ''",
        })
        await migrate_content_job_idempotency_schema(conn)
        await migrate_text_video_project_schema(conn)
        await migrate_text_video_speech_asset_schema(conn)
        await migrate_digital_human_comfyui_schema(conn)
        await migrate_talking_video_delivery_schema(conn)
        await _add_columns(conn, "chat_messages", {
            "skill_run": "JSON",
            "capability_snapshot": "JSON",
        })
        await _add_columns(conn, "agent_executions", {
            "pinned_capability_snapshot": "JSON",
        })
        await _add_columns(conn, "creative_assets", {
            "media_kind": "VARCHAR NOT NULL DEFAULT ''",
            "directory": "VARCHAR NOT NULL DEFAULT ''",
            "last_selected_at": "TIMESTAMP",
        })
        await migrate_prompt_asset_schema(conn)
        await _add_columns(conn, "creative_asset_directories", {
            "asset_type": "VARCHAR NOT NULL DEFAULT 'article'",
            "parent_id": "INTEGER",
            "system_key": "VARCHAR",
            "ai_ingestion_enabled": "BOOLEAN NOT NULL DEFAULT FALSE",
            "ai_ingestion_keywords": "JSON NOT NULL DEFAULT '[]'",
            "ai_ingestion_prompt": "TEXT NOT NULL DEFAULT ''",
        })
        await migrate_asset_ingestion_schema(conn)
        await _add_columns(conn, "x_credential_accounts", {
            "session_ciphertext": "TEXT NOT NULL DEFAULT ''",
        })
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
            "media": "JSON NOT NULL DEFAULT '[]'::json",
        })
        # X search-subscription + ref-consumer schema (idempotent)
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
        await conn.execute(text("ALTER TABLE x_subscriptions ADD COLUMN IF NOT EXISTS llm_adapter_id VARCHAR"))
        await conn.execute(text("ALTER TABLE x_subscriptions ALTER COLUMN url DROP NOT NULL"))
        await conn.execute(text("ALTER TABLE reddit_posts ADD COLUMN IF NOT EXISTS body TEXT NOT NULL DEFAULT ''"))
        await conn.execute(text("ALTER TABLE reddit_posts ADD COLUMN IF NOT EXISTS comments JSON NOT NULL DEFAULT '[]'::json"))
        await conn.execute(text("ALTER TABLE reddit_posts ADD COLUMN IF NOT EXISTS fetch_status VARCHAR NOT NULL DEFAULT 'ok'"))
        # Lightweight in-place migrations for columns added after the original
        # table creation.
        json_object_default = "'{}'::json"
        json_array_default = "'[]'::json"
        await _add_columns(conn, "daily_creation_rules", {
            "directories": f"JSON NOT NULL DEFAULT {json_array_default}",
            "skill_mode": "VARCHAR NOT NULL DEFAULT 'auto'",
            "skill_name": "VARCHAR",
        })
        await conn.execute(text(
            "UPDATE daily_creation_rules SET delivery_mode = 'drafts' "
            "WHERE delivery_mode = 'plan_items'"
        ))
        await conn.execute(text(
            "UPDATE daily_creation_rules "
            "SET directories = json_build_array(directory) "
            "WHERE (directories IS NULL OR json_array_length(directories) = 0) "
            "AND directory <> ''"
        ))
        await migrate_daily_creation_prompt_schema(conn)
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
        })
        await migrate_x_response_claim_schema(conn)
        await migrate_intelligence_station_schema(conn)
        await migrate_content_response_schema(conn)
        await migrate_intelligence_subscription_schema(conn)
        await migrate_daily_creation_output_batch_schema(conn)
        await retire_x_response_decision_schema(conn)

        if DATABASE_URL.startswith("postgresql+asyncpg://"):
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
