import asyncio
import sys
from datetime import datetime, timedelta, timezone


def _reload_database_modules():
    for module_name in list(sys.modules):
        if module_name.startswith(("database", "models")):
            sys.modules.pop(module_name, None)


def test_asset_ingestion_migration_maps_latest_folder_rule_and_old_decisions(
    postgres_env,
):
    _reload_database_modules()

    from database import Base, engine, migrate_asset_ingestion_schema
    from models import (
        AssetIngestionDecision,
        CreativeAssetDirectory,
        TopicSourceDecision,
        TopicSourceRule,
        XSubscriptionIngestionDirectory,
    )

    async def run():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
            directory = CreativeAssetDirectory(name="AI 工具", asset_type="article")
            await connection.execute(CreativeAssetDirectory.__table__.insert().values(
                name=directory.name,
                asset_type=directory.asset_type,
            ))
            old_time = datetime.now(timezone.utc) - timedelta(days=1)
            new_time = datetime.now(timezone.utc)
            old_rule = await connection.execute(
                TopicSourceRule.__table__.insert()
                .values(
                    subscription_id=7,
                    directory="AI 工具",
                    keywords=["AI"],
                    screening_prompt="旧提示词",
                    enabled=True,
                    updated_at=old_time,
                )
                .returning(TopicSourceRule.id)
            )
            old_rule_id = old_rule.scalar_one()
            new_rule = await connection.execute(
                TopicSourceRule.__table__.insert()
                .values(
                    subscription_id=8,
                    directory="AI 工具",
                    keywords=["工具"],
                    screening_prompt="最新提示词",
                    enabled=True,
                    updated_at=new_time,
                )
                .returning(TopicSourceRule.id)
            )
            new_rule_id = new_rule.scalar_one()
            await connection.execute(TopicSourceDecision.__table__.insert().values(
                rule_id=old_rule_id,
                tweet_id="old-tweet",
                accepted=True,
            ))

            await migrate_asset_ingestion_schema(connection)
            await migrate_asset_ingestion_schema(connection)

            folders = (await connection.execute(
                CreativeAssetDirectory.__table__.select()
                .where(CreativeAssetDirectory.name == "AI 工具")
            )).mappings().all()
            associations = (await connection.execute(
                XSubscriptionIngestionDirectory.__table__.select()
                .order_by(XSubscriptionIngestionDirectory.subscription_id)
            )).mappings().all()
            decisions = (await connection.execute(
                AssetIngestionDecision.__table__.select()
            )).mappings().all()
            return folders, associations, decisions, new_rule_id

    folders, associations, decisions, new_rule_id = asyncio.run(run())

    assert len(folders) == 1
    assert folders[0]["ai_ingestion_enabled"] is True
    assert folders[0]["ai_ingestion_keywords"] == ["工具"]
    assert folders[0]["ai_ingestion_prompt"] == "最新提示词"
    assert [row["subscription_id"] for row in associations] == [7, 8]
    assert len(decisions) == 1
    assert decisions[0]["tweet_id"] == "old-tweet"
    assert decisions[0]["directory_id"] == folders[0]["id"]
    assert new_rule_id > 0
