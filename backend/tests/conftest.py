"""Shared pytest fixtures for isolated PostgreSQL-backed tests."""

import asyncio
import os
import uuid

import pytest

from tests.postgres_test_db import (
    create_test_database,
    drop_test_database,
    replace_database_name,
)


DEFAULT_TEST_DATABASE_ADMIN_URL = (
    "postgresql+asyncpg://wemedia:wemedia@127.0.0.1:55432/postgres"
)


@pytest.fixture
def postgres_database_url():
    admin_url = os.getenv(
        "WMS_TEST_DATABASE_ADMIN_URL",
        DEFAULT_TEST_DATABASE_ADMIN_URL,
    )
    database_name = f"wemedia_test_{uuid.uuid4().hex[:12]}"
    asyncio.run(create_test_database(admin_url, database_name))
    try:
        yield replace_database_name(admin_url, database_name)
    finally:
        asyncio.run(
            drop_test_database(
                admin_url,
                database_name,
                missing_ok=True,
            )
        )


@pytest.fixture
def postgres_env(monkeypatch, postgres_database_url):
    monkeypatch.setenv("WMS_DATABASE_URL", postgres_database_url)
    monkeypatch.setenv("WMS_DISABLE_SCHEDULER", "1")
    yield postgres_database_url
