import asyncio
import sys


def test_topic_source_rule_migration_disables_older_directories(
    monkeypatch,
    postgres_env,
):
    for module in list(sys.modules):
        if module.startswith(("database", "models")):
            sys.modules.pop(module, None)

    from database import Base, engine, migrate_topic_source_rule_single_directory
    from models import TopicSourceRule

    async def run():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
            await connection.execute(TopicSourceRule.__table__.insert(), [
                {
                    "subscription_id": 7,
                    "directory": "实用工具",
                    "keywords": [],
                    "enabled": True,
                },
                {
                    "subscription_id": 7,
                    "directory": "搞钱副业",
                    "keywords": [],
                    "enabled": True,
                },
            ])
            await migrate_topic_source_rule_single_directory(connection)
            rules = (await connection.execute(
                TopicSourceRule.__table__.select()
                .order_by(TopicSourceRule.id)
            )).mappings().all()
            return rules

    rules = asyncio.new_event_loop().run_until_complete(run())

    assert [rule["enabled"] for rule in rules] == [False, True]
