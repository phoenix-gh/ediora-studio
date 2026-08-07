"""Shared pytest fixtures for isolated PostgreSQL-backed tests."""

import asyncio
import os
import uuid

import pytest
from sqlalchemy.engine import make_url
from sqlalchemy.ext import asyncio as sqlalchemy_asyncio
from sqlalchemy.pool import NullPool

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
    original_create_async_engine = sqlalchemy_asyncio.create_async_engine

    def create_test_async_engine(url, *args, **kwargs):
        database_name = make_url(url).database or ""
        if database_name.startswith("wemedia_test_"):
            kwargs.setdefault("poolclass", NullPool)
            kwargs.pop("pool_size", None)
            kwargs.pop("max_overflow", None)
        return original_create_async_engine(url, *args, **kwargs)

    monkeypatch.setattr(
        sqlalchemy_asyncio,
        "create_async_engine",
        create_test_async_engine,
    )
    yield postgres_database_url
