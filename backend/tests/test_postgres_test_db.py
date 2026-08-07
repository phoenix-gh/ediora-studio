import asyncio
import os
import uuid

import asyncpg
import pytest
from sqlalchemy.engine import make_url

from tests.postgres_test_db import (
    create_test_database,
    drop_test_database,
    replace_database_name,
    validate_test_database_name,
)


@pytest.mark.parametrize(
    "name",
    [
        "wemedia",
        "postgres",
        "wemedia_test_",
        "wemedia_test_deadbeef;drop database wemedia",
        "other_test_deadbeef0000",
    ],
)
def test_cleanup_rejects_every_non_generated_database_name(name):
    with pytest.raises(ValueError, match="unsafe PostgreSQL test database"):
        validate_test_database_name(name)


def test_cleanup_accepts_generated_database_name():
    assert validate_test_database_name("wemedia_test_012345abcdef") == (
        "wemedia_test_012345abcdef"
    )


def test_database_url_replacement_preserves_driver_and_credentials():
    actual = replace_database_name(
        "postgresql+asyncpg://wemedia:secret@127.0.0.1:55432/postgres",
        "wemedia_test_012345abcdef",
    )
    assert actual == (
        "postgresql+asyncpg://wemedia:secret@127.0.0.1:55432/"
        "wemedia_test_012345abcdef"
    )


def _asyncpg_dsn(url: str) -> str:
    return make_url(url).set(drivername="postgresql").render_as_string(
        hide_password=False,
    )


def test_create_and_drop_real_postgresql_database():
    admin_url = (
        "postgresql+asyncpg://wemedia:wemedia@127.0.0.1:55432/postgres"
    )
    name = f"wemedia_test_{uuid.uuid4().hex[:12]}"
    test_url = replace_database_name(admin_url, name)

    async def scenario():
        await drop_test_database(admin_url, name, missing_ok=True)
        await create_test_database(admin_url, name)
        connection = await asyncpg.connect(_asyncpg_dsn(test_url))
        try:
            assert await connection.fetchval("select current_database()") == name
        finally:
            await connection.close()
        await drop_test_database(admin_url, name)
        admin = await asyncpg.connect(_asyncpg_dsn(admin_url))
        try:
            assert not await admin.fetchval(
                "select exists(select 1 from pg_database where datname=$1)",
                name,
            )
        finally:
            await admin.close()

    asyncio.run(scenario())


def test_postgres_database_fixture_targets_generated_database(
    postgres_database_url,
):
    parsed = make_url(postgres_database_url)
    assert parsed.drivername == "postgresql+asyncpg"
    assert parsed.database is not None
    validate_test_database_name(parsed.database)

    async def current_database():
        connection = await asyncpg.connect(_asyncpg_dsn(postgres_database_url))
        try:
            return await connection.fetchval("select current_database()")
        finally:
            await connection.close()

    assert asyncio.run(current_database()) == parsed.database


def test_postgres_env_points_application_at_isolated_database(postgres_env):
    assert os.environ["WMS_DATABASE_URL"] == postgres_env
    assert make_url(postgres_env).database != "wemedia"
    assert os.environ["WMS_DISABLE_SCHEDULER"] == "1"
